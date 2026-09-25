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

const TASK_COMPLEXITY_QUESTION = "complexity";
const TASK_AMBIGUITY_QUESTION = "requirementsAmbiguous";
const TASK_STRONG_REASONING_QUESTION = "needsStrongReasoning";

export const ORCHESTRATION_TASK_DECISION: DecisionDefinition = {
  id: "orchestration.task",
  version: "1",
  policyVersion: "1",
  questions: {
    [TASK_COMPLEXITY_QUESTION]: {
      type: "choice",
      instructions:
        "Classify the software-engineering task by the minimum reasoning lane likely sufficient to complete it reliably.",
      criteria: {
        small:
          "Localized, straightforward work with low uncertainty and little cross-cutting impact.",
        medium:
          "Moderate implementation work requiring multiple steps or some non-trivial reasoning, but no major architectural uncertainty.",
        high:
          "Cross-cutting, difficult, security-sensitive, or otherwise complex work that benefits from sustained high reasoning.",
        architectural:
          "The task has substantial architectural uncertainty or broad system-level consequences and warrants the strongest configured reasoning lane.",
      },
    },
    [TASK_AMBIGUITY_QUESTION]: {
      type: "noul",
      instructions:
        "Is the request materially ambiguous such that autonomous model/reasoning routing should pause for review rather than guess the intended scope?",
    },
    [TASK_STRONG_REASONING_QUESTION]: {
      type: "noul",
      instructions:
        "Even if the task is not broadly architectural, is there a strong reason to use the strongest configured reasoning lane?",
    },
  },
  resolve(answers, minimumConfidence) {
    const complexity = answers[TASK_COMPLEXITY_QUESTION];
    const ambiguity = answers[TASK_AMBIGUITY_QUESTION];
    const strongReasoning = answers[TASK_STRONG_REASONING_QUESTION];

    if (!complexity || complexity.type !== "choice") {
      return { kind: "review" };
    }
    if (!ambiguity || ambiguity.type !== "noul") {
      return { kind: "review" };
    }
    if (!strongReasoning || strongReasoning.type !== "noul") {
      return { kind: "review" };
    }
    if (complexity.confidence < minimumConfidence || ambiguity.probability >= minimumConfidence) {
      return { kind: "review" };
    }
    if (
      strongReasoning.probability >= minimumConfidence ||
      complexity.choice === "architectural"
    ) {
      return { kind: "route", target: "escalated" };
    }
    if (complexity.choice === "high") {
      return { kind: "route", target: "high" };
    }
    if (complexity.choice === "medium") {
      return { kind: "route", target: "medium" };
    }
    if (complexity.choice === "small") {
      return { kind: "route", target: "small" };
    }
    return { kind: "review" };
  },
};

const CHECKPOINT_NEXT_ACTION_QUESTION = "nextAction";
const CHECKPOINT_HUMAN_REVIEW_QUESTION = "needsHumanReview";

export const ORCHESTRATION_CHECKPOINT_DECISION: DecisionDefinition = {
  id: "orchestration.checkpoint",
  version: "1",
  policyVersion: "1",
  questions: {
    [CHECKPOINT_NEXT_ACTION_QUESTION]: {
      type: "choice",
      instructions:
        "Given the bounded task state and deterministic evidence, choose the next orchestration action. Do not treat failed deterministic verification as complete.",
      criteria: {
        continue:
          "The current approach is productive but more implementation work remains before verification or completion.",
        retry:
          "The last implementation attempt failed or missed the target, and another attempt at the current lane is likely to help.",
        verify:
          "Implementation appears ready for additional deterministic verification before deciding whether to complete.",
        escalate:
          "Another attempt is warranted but stronger reasoning is justified by repeated failure, uncertainty, sensitivity, or architectural complexity.",
        complete:
          "The requested behavior appears semantically complete, provided all required deterministic verification is already passing.",
        review:
          "Human review is warranted because scope, risk, ambiguity, or evidence is insufficient for autonomous continuation.",
      },
    },
    [CHECKPOINT_HUMAN_REVIEW_QUESTION]: {
      type: "noul",
      instructions:
        "Does the current state warrant human review before Paseo continues autonomously?",
    },
  },
  resolve(answers, minimumConfidence) {
    const nextAction = answers[CHECKPOINT_NEXT_ACTION_QUESTION];
    const humanReview = answers[CHECKPOINT_HUMAN_REVIEW_QUESTION];

    if (!nextAction || nextAction.type !== "choice") {
      return { kind: "review" };
    }
    if (!humanReview || humanReview.type !== "noul") {
      return { kind: "review" };
    }
    if (
      nextAction.confidence < minimumConfidence ||
      humanReview.probability >= minimumConfidence ||
      nextAction.choice === "review"
    ) {
      return { kind: "review" };
    }
    if (
      nextAction.choice === "continue" ||
      nextAction.choice === "retry" ||
      nextAction.choice === "verify" ||
      nextAction.choice === "escalate" ||
      nextAction.choice === "complete"
    ) {
      return { kind: "route", target: nextAction.choice };
    }
    return { kind: "review" };
  },
};

