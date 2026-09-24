import type {
  DecisionAnswer,
  DecisionQuestion,
} from "./engine.js";

export type DecisionDisposition =
  | { kind: "allow" }
  | { kind: "deny" }
  | { kind: "review" }
  | { kind: "route"; target: string };

export interface DecisionDefinition {
  id: string;
  version: string;
  questions: Record<string, DecisionQuestion>;
  resolve(
    answers: Readonly<Record<string, DecisionAnswer>>,
    minimumConfidence: number,
  ): DecisionDisposition;
}

const AGENT_CREATE_QUESTION = "disposition";

export const AGENT_CREATE_DECISION: DecisionDefinition = {
  id: "agent.create",
  version: "1",
  questions: {
    [AGENT_CREATE_QUESTION]: {
      type: "choice",
      instructions:
        "Decide whether Paseo should allow this proposed agent creation based on the supplied operation state.",
      criteria: {
        allow:
          "The proposed agent creation is within scope and can proceed autonomously.",
        review:
          "The proposal is ambiguous, unusually broad, or should require human review before proceeding.",
        deny:
          "The proposed agent creation is clearly outside scope or should not proceed.",
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
