import { describe, expect, test, vi } from "vitest";

import type { OrchestrationDecisionPolicyConfig } from "@getpaseo/protocol/decision-config";
import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import type { DecisionOutcome } from "./service.js";
import { OrchestrationRoutingError, routeOrchestrationTask } from "./orchestration-routing.js";

const policy: OrchestrationDecisionPolicyConfig = {
  enabled: true,
  minimumConfidence: 0.85,
  failureDisposition: "review",
  defaultRouting: "managed",
  maxAttempts: 3,
  maxEscalations: 1,
  lanes: {
    small: { provider: "codex", model: "fast", thinkingOptionId: "low" },
    medium: { provider: "codex", model: "fast", thinkingOptionId: "medium" },
    high: { provider: "codex", model: "fast", thinkingOptionId: "high" },
    escalated: { provider: "codex", model: "strong", thinkingOptionId: "high" },
  },
};

function providerEntry(provider = "codex"): ProviderSnapshotEntry {
  return {
    provider,
    status: "ready",
    enabled: true,
    models: [
      {
        provider,
        id: "fast",
        label: "Fast",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
      {
        provider,
        id: "strong",
        label: "Strong",
        thinkingOptions: [{ id: "high", label: "High" }],
      },
    ],
  };
}

function outcome(input: {
  mode: "shadow" | "enforce";
  would: DecisionOutcome["wouldDisposition"];
  actual: DecisionOutcome["actualDisposition"];
}): DecisionOutcome {
  return {
    fingerprint: "a".repeat(64),
    mode: input.mode,
    model: input.mode === "enforce" ? "jev-pinned-test" : "jev-latest",
    wouldDisposition: input.would,
    actualDisposition: input.actual,
    reused: false,
  };
}

describe("routeOrchestrationTask", () => {
  test("manual routing bypasses Jev even when orchestration is enabled", async () => {
    const assess = vi.fn();
    const result = await routeOrchestrationTask({
      service: {
        getOrchestrationPolicy: () => policy,
        assessOrchestrationTask: assess,
      },
      providerCatalog: {
        getProvider: vi.fn(async () => providerEntry()),
      },
      task: "Implement the feature",
      requestedProvider: "codex",
      requestedModel: "fast",
      requestedRouting: "manual",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({
      routing: "manual",
      outcome: null,
      recommendedLane: null,
      appliedLane: null,
      recommendationError: null,
    });
    expect(assess).not.toHaveBeenCalled();
  });

  test("shadow mode recommends a lane without applying it", async () => {
    const result = await routeOrchestrationTask({
      service: {
        getOrchestrationPolicy: () => policy,
        assessOrchestrationTask: vi.fn(async () =>
          outcome({
            mode: "shadow",
            would: { kind: "route", target: "medium" },
            actual: { kind: "allow" },
          }),
        ),
      },
      providerCatalog: {
        getProvider: vi.fn(async () => providerEntry()),
      },
      task: "Implement the feature",
      requestedProvider: "codex",
      requestedModel: "fast",
      signal: new AbortController().signal,
    });

    expect(result.recommendedLane).toEqual({
      laneId: "medium",
      provider: "codex",
      model: "fast",
      thinkingOptionId: "medium",
    });
    expect(result.appliedLane).toBeNull();
  });

  test("enforce mode applies a validated lane within the requested provider", async () => {
    const result = await routeOrchestrationTask({
      service: {
        getOrchestrationPolicy: () => policy,
        assessOrchestrationTask: vi.fn(async () =>
          outcome({
            mode: "enforce",
            would: { kind: "route", target: "high" },
            actual: { kind: "route", target: "high" },
          }),
        ),
      },
      providerCatalog: {
        getProvider: vi.fn(async () => providerEntry()),
      },
      task: "Refactor the subsystem",
      requestedProvider: "codex",
      requestedModel: "fast",
      signal: new AbortController().signal,
    });

    expect(result.appliedLane).toEqual({
      laneId: "high",
      provider: "codex",
      model: "fast",
      thinkingOptionId: "high",
    });
  });

  test("enforce mode stops when the configured lane would switch providers", async () => {
    const mismatchedPolicy: OrchestrationDecisionPolicyConfig = {
      ...policy,
      lanes: {
        small: { provider: "codex", model: "fast", thinkingOptionId: "low" },
        medium: { provider: "codex", model: "fast", thinkingOptionId: "medium" },
        high: { provider: "claude", model: "fast", thinkingOptionId: "high" },
        escalated: { provider: "codex", model: "strong", thinkingOptionId: "high" },
      },
    };

    await expect(
      routeOrchestrationTask({
        service: {
          getOrchestrationPolicy: () => mismatchedPolicy,
          assessOrchestrationTask: vi.fn(async () =>
            outcome({
              mode: "enforce",
              would: { kind: "route", target: "high" },
              actual: { kind: "route", target: "high" },
            }),
          ),
        },
        providerCatalog: {
          getProvider: vi.fn(async () => providerEntry("claude")),
        },
        task: "Refactor the subsystem",
        requestedProvider: "codex",
        requestedModel: "fast",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject<Partial<OrchestrationRoutingError>>({
      code: "provider_mismatch",
    });
  });

  test("shadow mode records stale lane configuration without blocking execution", async () => {
    const staleProvider = providerEntry();
    staleProvider.models = staleProvider.models?.filter((model) => model.id !== "strong");
    const getProvider = vi.fn(async () => staleProvider);

    const result = await routeOrchestrationTask({
      service: {
        getOrchestrationPolicy: () => policy,
        assessOrchestrationTask: vi.fn(async () =>
          outcome({
            mode: "shadow",
            would: { kind: "route", target: "escalated" },
            actual: { kind: "allow" },
          }),
        ),
      },
      providerCatalog: { getProvider },
      task: "Do difficult work",
      requestedProvider: "codex",
      requestedModel: "fast",
      signal: new AbortController().signal,
    });

    expect(result.appliedLane).toBeNull();
    expect(result.recommendedLane).toBeNull();
    expect(result.recommendationError).toContain("unavailable model 'strong'");
  });
});
