import { describe, expect, test } from "vitest";

import { ORCHESTRATION_CHECKPOINT_DECISION, ORCHESTRATION_TASK_DECISION } from "./policy.js";

describe("orchestration decision definitions", () => {
  test("routes a clear small task to the small lane", () => {
    expect(
      ORCHESTRATION_TASK_DECISION.resolve(
        {
          complexity: {
            type: "choice",
            choice: "small",
            confidence: 0.95,
            probabilities: {
              small: 0.95,
              medium: 0.03,
              high: 0.01,
              architectural: 0.01,
            },
          },
          requirementsAmbiguous: { type: "noul", probability: 0.05 },
          needsStrongReasoning: { type: "noul", probability: 0.1 },
        },
        0.85,
      ),
    ).toEqual({ kind: "route", target: "small" });
  });

  test("escalates a task when strong reasoning is independently warranted", () => {
    expect(
      ORCHESTRATION_TASK_DECISION.resolve(
        {
          complexity: {
            type: "choice",
            choice: "medium",
            confidence: 0.9,
            probabilities: {
              small: 0.05,
              medium: 0.9,
              high: 0.04,
              architectural: 0.01,
            },
          },
          requirementsAmbiguous: { type: "noul", probability: 0.05 },
          needsStrongReasoning: { type: "noul", probability: 0.95 },
        },
        0.85,
      ),
    ).toEqual({ kind: "route", target: "escalated" });
  });

  test("reviews materially ambiguous task routing", () => {
    expect(
      ORCHESTRATION_TASK_DECISION.resolve(
        {
          complexity: {
            type: "choice",
            choice: "high",
            confidence: 0.95,
            probabilities: {
              small: 0.01,
              medium: 0.02,
              high: 0.95,
              architectural: 0.02,
            },
          },
          requirementsAmbiguous: { type: "noul", probability: 0.9 },
          needsStrongReasoning: { type: "noul", probability: 0.2 },
        },
        0.85,
      ),
    ).toEqual({ kind: "review" });
  });

  test("maps a confident checkpoint answer to a loop directive", () => {
    expect(
      ORCHESTRATION_CHECKPOINT_DECISION.resolve(
        {
          nextAction: {
            type: "choice",
            choice: "complete",
            confidence: 0.93,
            probabilities: {
              continue: 0.01,
              retry: 0.01,
              verify: 0.02,
              escalate: 0.01,
              complete: 0.93,
              review: 0.02,
            },
          },
          needsHumanReview: { type: "noul", probability: 0.05 },
        },
        0.85,
      ),
    ).toEqual({ kind: "route", target: "complete" });
  });

  test("reviews low-confidence checkpoint answers", () => {
    expect(
      ORCHESTRATION_CHECKPOINT_DECISION.resolve(
        {
          nextAction: {
            type: "choice",
            choice: "retry",
            confidence: 0.6,
            probabilities: {
              continue: 0.1,
              retry: 0.6,
              verify: 0.1,
              escalate: 0.1,
              complete: 0.05,
              review: 0.05,
            },
          },
          needsHumanReview: { type: "noul", probability: 0.05 },
        },
        0.85,
      ),
    ).toEqual({ kind: "review" });
  });
});
