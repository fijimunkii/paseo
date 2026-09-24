import type { JsonValue } from "@getpaseo/protocol/agent-types";

export type DecisionEntry = string | JsonValue[] | { [key: string]: JsonValue } | null;

interface DecisionQuestionBase {
  instructions?: DecisionEntry;
}

export interface NoulDecisionQuestion extends DecisionQuestionBase {
  type: "noul";
  criteria?: {
    true?: DecisionEntry;
    false?: DecisionEntry;
  } | null;
}

export interface ChoiceDecisionQuestion extends DecisionQuestionBase {
  type: "choice";
  criteria: Record<string, DecisionEntry>;
}

export interface ScoreDecisionQuestion extends DecisionQuestionBase {
  type: "score";
  criteria: readonly [DecisionEntry, DecisionEntry, ...DecisionEntry[]];
}

export type DecisionQuestion =
  | NoulDecisionQuestion
  | ChoiceDecisionQuestion
  | ScoreDecisionQuestion;

export interface DecisionRequest {
  state: DecisionEntry;
  questions: Record<string, DecisionQuestion>;
  model: string;
}

export interface NoulDecisionAnswer {
  type: "noul";
  probability: number;
}

export interface ChoiceDecisionAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreDecisionAnswer {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
}

export type DecisionAnswer =
  | NoulDecisionAnswer
  | ChoiceDecisionAnswer
  | ScoreDecisionAnswer;

export interface DecisionResult {
  engine: string;
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface DecisionEngine {
  readonly id: string;
  evaluate(
    request: DecisionRequest,
    options: { signal: AbortSignal },
  ): Promise<DecisionResult>;
}
