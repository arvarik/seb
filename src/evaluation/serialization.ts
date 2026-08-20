import {
  REPLAY_REPORT_SCHEMA_VERSION,
  type ReplayReport,
} from './types.js';

export function serializeReplayReport(
  report: ReplayReport,
  indentation = 2,
): string {
  if (!Number.isInteger(indentation) || indentation < 0 || indentation > 8) {
    throw new RangeError('The JSON indentation must be an integer from 0 through 8.');
  }
  validateReplayReport(report);
  return `${JSON.stringify(sortValue(report), null, indentation)}\n`;
}

export function parseReplayReport(value: string): ReplayReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new SyntaxError(`The replay report is not valid JSON: ${message(error)}`);
  }
  validateReplayReport(parsed);
  return parsed;
}

function validateReplayReport(value: unknown): asserts value is ReplayReport {
  if (!isRecord(value)) {
    throw new TypeError('The replay report must be a JSON object.');
  }
  if (value.schemaVersion !== REPLAY_REPORT_SCHEMA_VERSION) {
    throw new Error(
      `The replay report schema must be ${REPLAY_REPORT_SCHEMA_VERSION}.`,
    );
  }
  requiredString(value.generatedAt, 'The report generation time');
  if (!isRecord(value.dataset)) {
    throw new TypeError('The replay report needs a dataset object.');
  }
  requiredString(value.dataset.id, 'The report dataset ID');
  requiredString(value.dataset.label, 'The report dataset label');
  requiredString(value.dataset.metric, 'The report dataset metric');
  if (!isRecord(value.baseline)) {
    throw new TypeError('The replay report needs a baseline object.');
  }
  if (!Array.isArray(value.periods)) {
    throw new TypeError('The replay report needs a periods array.');
  }
  if (!isRecord(value.metrics)) {
    throw new TypeError('The replay report needs a metrics object.');
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!isRecord(value)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('The replay report cannot contain a nonfinite number.');
    }
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a nonempty string.`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
