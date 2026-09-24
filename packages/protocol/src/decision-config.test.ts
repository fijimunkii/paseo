import { describe, expect, test } from "vitest";

import { DecisionConfigSchema, TypeSafeDecisionConfigSchema } from "./decision-config.js";

describe("TypeSafe decision config", () => {
  test("defaults to disabled with the hosted TypeSafe endpoint", () => {
    expect(TypeSafeDecisionConfigSchema.parse({})).toEqual({
      enabled: false,
      baseUrl: "https://api.typesafe.ai",
      model: "jev-latest",
      timeoutMs: 10_000,
      maxConcurrency: 4,
    });
  });

  test("accepts explicit connection settings without accepting credentials", () => {
    expect(
      DecisionConfigSchema.parse({
        typesafe: {
          enabled: true,
          baseUrl: "https://typesafe.example.test",
          model: "jev-1.13.0",
          timeoutMs: 5_000,
          maxConcurrency: 2,
        },
      }),
    ).toEqual({
      typesafe: {
        enabled: true,
        baseUrl: "https://typesafe.example.test",
        model: "jev-1.13.0",
        timeoutMs: 5_000,
        maxConcurrency: 2,
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
