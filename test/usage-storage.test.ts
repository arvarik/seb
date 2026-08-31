import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { SebDatabase } from '../src/data/sqlite-store.js';
import { usageQuery, usageWindow } from '../src/usage/analytics.js';
import {
  MAX_USAGE_DURATION_MS,
  MAX_USAGE_TOKEN_COUNT,
  type UsageToolCallWrite,
} from '../src/usage/types.js';

const databases: SebDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('usage storage', () => {
  it('migrates a version 4 database and preserves existing data', () => {
    const file = databaseFile('seb-usage-v4-');
    const initial = new SebDatabase(file);
    initial.putCache({
      cachedAt: '2026-08-01T00:00:00.000Z',
      key: 'migration',
      namespace: 'test',
      schemaVersion: 'v1',
      staleIfErrorMs: 1_000,
      ttlMs: 1_000,
      value: { preserved: true },
    });
    initial.close();

    const legacy = new Database(file);
    legacy.exec(`
      DROP TABLE usage_tool_calls;
      DROP TABLE usage_steps;
      DROP TABLE usage_runs;
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const database = track(new SebDatabase(file));

    expect(database.status()).toMatchObject({
      schemaVersion: 6,
      usageRuns: 0,
      usageSteps: 0,
      usageToolCalls: 0,
    });
    expect(database.getCache('test', 'migration')).toMatchObject({
      value: { preserved: true },
    });
  });

  it('migrates the earlier version 5 usage layout without losing rows', () => {
    const file = databaseFile('seb-usage-v5-layout-');
    const initial = new SebDatabase(file);
    initial.close();
    const legacy = new Database(file);
    legacy.exec(`
      DROP TABLE usage_tool_calls;
      DROP TABLE usage_steps;
      DROP TABLE usage_runs;
      CREATE TABLE usage_runs (
        call_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        surface TEXT NOT NULL,
        agent_kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL,
        final_finish_reason TEXT,
        error_kind TEXT
      );
      CREATE TABLE usage_steps (
        call_id TEXT NOT NULL,
        step_number INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        finish_reason TEXT,
        raw_finish_reason TEXT,
        input_tokens INTEGER,
        no_cache_input_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cache_write_input_tokens INTEGER,
        output_tokens INTEGER,
        text_tokens INTEGER,
        reasoning_tokens INTEGER,
        total_tokens INTEGER,
        provider_total_tokens INTEGER,
        tool_use_tokens INTEGER,
        response_time_ms REAL,
        time_to_first_output_ms REAL,
        step_time_ms REAL,
        service_tier TEXT,
        grounding_counts_json TEXT,
        PRIMARY KEY (call_id, step_number),
        FOREIGN KEY (call_id) REFERENCES usage_runs(call_id) ON DELETE CASCADE
      );
      CREATE TABLE usage_tool_calls (
        call_id TEXT NOT NULL,
        step_number INTEGER NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        execution_location TEXT NOT NULL,
        outcome TEXT NOT NULL,
        execution_ms REAL,
        dynamic INTEGER,
        PRIMARY KEY (call_id, step_number, tool_call_id),
        FOREIGN KEY (call_id, step_number)
          REFERENCES usage_steps(call_id, step_number) ON DELETE CASCADE
      );
      INSERT INTO usage_runs VALUES (
        'legacy-call', 'legacy-session', 'cli', 'research',
        '2026-08-31T10:00:00.000Z', '2026-08-31T10:00:01.000Z',
        'completed', 'stop', NULL
      );
      INSERT INTO usage_steps (
        call_id, step_number, provider, model_id, total_tokens
      ) VALUES ('legacy-call', 0, 'google', 'gemini-3-flash', 42);
      INSERT INTO usage_tool_calls VALUES (
        'legacy-call', 0, 'legacy-tool', 'google_search', 'provider',
        'returned', 12.5, 0
      );
      PRAGMA user_version = 5;
    `);
    legacy.close();

    const database = track(new SebDatabase(file));
    expect(database.status()).toMatchObject({
      schemaVersion: 6,
      usageRuns: 1,
      usageSteps: 1,
      usageToolCalls: 1,
    });
    expect(database.readUsageDataset()).toMatchObject({
      runs: [{ callId: 'legacy-call', status: 'completed' }],
      steps: [{ callId: 'legacy-call', totalTokens: 42 }],
      toolCalls: [{ toolCallId: 'legacy-tool', outcome: 'returned' }],
    });
    const inspected = new Database(file, { readonly: true });
    const strict = inspected.prepare(`
      SELECT name, strict FROM pragma_table_list
      WHERE name IN ('usage_runs', 'usage_steps', 'usage_tool_calls')
      ORDER BY name
    `).all();
    inspected.close();
    expect(strict).toEqual([
      { name: 'usage_runs', strict: 1 },
      { name: 'usage_steps', strict: 1 },
      { name: 'usage_tool_calls', strict: 1 },
    ]);
  });

  it('rolls back a migration when a conflicting table exists', () => {
    const file = databaseFile('seb-usage-conflict-');
    const initial = new SebDatabase(file);
    initial.close();
    const legacy = new Database(file);
    legacy.exec(`
      DROP TABLE usage_tool_calls;
      DROP TABLE usage_steps;
      DROP TABLE usage_runs;
      CREATE TABLE usage_runs (wrong_column TEXT);
      PRAGMA user_version = 4;
    `);
    legacy.close();

    expect(() => new SebDatabase(file)).toThrow(/existing usage tables/u);

    const inspected = new Database(file, { readonly: true });
    const version = inspected.pragma('user_version', { simple: true });
    const tables = inspected.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'usage_%'
      ORDER BY name
    `).all();
    inspected.close();
    expect(version).toBe(4);
    expect(tables).toEqual([{ name: 'usage_runs' }]);
  });

  it('rolls back a migration when compatible tables contain an orphan', () => {
    const file = databaseFile('seb-usage-orphan-');
    const initial = new SebDatabase(file);
    initial.close();
    const legacy = new Database(file);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO usage_steps (
        call_id, step_number, provider, model_id
      ) VALUES ('missing-run', 0, 'google', 'gemini-3-flash');
      PRAGMA user_version = 4;
    `);
    legacy.close();

    expect(() => new SebDatabase(file)).toThrow(/1 orphaned record/u);

    const inspected = new Database(file, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(4);
    expect(inspected.prepare('SELECT call_id FROM usage_steps').all()).toEqual([
      { call_id: 'missing-run' },
    ]);
    inspected.close();
  });

  it('rejects a damaged version 6 usage schema during startup', () => {
    const file = databaseFile('seb-usage-v6-schema-');
    const initial = new SebDatabase(file);
    initial.close();
    const damaged = new Database(file);
    damaged.exec('DROP TABLE usage_tool_calls;');
    damaged.close();

    expect(() => new SebDatabase(file)).toThrow(/complete schema/u);
  });

  it('rejects invalid version 6 metadata during startup', () => {
    const file = databaseFile('seb-usage-v6-metadata-');
    const initial = new SebDatabase(file);
    initial.close();
    const damaged = new Database(file);
    damaged.exec(`
      INSERT INTO usage_runs (
        call_id, session_id, surface, agent_kind, started_at, status
      ) VALUES (
        'bad id', 'session-valid', 'cli', 'research',
        '2026-08-31T10:00:00.000Z', 'running'
      );
    `);
    damaged.close();

    expect(() => new SebDatabase(file)).toThrow(/opaque identifier/u);
  });

  it('rejects an extra version 6 foreign key during startup', () => {
    const file = databaseFile('seb-usage-v6-extra-link-');
    const initial = new SebDatabase(file);
    initial.close();
    const damaged = new Database(file);
    const stepDefinition = damaged.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage_steps'
    `).get() as { sql: string };
    const toolDefinition = damaged.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'usage_tool_calls'
    `).get() as { sql: string };
    const alteredStepDefinition = stepDefinition.sql.replace(
      /(FOREIGN KEY \(call_id\)\s+REFERENCES "?usage_runs"?\(call_id\) ON DELETE CASCADE,)/u,
      '$1\n      FOREIGN KEY (provider) REFERENCES usage_runs(call_id) ON DELETE CASCADE,',
    );
    expect(alteredStepDefinition).not.toBe(stepDefinition.sql);
    damaged.exec(`
      DROP TABLE usage_tool_calls;
      DROP TABLE usage_steps;
    `);
    damaged.exec(alteredStepDefinition);
    damaged.exec(toolDefinition.sql);
    damaged.exec(`
      CREATE INDEX usage_step_model_idx ON usage_steps(provider, model_id);
      CREATE INDEX usage_tool_name_idx ON usage_tool_calls(tool_name);
    `);
    damaged.close();

    expect(() => new SebDatabase(file)).toThrow(/schema version 6/u);
  });

  it('rejects an extra version 6 usage index during startup', () => {
    const file = databaseFile('seb-usage-v6-extra-index-');
    const initial = new SebDatabase(file);
    initial.close();
    const damaged = new Database(file);
    damaged.exec(`
      CREATE UNIQUE INDEX harmful_usage_provider_unique
      ON usage_steps(provider);
    `);
    damaged.close();

    expect(() => new SebDatabase(file)).toThrow(/invalid indexes/u);
  });

  it('rejects a version 6 usage trigger during startup', () => {
    const file = databaseFile('seb-usage-v6-trigger-');
    const initial = new SebDatabase(file);
    initial.close();
    const damaged = new Database(file);
    damaged.exec(`
      CREATE TRIGGER harmful_usage_block
      BEFORE INSERT ON usage_runs
      BEGIN
        SELECT RAISE(ABORT, 'blocked usage');
      END;
    `);
    damaged.close();

    expect(() => new SebDatabase(file)).toThrow(/unexpected trigger/u);
  });

  it('rejects a cross-table trigger that changes usage rows', () => {
    const file = databaseFile('seb-usage-v6-cross-table-trigger-');
    const initial = new SebDatabase(file);
    initial.close();
    const damaged = new Database(file);
    damaged.exec(`
      CREATE TRIGGER harmful_cache_usage_delete
      AFTER INSERT ON cache_entries
      BEGIN
        DELETE FROM usage_runs;
      END;
    `);
    damaged.close();

    expect(() => new SebDatabase(file)).toThrow(/unexpected trigger/u);
  });

  it('rejects a generated version 6 usage column during startup', () => {
    const file = databaseFile('seb-usage-v6-generated-column-');
    const initial = new SebDatabase(file);
    initial.close();
    const damaged = new Database(file);
    const definitions = Object.fromEntries(
      ['usage_runs', 'usage_steps', 'usage_tool_calls'].map((name) => {
        const row = damaged.prepare(`
          SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
        `).get(name) as { sql: string };
        return [name, row.sql];
      }),
    );
    const alteredRunDefinition = definitions.usage_runs?.replace(
      'error_kind TEXT,',
      'error_kind TEXT GENERATED ALWAYS AS (surface) VIRTUAL,',
    );
    expect(alteredRunDefinition).toBeTruthy();
    expect(alteredRunDefinition).not.toBe(definitions.usage_runs);
    damaged.exec(`
      DROP TABLE usage_tool_calls;
      DROP TABLE usage_steps;
      DROP TABLE usage_runs;
    `);
    damaged.exec(alteredRunDefinition!);
    damaged.exec(definitions.usage_steps!);
    damaged.exec(definitions.usage_tool_calls!);
    damaged.exec(`
      CREATE INDEX usage_run_started_idx ON usage_runs(started_at DESC);
      CREATE INDEX usage_run_session_started_idx
        ON usage_runs(session_id, started_at DESC);
      CREATE INDEX usage_step_model_idx ON usage_steps(provider, model_id);
      CREATE INDEX usage_tool_name_idx ON usage_tool_calls(tool_name);
    `);
    damaged.close();

    expect(() => new SebDatabase(file)).toThrow(/schema version 6/u);
  });

  it('rejects a collated version 6 primary key during startup', () => {
    const file = databaseFile('seb-usage-v6-collated-key-');
    const initial = new SebDatabase(file);
    initial.close();
    rewriteUsageTables(file, (definitions) => ({
      ...definitions,
      usage_runs: definitions.usage_runs.replace(
        'call_id TEXT NOT NULL PRIMARY KEY',
        'call_id TEXT COLLATE NOCASE NOT NULL PRIMARY KEY',
      ),
    }));

    expect(() => new SebDatabase(file)).toThrow(/schema version 6/u);
  });

  it('rejects an extra version 6 table constraint during startup', () => {
    const file = databaseFile('seb-usage-v6-extra-constraint-');
    const initial = new SebDatabase(file);
    initial.close();
    rewriteUsageTables(file, (definitions) => ({
      ...definitions,
      usage_runs: definitions.usage_runs.replace(
        /\n\s*\) STRICT$/u,
        ',\n      CHECK(length(surface) > 3)\n    ) STRICT',
      ),
    }));

    expect(() => new SebDatabase(file)).toThrow(/schema version 6/u);
  });

  it('rolls back a version 5 migration that contains an orphan', () => {
    const file = databaseFile('seb-usage-v5-orphan-');
    const initial = new SebDatabase(file);
    initial.close();
    const damaged = new Database(file);
    damaged.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO usage_steps (
        call_id, step_number, provider, model_id
      ) VALUES ('missing-v5-run', 0, 'google', 'gemini-3-flash');
      PRAGMA user_version = 5;
    `);
    damaged.close();

    expect(() => new SebDatabase(file)).toThrow(/1 orphaned record/u);

    const inspected = new Database(file, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(5);
    inspected.close();
  });

  it('rejects an inbound link before a version 5 usage migration', () => {
    const file = databaseFile('seb-usage-v5-inbound-link-');
    const initial = new SebDatabase(file);
    initial.startUsageRun({
      agentKind: 'research',
      callId: 'linked-run',
      sessionId: 'linked-session',
      startedAt: '2026-08-31T10:00:00.000Z',
      surface: 'cli',
    });
    initial.close();
    const linked = new Database(file);
    linked.exec(`
      CREATE TABLE custom_usage_link (
        call_id TEXT NOT NULL,
        FOREIGN KEY (call_id) REFERENCES usage_runs(call_id) ON DELETE CASCADE
      );
      INSERT INTO custom_usage_link VALUES ('linked-run');
      PRAGMA user_version = 5;
    `);
    linked.close();

    expect(() => new SebDatabase(file)).toThrow(/cannot link to a Seb usage table/u);

    const inspected = new Database(file, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(5);
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM custom_usage_link').get())
      .toEqual({ count: 1 });
    inspected.close();
  });

  it('rejects an inbound link that uses different identifier casing', () => {
    const file = databaseFile('seb-usage-uppercase-inbound-link-');
    const initial = new SebDatabase(file);
    initial.startUsageRun({
      agentKind: 'research',
      callId: 'uppercase-linked-run',
      sessionId: 'linked-session',
      startedAt: '2026-08-31T10:00:00.000Z',
      surface: 'cli',
    });
    initial.finishUsageRun('uppercase-linked-run', {
      endedAt: '2026-08-31T10:00:01.000Z',
      status: 'completed',
    });
    initial.close();
    const linked = new Database(file);
    linked.exec(`
      CREATE TABLE uppercase_usage_link (
        call_id TEXT NOT NULL,
        FOREIGN KEY (call_id) REFERENCES USAGE_RUNS(call_id) ON DELETE RESTRICT
      );
      INSERT INTO uppercase_usage_link VALUES ('uppercase-linked-run');
    `);
    linked.close();

    expect(() => new SebDatabase(file)).toThrow(/cannot link to a Seb usage table/u);

    const inspected = new Database(file, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(6);
    expect(inspected.prepare('SELECT COUNT(*) AS count FROM uppercase_usage_link').get())
      .toEqual({ count: 1 });
    inspected.close();
  });

  it('rejects a trigger before a version 5 usage migration', () => {
    const file = databaseFile('seb-usage-v5-trigger-');
    const initial = new SebDatabase(file);
    initial.close();
    const damaged = new Database(file);
    damaged.exec(`
      CREATE TRIGGER preserve_usage_trigger
      AFTER INSERT ON usage_runs
      BEGIN
        SELECT 1;
      END;
      PRAGMA user_version = 5;
    `);
    damaged.close();

    expect(() => new SebDatabase(file)).toThrow(/unexpected trigger/u);

    const inspected = new Database(file, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(5);
    expect(inspected.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name = 'preserve_usage_trigger'
    `).get()).toEqual({ name: 'preserve_usage_trigger' });
    inspected.close();
  });

  it('rejects a custom index before a version 5 usage migration', () => {
    const file = databaseFile('seb-usage-v5-index-');
    const initial = new SebDatabase(file);
    initial.close();
    const damaged = new Database(file);
    damaged.exec(`
      CREATE INDEX preserve_usage_surface_idx ON usage_runs(surface);
      PRAGMA user_version = 5;
    `);
    damaged.close();

    expect(() => new SebDatabase(file)).toThrow(/indexes that cannot migrate/u);

    const inspected = new Database(file, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(5);
    expect(inspected.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'preserve_usage_surface_idx'
    `).get()).toEqual({ name: 'preserve_usage_surface_idx' });
    inspected.close();
  });

  it('rejects a custom table constraint before a version 5 usage migration', () => {
    const file = databaseFile('seb-usage-v5-constraint-');
    const initial = new SebDatabase(file);
    initial.close();
    rewriteAsLegacyUsageSchemaVersion5(file, true);

    const legacy = new Database(file);
    legacy.exec(`
      INSERT INTO usage_runs VALUES (
        'constraint-run', 'constraint-session', 'contract', 'research',
        '2026-08-31T10:00:00.000Z', '2026-08-31T10:00:01.000Z',
        'completed', 'stop', NULL
      );
    `);
    legacy.close();

    expect(() => new SebDatabase(file)).toThrow(/definition that cannot migrate/u);

    const inspected = new Database(file, { readonly: true });
    expect(inspected.pragma('user_version', { simple: true })).toBe(5);
    expect(inspected.prepare('SELECT call_id FROM usage_runs').all()).toEqual([
      { call_id: 'constraint-run' },
    ]);
    const definition = inspected.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'usage_runs'
    `).get() as { sql: string };
    expect(definition.sql).toContain('CHECK(length(surface) > 3)');
    inspected.close();
  });

  it('stores privacy-safe run, step, and tool metadata with null coverage', () => {
    const database = createDatabase();
    expect(database.startUsageRun({
      agentKind: 'research',
      callId: 'call-1',
      sessionId: 'session-1',
      startedAt: '2026-08-31T10:00:00.000Z',
      surface: 'interactive',
    })).toMatchObject({
      callId: 'call-1',
      endedAt: null,
      status: 'running',
    });

    expect(database.putUsageStep({
      cacheReadInputTokens: 120,
      cacheWriteInputTokens: null,
      callId: 'call-1',
      finishReason: 'tool-calls',
      groundingCounts: { web_search: 2, url_context: 1 },
      inputTokens: 300,
      modelId: 'gemini-3-flash',
      noCacheInputTokens: 180,
      outputTokens: 40,
      provider: 'google.generative-ai',
      providerTotalTokens: 350,
      reasoningTokens: null,
      responseTimeMs: 124.5,
      serviceTier: 'standard',
      stepNumber: 0,
      stepTimeMs: 160,
      textTokens: 40,
      timeToFirstOutputMs: 50.25,
      toolUseTokens: 10,
      totalTokens: 340,
    })).toMatchObject({
      cacheWriteInputTokens: null,
      reasoningTokens: null,
      toolUseTokens: 10,
    });

    database.putUsageToolCall({
      callId: 'call-1',
      dynamic: false,
      executionLocation: 'provider',
      executionMs: null,
      outcome: 'returned',
      stepNumber: 0,
      toolCallId: 'tool-call-1',
      toolName: 'google_search',
    });
    database.finishUsageRun('call-1', {
      endedAt: '2026-08-31T10:00:01.000Z',
      finalFinishReason: 'stop',
      status: 'completed',
    });

    expect(database.readUsageDataset()).toEqual({
      runs: [{
        agentKind: 'research',
        callId: 'call-1',
        endedAt: '2026-08-31T10:00:01.000Z',
        errorKind: null,
        finalFinishReason: 'stop',
        sessionId: 'session-1',
        startedAt: '2026-08-31T10:00:00.000Z',
        status: 'completed',
        surface: 'interactive',
      }],
      steps: [expect.objectContaining({
        cacheWriteInputTokens: null,
        callId: 'call-1',
        groundingCounts: { url_context: 1, web_search: 2 },
        reasoningTokens: null,
        responseTimeMs: 124.5,
        stepNumber: 0,
      })],
      toolCalls: [{
        callId: 'call-1',
        dynamic: false,
        executionLocation: 'provider',
        executionMs: null,
        outcome: 'returned',
        stepNumber: 0,
        toolCallId: 'tool-call-1',
        toolName: 'google_search',
      }],
      truncated: false,
    });

    const inspected = new Database(database.file, { readonly: true });
    const columns = ['usage_runs', 'usage_steps', 'usage_tool_calls'].flatMap(
      (table) => (inspected.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>).map((column) => column.name),
    );
    inspected.close();
    expect(columns).not.toEqual(expect.arrayContaining([
      'prompt',
      'response',
      'tool_input',
      'tool_output',
      'error_message',
      'provider_metadata',
    ]));
  });

  it('keeps usage records after the database reopens', () => {
    const file = databaseFile('seb-usage-reopen-');
    const first = new SebDatabase(file);
    first.startUsageRun({
      agentKind: 'formatter',
      callId: 'call-durable',
      sessionId: 'session-durable',
      startedAt: '2026-08-31T10:30:00.000Z',
      surface: 'cli',
    });
    first.putUsageStep({
      callId: 'call-durable',
      modelId: 'gemini-3-flash',
      provider: 'google',
      stepNumber: 0,
      totalTokens: 12,
    });
    first.close();

    const reopened = track(new SebDatabase(file));
    expect(reopened.readUsageDataset()).toMatchObject({
      runs: [{ callId: 'call-durable', status: 'running' }],
      steps: [{ callId: 'call-durable', totalTokens: 12 }],
      truncated: false,
    });
  });

  it('makes retries idempotent and permits only null-to-value enrichment', () => {
    const database = createDatabase();
    const runWrite = {
      agentKind: 'research',
      callId: 'call-retry',
      sessionId: 'session-retry',
      startedAt: '2026-08-31T11:00:00.000Z',
      surface: 'interactive',
    } as const;
    expect(database.startUsageRun(runWrite)).toEqual(database.startUsageRun(runWrite));

    const partial = database.putUsageStep({
      callId: 'call-retry',
      modelId: 'gemini-3-flash',
      provider: 'google',
      stepNumber: 0,
    });
    expect(partial.inputTokens).toBeNull();
    const complete = database.putUsageStep({
      callId: 'call-retry',
      finishReason: 'stop',
      inputTokens: 25,
      modelId: 'gemini-3-flash',
      provider: 'google',
      stepNumber: 0,
      totalTokens: 30,
    });
    expect(complete).toMatchObject({
      finishReason: 'stop',
      inputTokens: 25,
      totalTokens: 30,
    });
    expect(database.putUsageStep({
      callId: 'call-retry',
      modelId: 'gemini-3-flash',
      provider: 'google',
      stepNumber: 0,
    })).toEqual(complete);
    expect(() => database.putUsageStep({
      callId: 'call-retry',
      inputTokens: 26,
      modelId: 'gemini-3-flash',
      provider: 'google',
      stepNumber: 0,
    })).toThrow(/conflicts with its saved value/u);

    const unresolved: UsageToolCallWrite = {
      callId: 'call-retry',
      executionLocation: 'client',
      outcome: 'unresolved',
      stepNumber: 0,
      toolCallId: 'tool-retry',
      toolName: 'league_lookup',
    };
    database.putUsageToolCall(unresolved);
    const returned = database.putUsageToolCall({
      ...unresolved,
      executionMs: 42,
      outcome: 'returned',
    });
    expect(database.putUsageToolCall(unresolved)).toEqual(returned);
    expect(() => database.putUsageToolCall({
      ...unresolved,
      outcome: 'error',
    })).toThrow(/conflicting outcome/u);

    const finished = database.finishUsageRun('call-retry', {
      endedAt: '2026-08-31T11:00:01.000Z',
      finalFinishReason: 'stop',
      status: 'completed',
    });
    expect(database.finishUsageRun('call-retry', {
      status: 'completed',
    })).toEqual(finished);
    const failed = database.finishUsageRun('call-retry', {
      endedAt: '2026-08-31T11:00:02.000Z',
      errorKind: 'validation',
      finalFinishReason: 'error',
      status: 'failed',
    });
    expect(failed).toMatchObject({
      endedAt: '2026-08-31T11:00:01.000Z',
      errorKind: 'validation',
      finalFinishReason: 'error',
      status: 'failed',
    });
    const aborted = database.finishUsageRun('call-retry', {
      errorKind: 'aborterror',
      finalFinishReason: null,
      status: 'aborted',
    });
    expect(aborted).toMatchObject({
      endedAt: '2026-08-31T11:00:01.000Z',
      errorKind: 'aborterror',
      finalFinishReason: null,
      status: 'aborted',
    });
    expect(() => database.finishUsageRun('call-retry', {
      status: 'completed',
    })).toThrow(/final status aborted/u);
    expect(database.status()).toMatchObject({
      usageRuns: 1,
      usageSteps: 1,
      usageToolCalls: 1,
    });
  });

  it('rejects invalid metrics, timestamps, metadata, and missing parents', () => {
    const database = createDatabase();
    database.startUsageRun({
      agentKind: 'research',
      callId: 'call-validation',
      sessionId: 'session-validation',
      startedAt: '2026-08-31T12:00:00.000Z',
      surface: 'interactive',
    });
    const baseStep = {
      callId: 'call-validation',
      modelId: 'gemini-3-flash',
      provider: 'google',
      stepNumber: 0,
    } as const;

    expect(() => database.putUsageStep({
      ...baseStep,
      inputTokens: -1,
    })).toThrow(/nonnegative safe integer/u);
    expect(() => database.putUsageStep({
      ...baseStep,
      inputTokens: MAX_USAGE_TOKEN_COUNT + 1,
    })).toThrow(/no greater than 10000000000/u);
    expect(() => database.putUsageStep({
      ...baseStep,
      outputTokens: 1.5,
    })).toThrow(/nonnegative safe integer/u);
    expect(() => database.putUsageStep({
      ...baseStep,
      responseTimeMs: Number.POSITIVE_INFINITY,
    })).toThrow(/nonnegative finite number/u);
    expect(() => database.putUsageStep({
      ...baseStep,
      responseTimeMs: MAX_USAGE_DURATION_MS + 1,
    })).toThrow(/365 days/u);
    expect(() => database.putUsageToolCall({
      callId: 'call-validation',
      executionLocation: 'client',
      executionMs: MAX_USAGE_DURATION_MS + 1,
      outcome: 'returned',
      stepNumber: 0,
      toolCallId: 'tool-too-long',
      toolName: 'league_lookup',
    })).toThrow(/365 days/u);
    expect(() => database.putUsageStep({
      ...baseStep,
      groundingCounts: { web_search: -1 },
    })).toThrow(/nonnegative safe integer/u);
    expect(() => database.putUsageStep({
      ...baseStep,
      modelId: 'model with prompt text',
    })).toThrow(/metadata code/u);
    expect(() => database.putUsageStep({
      ...baseStep,
      callId: 'missing-run',
    })).toThrow(/does not exist/u);
    expect(() => database.finishUsageRun('call-validation', {
      endedAt: '2026-08-31T11:59:59.000Z',
      status: 'completed',
    })).toThrow(/before the start time/u);
    expect(() => database.finishUsageRun('call-validation', {
      errorKind: 'raw error message with user text',
      status: 'failed',
    })).toThrow(/metadata code/u);
    expect(() => database.readUsageDataset({
      since: 'not-a-time',
    })).toThrow(/ISO 8601/u);
    expect(() => database.readUsageDataset({
      since: '2026-02-30T00:00:00.000Z',
    })).toThrow(/canonical ISO 8601/u);
    expect(() => database.pruneUsage(
      '2026-08-31T00:00:00Z',
    )).toThrow(/canonical ISO 8601/u);
    expect(() => database.startUsageRun({
      agentKind: 'research',
      callId: 'private\ntext',
      sessionId: 'session-validation',
      surface: 'interactive',
    })).toThrow(/control character/u);
    const external = new Database(database.file);
    expect(() => external.prepare(`
      INSERT INTO usage_runs (
        call_id, session_id, surface, agent_kind, started_at, status
      ) VALUES (NULL, ?, ?, ?, ?, 'running')
    `).run(
      'session-validation',
      'interactive',
      'research',
      '2026-08-31T12:00:00.000Z',
    )).toThrow(/constraint failed/iu);
    expect(() => external.prepare(`
      INSERT INTO usage_runs (
        call_id, session_id, surface, agent_kind, started_at, status
      ) VALUES (?, ?, ?, ?, ?, 'running')
    `).run(
      'invalid-start-time',
      'session-validation',
      'interactive',
      'research',
      '2026-02-30T00:00:00.000Z',
    )).toThrow(/constraint failed/iu);
    expect(() => external.prepare(`
      INSERT INTO usage_steps (
        call_id, step_number, provider, model_id, response_time_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run('call-validation', 0, 'google', 'gemini-3-flash', 'private text'))
      .toThrow(/cannot store text value in real column/iu);
    expect(() => external.prepare(`
      INSERT INTO usage_steps (
        call_id, step_number, provider, model_id, grounding_counts_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run('call-validation', 1, 'google', 'gemini-3-flash', 'not-json'))
      .toThrow(/constraint failed/iu);
    expect(() => external.prepare(`
      INSERT INTO usage_steps (
        call_id, step_number, provider, model_id, input_tokens
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      'call-validation',
      2,
      'google',
      'gemini-3-flash',
      MAX_USAGE_TOKEN_COUNT + 1,
    )).toThrow(/constraint failed/iu);
    expect(() => external.prepare(`
      INSERT INTO usage_steps (
        call_id, step_number, provider, model_id, response_time_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      'call-validation',
      3,
      'google',
      'gemini-3-flash',
      MAX_USAGE_DURATION_MS + 1,
    )).toThrow(/constraint failed/iu);
    external.close();
    expect(database.status()).toMatchObject({ usageRuns: 1, usageSteps: 0 });
  });

  it('filters by session and time and reports query truncation', () => {
    const database = createDatabase();
    addUsageRun(database, 'call-a-old', 'session-a', '2026-08-01T00:00:00.000Z');
    addUsageRun(database, 'call-a-in', 'session-a', '2026-08-02T00:00:00.000Z');
    addUsageRun(database, 'call-b-in', 'session-b', '2026-08-02T12:00:00.000Z');
    addUsageRun(database, 'call-a-boundary', 'session-a', '2026-08-03T00:00:00.000Z');

    const filtered = database.readUsageDataset({
      sessionId: 'session-a',
      since: '2026-08-02T00:00:00.000Z',
      until: '2026-08-03T00:00:00.000Z',
    });
    expect(filtered.runs.map((run) => run.callId)).toEqual(['call-a-in']);
    expect(filtered.steps.map((step) => step.callId)).toEqual(['call-a-in']);
    expect(filtered.toolCalls.map((tool) => tool.callId)).toEqual(['call-a-in']);

    const limited = database.readUsageDataset({ limit: 2 });
    expect(limited.truncated).toBe(true);
    expect(limited.runs.map((run) => run.callId)).toEqual([
      'call-b-in',
      'call-a-boundary',
    ]);
    expect(new Set(limited.steps.map((step) => step.callId))).toEqual(
      new Set(['call-b-in', 'call-a-boundary']),
    );
    expect(() => database.readUsageDataset({
      since: '2026-08-03T00:00:00.000Z',
      until: '2026-08-02T00:00:00.000Z',
    })).toThrow(/start time must not occur after/u);
  });

  it('includes a future-dated valid run in the all scope', () => {
    const database = createDatabase();
    addUsageRun(database, 'call-past', 'session-a', '2026-08-30T00:00:00.000Z');
    addUsageRun(database, 'call-future', 'session-a', '2026-09-01T00:00:00.000Z');
    const query = usageQuery(usageWindow(
      'all',
      new Date('2026-08-31T00:00:00.000Z'),
    ));

    expect(database.readUsageDataset(query).runs.map((run) => run.callId).sort())
      .toEqual(['call-future', 'call-past']);
  });

  it('prunes and clears usage without changing cached data', () => {
    const database = createDatabase();
    database.putCache({
      key: 'keep',
      namespace: 'usage-test',
      schemaVersion: 'v1',
      staleIfErrorMs: 100,
      ttlMs: 100,
      value: { cache: true },
    });
    addUsageRun(database, 'call-old', 'session-a', '2026-01-01T00:00:00.000Z');
    addUsageRun(database, 'call-boundary', 'session-a', '2026-02-01T00:00:00.000Z');

    expect(database.pruneUsage('2026-02-01T00:00:00.000Z')).toEqual({
      removed: 1,
      unfinishedPreserved: 0,
    });
    expect(database.status()).toMatchObject({
      usageRuns: 1,
      usageSteps: 1,
      usageToolCalls: 1,
    });
    database.deleteCache('usage-test');
    expect(database.readUsageDataset().runs.map((run) => run.callId)).toEqual([
      'call-boundary',
    ]);
    expect(database.clearUsage()).toEqual({ removed: 1, unfinishedPreserved: 0 });
    expect(database.clearUsage()).toEqual({ removed: 0, unfinishedPreserved: 0 });
    expect(database.status()).toMatchObject({
      usageRuns: 0,
      usageSteps: 0,
      usageToolCalls: 0,
    });
  });

  it('preserves unfinished runs by default and deletes them only when requested', () => {
    const database = createDatabase();
    addUsageRun(database, 'call-complete', 'session-a', '2026-01-01T00:00:00.000Z');
    database.startUsageRun({
      agentKind: 'research',
      callId: 'call-prune-running',
      sessionId: 'session-a',
      startedAt: '2026-01-02T00:00:00.000Z',
      surface: 'interactive',
    });
    const maintenance = track(new SebDatabase(database.file));

    expect(maintenance.pruneUsage('2026-02-01T00:00:00.000Z')).toEqual({
      removed: 1,
      unfinishedPreserved: 1,
    });
    database.putUsageStep({
      callId: 'call-prune-running',
      modelId: 'gemini-3-flash',
      provider: 'google',
      stepNumber: 0,
      totalTokens: 20,
    });
    database.finishUsageRun('call-prune-running', {
      endedAt: '2026-01-02T00:00:01.000Z',
      status: 'completed',
    });
    database.startUsageRun({
      agentKind: 'research',
      callId: 'call-clear-running',
      sessionId: 'session-a',
      startedAt: '2026-03-01T00:00:00.000Z',
      surface: 'interactive',
    });

    expect(maintenance.clearUsage()).toEqual({
      removed: 1,
      unfinishedPreserved: 1,
    });
    database.putUsageStep({
      callId: 'call-clear-running',
      modelId: 'gemini-3-flash',
      provider: 'google',
      stepNumber: 0,
      totalTokens: 30,
    });
    database.finishUsageRun('call-clear-running', {
      endedAt: '2026-03-01T00:00:01.000Z',
      status: 'completed',
    });
    expect(maintenance.clearUsage(true)).toEqual({
      removed: 1,
      unfinishedPreserved: 0,
    });

    database.startUsageRun({
      agentKind: 'research',
      callId: 'call-prune-included',
      sessionId: 'session-a',
      startedAt: '2026-01-03T00:00:00.000Z',
      surface: 'interactive',
    });
    expect(maintenance.pruneUsage('2026-02-01T00:00:00.000Z', true)).toEqual({
      removed: 1,
      unfinishedPreserved: 0,
    });
    expect(database.status()).toMatchObject({
      usageRuns: 0,
      usageSteps: 0,
      usageToolCalls: 0,
    });
  });
});

function databaseFile(prefix: string): string {
  return resolve(mkdtempSync(resolve(tmpdir(), prefix)), 'seb.sqlite');
}

function createDatabase(): SebDatabase {
  return track(new SebDatabase(databaseFile('seb-usage-')));
}

function track(database: SebDatabase): SebDatabase {
  databases.push(database);
  return database;
}

type UsageTableDefinitions = Record<
  'usage_runs' | 'usage_steps' | 'usage_tool_calls',
  string
>;

function rewriteUsageTables(
  file: string,
  rewrite: (definitions: UsageTableDefinitions) => UsageTableDefinitions,
): void {
  const database = new Database(file);
  const definitions = Object.fromEntries(
    ['usage_runs', 'usage_steps', 'usage_tool_calls'].map((name) => {
      const row = database.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(name) as { sql: string };
      return [name, row.sql];
    }),
  ) as UsageTableDefinitions;
  const rewritten = rewrite(definitions);
  database.exec(`
    DROP TABLE usage_tool_calls;
    DROP TABLE usage_steps;
    DROP TABLE usage_runs;
  `);
  database.exec(rewritten.usage_runs);
  database.exec(rewritten.usage_steps);
  database.exec(rewritten.usage_tool_calls);
  database.exec(`
    CREATE INDEX usage_run_started_idx ON usage_runs(started_at DESC);
    CREATE INDEX usage_run_session_started_idx
      ON usage_runs(session_id, started_at DESC);
    CREATE INDEX usage_step_model_idx ON usage_steps(provider, model_id);
    CREATE INDEX usage_tool_name_idx ON usage_tool_calls(tool_name);
  `);
  database.close();
}

function rewriteAsLegacyUsageSchemaVersion5(
  file: string,
  includeCustomConstraint: boolean,
): void {
  const customConstraint = includeCustomConstraint
    ? ', CHECK(length(surface) > 3)'
    : '';
  const database = new Database(file);
  database.exec(`
    DROP TABLE usage_tool_calls;
    DROP TABLE usage_steps;
    DROP TABLE usage_runs;
    CREATE TABLE usage_runs (
      call_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      agent_kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL,
      final_finish_reason TEXT,
      error_kind TEXT${customConstraint}
    );
    CREATE TABLE usage_steps (
      call_id TEXT NOT NULL,
      step_number INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      finish_reason TEXT,
      raw_finish_reason TEXT,
      input_tokens INTEGER,
      no_cache_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      cache_write_input_tokens INTEGER,
      output_tokens INTEGER,
      text_tokens INTEGER,
      reasoning_tokens INTEGER,
      total_tokens INTEGER,
      provider_total_tokens INTEGER,
      tool_use_tokens INTEGER,
      response_time_ms REAL,
      time_to_first_output_ms REAL,
      step_time_ms REAL,
      service_tier TEXT,
      grounding_counts_json TEXT,
      PRIMARY KEY (call_id, step_number),
      FOREIGN KEY (call_id) REFERENCES usage_runs(call_id) ON DELETE CASCADE
    );
    CREATE TABLE usage_tool_calls (
      call_id TEXT NOT NULL,
      step_number INTEGER NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      execution_location TEXT NOT NULL,
      outcome TEXT NOT NULL,
      execution_ms REAL,
      dynamic INTEGER,
      PRIMARY KEY (call_id, step_number, tool_call_id),
      FOREIGN KEY (call_id, step_number)
        REFERENCES usage_steps(call_id, step_number) ON DELETE CASCADE
    );
    PRAGMA user_version = 5;
  `);
  database.close();
}

function addUsageRun(
  database: SebDatabase,
  callId: string,
  sessionId: string,
  startedAt: string,
): void {
  database.startUsageRun({
    agentKind: 'research',
    callId,
    sessionId,
    startedAt,
    surface: 'interactive',
  });
  database.putUsageStep({
    callId,
    modelId: 'gemini-3-flash',
    provider: 'google',
    stepNumber: 0,
    totalTokens: 10,
  });
  database.putUsageToolCall({
    callId,
    executionLocation: 'client',
    outcome: 'returned',
    stepNumber: 0,
    toolCallId: `${callId}-tool`,
    toolName: 'league_lookup',
  });
  database.finishUsageRun(callId, {
    endedAt: new Date(Date.parse(startedAt) + 1_000).toISOString(),
    finalFinishReason: 'stop',
    status: 'completed',
  });
}
