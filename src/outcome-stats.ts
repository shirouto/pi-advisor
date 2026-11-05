import { readFile } from "node:fs/promises";

import { isRecord, isString } from "./content-utils.ts";
import {
  ADOPTIONS,
  OUTCOME_TRIGGERS,
  outcomeLogPath,
  VALIDATIONS,
} from "./outcomes.ts";
import type {
  OutcomeAdoption,
  OutcomeRecord,
  OutcomeTrigger,
} from "./outcomes.ts";

interface OutcomeValidationStats {
  failed: number;
  notRun: number;
  passed: number;
  passRate?: number;
  total: number;
  unknown: number;
}

export interface OutcomeStats {
  adoption: Record<OutcomeAdoption, number>;
  byTrigger: Record<OutcomeTrigger, number>;
  distinctAdvices: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  malformedLines: number;
  total: number;
  validationByAdoption: Record<OutcomeAdoption, OutcomeValidationStats>;
}

export interface OutcomeLogRead {
  malformedLines: number;
  missing: boolean;
  records: OutcomeRecord[];
}

const ADOPTION_SET = new Set<string>(ADOPTIONS);
const VALIDATION_SET = new Set<string>(VALIDATIONS);
const TRIGGER_SET = new Set<string>(OUTCOME_TRIGGERS);

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

const isOutcomeRecord = (value: unknown): value is OutcomeRecord =>
  isRecord(value) &&
  value.v === 1 &&
  isString(value.adoption) &&
  ADOPTION_SET.has(value.adoption) &&
  isString(value.adviceHash) &&
  isString(value.timestamp) &&
  Number.isFinite(Date.parse(value.timestamp)) &&
  isString(value.trigger) &&
  TRIGGER_SET.has(value.trigger) &&
  isString(value.validationStatus) &&
  VALIDATION_SET.has(value.validationStatus);

export const parseOutcomeLog = (text: string): OutcomeLogRead => {
  const records: OutcomeRecord[] = [];
  let malformedLines = 0;

  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }

    try {
      const value: unknown = JSON.parse(line);

      if (isOutcomeRecord(value)) {
        records.push(value);
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }

  return { malformedLines, missing: false, records };
};

export const readOutcomeLog = async (
  path = outcomeLogPath()
): Promise<OutcomeLogRead> => {
  try {
    return parseOutcomeLog(await readFile(path, "utf-8"));
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return { malformedLines: 0, missing: true, records: [] };
    }

    throw error;
  }
};

const emptyValidationStats = (): OutcomeValidationStats => ({
  failed: 0,
  notRun: 0,
  passed: 0,
  total: 0,
  unknown: 0,
});

export const aggregateOutcomeRecords = (
  records: readonly OutcomeRecord[],
  malformedLines = 0
): OutcomeStats => {
  // SAFETY: ADOPTIONS enumerates every key in the returned adoption record.
  const adoption = Object.fromEntries(
    ADOPTIONS.map((value) => [value, 0])
  ) as Record<OutcomeAdoption, number>;

  // SAFETY: OUTCOME_TRIGGERS enumerates every key in the returned trigger record.
  const byTrigger = Object.fromEntries(
    OUTCOME_TRIGGERS.map((value) => [value, 0])
  ) as Record<OutcomeTrigger, number>;

  // SAFETY: ADOPTIONS enumerates every key and each value gets a fresh stats object.
  const validationByAdoption = Object.fromEntries(
    ADOPTIONS.map((value) => [value, emptyValidationStats()])
  ) as Record<OutcomeAdoption, OutcomeValidationStats>;

  const adviceHashes = new Set<string>();
  let first: { timestamp: string; time: number } | undefined;
  let last: { timestamp: string; time: number } | undefined;

  for (const record of records) {
    adoption[record.adoption] += 1;
    byTrigger[record.trigger] += 1;
    adviceHashes.add(record.adviceHash);
    const validation = validationByAdoption[record.adoption];
    validation.total += 1;
    validation[
      record.validationStatus === "not-run" ? "notRun" : record.validationStatus
    ] += 1;
    const time = Date.parse(record.timestamp);

    if (!first || time < first.time) {
      first = { time, timestamp: record.timestamp };
    }

    if (!last || time > last.time) {
      last = { time, timestamp: record.timestamp };
    }
  }

  for (const value of Object.values(validationByAdoption)) {
    const validated = value.passed + value.failed;

    if (validated > 0) {
      value.passRate = value.passed / validated;
    }
  }

  return {
    adoption,
    byTrigger,
    distinctAdvices: adviceHashes.size,
    firstTimestamp: first?.timestamp,
    lastTimestamp: last?.timestamp,
    malformedLines,
    total: records.length,
    validationByAdoption,
  };
};
