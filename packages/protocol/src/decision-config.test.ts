import { describe, expect, test } from "vitest";

import {
  AgentCreateDecisionPolicyConfigSchema,
  DecisionConfigSchema,
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
    expect(AgentCreateDecisionPolicyConfigSchema.parse({})).toEqual({
      enabled: false,
      minimumConfidence: 0.9,
      failureDisposition: "review",
    });
  });

  test("accepts explicit policy and connection settings without accepting credentials", () => {
    expect(
      DecisionConfigSchema.parse({
        mode: "enforce",
        typesafe: {
          enabled: true,
          baseUrl: "https://typesafe.example.test",
          model: "jev-1.13.0",
          timeoutMs: 5_000,
          maxConcurrency: 2,
        },
        policies: {
          agentCreate: {
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
        model: "jev-1.13.0",
        timeoutMs: 5_000,
        maxConcurrency: 2,
      },
      policies: {
        agentCreate: {
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
