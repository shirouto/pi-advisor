import type { EntryType, Questions } from "@typesafe-ai/sdk";

import { isRecordOf, isString } from "../content-utils.ts";
import { JevFailureError } from "./failure.ts";

export const OPENAI_DECISIONS_ENDPOINT = "https://api.openai.com/v1/decisions";
export const OPENAI_DECISIONS_MODEL = "gpt-6-luna";

interface DecisionsPredicateQuestion {
  instructions: string;
  name: string;
  type: "predicate";
}

interface DecisionsScoreLevel {
  description: string;
  label: string;
}

export interface DecisionsScoreQuestion {
  instructions: string;
  levels: DecisionsScoreLevel[];
  name: string;
  type: "score";
}

export type DecisionsQuestion =
  DecisionsPredicateQuestion | DecisionsScoreQuestion;

export interface DecisionsRequest {
  input: string;
  model: typeof OPENAI_DECISIONS_MODEL;
  questions: DecisionsQuestion[];
}

const formatEntry = (entry: EntryType | undefined): string => {
  if (isString(entry)) {
    return entry;
  }

  return entry === undefined ? "" : JSON.stringify(entry);
};

const predicateInstructions = (question: Questions[string]): string => {
  const parts = [formatEntry(question.instructions)];

  if (question.type === "noul") {
    if (question.criteria?.true !== undefined) {
      parts.push(`A true answer means: ${formatEntry(question.criteria.true)}`);
    }

    if (question.criteria?.false !== undefined) {
      parts.push(
        `A false answer means: ${formatEntry(question.criteria.false)}`
      );
    }
  }

  return parts.filter(Boolean).join("\n\n");
};

const scoreLevelLabel = (description: EntryType, index: number): string => {
  const text = formatEntry(description);
  const colon = text.indexOf(":");
  const label = (colon === -1 ? text : text.slice(0, colon)).trim();

  return label || `Level ${index}`;
};

const decisionQuestion = (
  name: string,
  question: Questions[string]
): DecisionsQuestion => {
  if (question.type === "noul") {
    return {
      instructions: predicateInstructions(question),
      name,
      type: "predicate",
    };
  }

  if (question.type === "score") {
    const labels = new Set<string>();

    const levels = question.criteria.map((description, index) => {
      const label = scoreLevelLabel(description, index);

      if (labels.has(label)) {
        throw new JevFailureError(
          "malformed",
          `Jev score question ${name} has duplicate level labels.`
        );
      }

      labels.add(label);

      return { description: formatEntry(description), label };
    });

    return {
      instructions: formatEntry(question.instructions),
      levels,
      name,
      type: "score",
    };
  }

  throw new JevFailureError(
    "malformed",
    `Jev question ${name} has an unsupported type.`
  );
};

export const formatDecisionsInput = (state: EntryType): string => {
  if (isString(state)) {
    return state;
  }

  return JSON.stringify(state, null, 2);
};

export const buildDecisionsRequest = (
  state: EntryType,
  questions: Questions
): DecisionsRequest => {
  if (!isRecordOf(questions) || Object.keys(questions).length === 0) {
    throw new JevFailureError("malformed", "Jev questions are empty.");
  }

  return {
    input: formatDecisionsInput(state),
    model: OPENAI_DECISIONS_MODEL,
    questions: Object.entries(questions).map(([name, question]) =>
      decisionQuestion(name, question)
    ),
  };
};
