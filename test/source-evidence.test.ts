import { describe, expect, it } from 'vitest';

import { InteractiveUiState } from '../src/interactive/ui-state.js';
import {
  createSourceEvidenceSnapshot,
  formatEvidenceMarkdown,
  SourceTracker,
  sourceEvidenceBadge,
  sourceRetrievalDetail,
} from '../src/sources.js';

describe('answer evidence', () => {
  it('keeps an immutable source set for each answer', () => {
    const tracker = new SourceTracker();
    const state = new InteractiveUiState();
    tracker.record({
      id: 'sleeper-state',
      label: 'Sleeper state',
      url: 'https://api.sleeper.app/v1/state/nfl',
      warnings: ['Cache write failed.'],
    });
    tracker.recordUrlSource({
      id: 'report-1',
      title: 'NFL report',
      url: 'https://example.com/nfl',
    });

    const first = tracker.snapshot('answer-1', new Date('2026-08-21T12:00:00Z'));
    state.recordAnswerEvidence(first);
    tracker.clear();
    tracker.recordUrlSource({
      id: 'report-2',
      title: 'Injury report',
      url: 'https://example.com/injury',
    });
    const second = tracker.snapshot('answer-2', new Date('2026-08-21T12:01:00Z'));
    state.recordAnswerEvidence(second);

    expect(state.evidenceForAnswer('answer-1')?.sources).toMatchObject([
      { id: 'sleeper-state', label: 'Sleeper state' },
      { id: 'web:report-1', label: 'NFL report' },
    ]);
    expect(state.evidenceForAnswer('answer-2')?.sources).toMatchObject([
      { id: 'web:report-2', label: 'Injury report' },
    ]);
    expect(state.latestEvidence()?.answerId).toBe('answer-2');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sources)).toBe(true);
    expect(Object.isFrozen(first.sources[0])).toBe(true);
    expect(Object.isFrozen(first.sources[0]?.warnings)).toBe(true);
  });

  it('shows text freshness states and exact retrieval details', () => {
    const now = new Date('2026-08-21T12:00:00Z');
    const cached = {
      accessedAt: '2026-08-21T12:00:00Z',
      cacheOutcome: 'cache-fresh' as const,
      id: 'nflverse:weekly',
      label: 'Weekly statistics',
      retrievedAt: '2026-08-21T11:56:00Z',
      url: 'https://github.com/nflverse/nflverse-data/releases',
    };
    const stale = {
      ...cached,
      cacheOutcome: 'stale-if-error' as const,
      id: 'nflverse:stale',
    };

    expect(sourceEvidenceBadge(cached, now)).toBe('CACHED 4m');
    expect(sourceEvidenceBadge(stale, now)).toBe('STALE');
    expect(sourceRetrievalDetail(cached, now)).toBe(
      'retrieved 4m ago · cache fresh',
    );
    expect(formatEvidenceMarkdown([cached, stale], { now })).toContain(
      '1. [Weekly statistics](<https://github.com/nflverse/nflverse-data/releases>) · **CACHED 4m**',
    );
    expect(formatEvidenceMarkdown([cached, stale], { now })).toContain('**STALE**');
  });

  it('keeps every source while the compact panel limits visible rows', () => {
    const tracker = new SourceTracker();
    for (let index = 1; index <= 4; index += 1) {
      tracker.recordUrlSource({
        id: `report-${index}`,
        title: `Report ${index}`,
        url: `https://example.com/report-${index}`,
      });
    }

    const snapshot = tracker.snapshot('answer-many');
    const panel = formatEvidenceMarkdown(snapshot.sources, { limit: 3 });

    expect(snapshot.sources).toHaveLength(4);
    expect(panel).toContain('Report 1');
    expect(panel).toContain('Report 3');
    expect(panel).not.toContain('Report 4');
    expect(panel).toContain('1 more source');
  });

  it('bounds tracked sources and evidence snapshot contents', () => {
    const tracker = new SourceTracker();
    for (let index = 1; index <= 205; index += 1) {
      tracker.record({
        id: `report-${index}`,
        label: `Report ${index}`,
        url: `https://example.com/report-${index}`,
        warnings: Array.from(
          { length: 12 },
          (_, warningIndex) => `Warning ${warningIndex} ${'x'.repeat(400)}`,
        ),
      });
    }

    const tracked = tracker.list();
    const snapshot = tracker.snapshot('bounded-answer');

    expect(tracked).toHaveLength(200);
    expect(tracked.some((source) => source.id === 'report-1')).toBe(false);
    expect(tracked.some((source) => source.id === 'report-205')).toBe(true);
    expect(snapshot.sources).toHaveLength(100);
    expect(snapshot.sources.some((source) => source.id === 'report-6')).toBe(
      false,
    );
    expect(snapshot.sources.some((source) => source.id === 'report-205')).toBe(
      true,
    );
    expect(snapshot.sources[0]?.warnings).toHaveLength(10);
    expect(snapshot.sources[0]?.warnings?.[0]?.length).toBeLessThanOrEqual(300);
    expect(tracker.recordUrlSource({
      id: 'oversized-url',
      url: `https://example.com/${'x'.repeat(4_100)}`,
    })).toBe(false);
  });

  it('normalizes direct evidence snapshot input', () => {
    const snapshot = createSourceEvidenceSnapshot(
      'a'.repeat(600),
      [{
        accessedAt: '2026-08-21T12:00:00Z',
        error: 'e'.repeat(600),
        id: `  ${'i'.repeat(600)}  `,
        label: 'l'.repeat(1_000_000),
        url: 'https://example.com/report',
        warnings: Array.from({ length: 12 }, () => 'w'.repeat(500)),
      }],
    );

    expect(snapshot.answerId).toHaveLength(512);
    expect(snapshot.sources[0]?.id).toHaveLength(512);
    expect(snapshot.sources[0]?.label).toHaveLength(300);
    expect(snapshot.sources[0]?.error).toHaveLength(500);
    expect(snapshot.sources[0]?.warnings).toHaveLength(10);
    expect(snapshot.sources[0]?.warnings?.[0]).toHaveLength(300);
  });

  it('evicts old answer evidence and refreshes duplicate identifiers', () => {
    const tracker = new SourceTracker();
    const state = new InteractiveUiState();
    tracker.recordUrlSource({
      id: 'report',
      title: 'Report',
      url: 'https://example.com/report',
    });
    for (let index = 0; index < 50; index += 1) {
      state.recordAnswerEvidence(tracker.snapshot(`answer-${index}`));
    }
    state.recordAnswerEvidence(tracker.snapshot('answer-0'));
    state.recordAnswerEvidence(tracker.snapshot('answer-50'));

    expect(state.evidenceForAnswer('answer-0')).not.toBeNull();
    expect(state.evidenceForAnswer('answer-1')).toBeNull();
    expect(state.latestEvidence()?.answerId).toBe('answer-50');

    state.clearAnswerEvidence();
    expect(state.latestEvidence()).toBeNull();
    expect(state.sources).toEqual([]);
  });
});
