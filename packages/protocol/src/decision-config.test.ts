import { describe, expect, test } from "vitest";

import {
  CreateAgentToolDecisionPolicyConfigSchema,
  DecisionConfigSchema,
  OrchestrationDecisionPolicyConfigSchema,
  TypeSafeDecisionConfigSchema,
} from "./decision-config.js";

describe("decision config", () => {
  test("defaults TypeSafe transport settings without enabling it", () => {
    expect(TypeSafeDecisionConfigSchema.parse({})).toEqual({
      enabled: false,
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      timeoutMs: 10_000,
      maxConcurrency: 4,
    });
  });

  test("defaults policy execution to shadow and agent creation to disabled", () => {
    expect(DecisionConfigSchema.parse({})).toEqual({
      mode: "shadow",
      policies: {},
    });
    expect(CreateAgentToolDecisionPolicyConfigSchema.parse({})).toEqual({
      enabled: false,
      minimumConfidence: 0.9,
      failureDisposition: "review",
    });
  });

  test("defaults orchestration to disabled manual routing", () => {
    expect(OrchestrationDecisionPolicyConfigSchema.parse({})).toEqual({
      enabled: false,
      minimumConfidence: 0.85,
      failureDisposition: "review",
      defaultRouting: "manual",
      maxAttempts: 3,
      maxEscalations: 1,
    });
  });

  test("requires complete execution lanes when orchestration is enabled", () => {
    expect(
      OrchestrationDecisionPolicyConfigSchema.safeParse({
        enabled: true,
      }).success,
    ).toBe(false);

    expect(
      OrchestrationDecisionPolicyConfigSchema.parse({
        enabled: true,
        lanes: {
          small: { provider: "codex", model: "fast", thinkingOptionId: "low" },
          medium: { provider: "codex", model: "fast", thinkingOptionId: "medium" },
          high: { provider: "codex", model: "fast", thinkingOptionId: "high" },
          escalated: { provider: "codex", model: "strong", thinkingOptionId: "high" },
        },
      }),
    ).toMatchObject({
      enabled: true,
      defaultRouting: "manual",
      lanes: {
        small: { provider: "codex", model: "fast", thinkingOptionId: "low" },
        escalated: { provider: "codex", model: "strong", thinkingOptionId: "high" },
      },
    });
  });

  test("accepts explicit policy and connection settings without accepting credentials", () => {
    expect(
      DecisionConfigSchema.parse({
        mode: "enforce",
        typesafe: {
          enabled: true,
          baseUrl: "https://typesafe.example.test",
          model: "jev-pinned-test",
          timeoutMs: 5_000,
          maxConcurrency: 2,
        },
        policies: {
          createAgentTool: {
            enabled: true,
            minimumConfidence: 0.95,
            failureDisposition: "deny",
          },
        },
      }),
    ).toEqual({
      mode: "enforce",
      typesafe: {
        enabled: true,
        baseUrl: "https://typesafe.example.test",
        model: "jev-pinned-test",
        timeoutMs: 5_000,
        maxConcurrency: 2,
      },
      policies: {
        createAgentTool: {
          enabled: true,
          minimumConfidence: 0.95,
          failureDisposition: "deny",
        },
      },
    });

    expect(
      DecisionConfigSchema.safeParse({
        typesafe: {
          enabled: true,
          apiKey: "must-not-be-persisted",
        },
      }).success,
    ).toBe(false);
  });
});
