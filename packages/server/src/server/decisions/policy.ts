import type { DecisionAnswer, DecisionQuestion } from "./engine.js";

export type DecisionDisposition =
  | { kind: "allow" }
  | { kind: "deny" }
  | { kind: "review" }
  | { kind: "route"; target: string };

export interface DecisionDefinition {
  id: string;
  version: string;
  policyVersion: string;
  questions: Record<string, DecisionQuestion>;
  resolve(
    answers: Readonly<Record<string, DecisionAnswer>>,
    minimumConfidence: number,
  ): DecisionDisposition;
}

const AGENT_CREATE_QUESTION = "disposition";

export const AGENT_CREATE_DECISION: DecisionDefinition = {
  id: "tool.create_agent",
  version: "1",
  policyVersion: "1",
  questions: {
    [AGENT_CREATE_QUESTION]: {
      type: "choice",
      instructions:
        "Decide whether Paseo should autonomously execute this create_agent operation based on its boundedness, clarity, and risk.",
      criteria: {
        allow:
          "The request is clear, bounded, and ordinary enough to create the agent autonomously.",
        review:
          "The request is ambiguous, unusually broad, sensitive, privileged, or otherwise warrants human review before creating the agent.",
        deny: "The request clearly asks for a destructive or disallowed delegation that should not create an agent.",
      },
    },
  },
  resolve(answers, minimumConfidence) {
    const answer = answers[AGENT_CREATE_QUESTION];
    if (!answer || answer.type !== "choice") {
      return { kind: "review" };
    }
    if (answer.confidence < minimumConfidence) {
      return { kind: "review" };
    }
    if (answer.choice === "allow") {
      return { kind: "allow" };
    }
    if (answer.choice === "deny") {
      return { kind: "deny" };
    }
    return { kind: "review" };
  },
};
