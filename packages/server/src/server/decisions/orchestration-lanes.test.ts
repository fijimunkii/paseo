import { describe, expect, test, vi } from "vitest";

import type { OrchestrationDecisionPolicyConfig } from "@getpaseo/protocol/decision-config";
import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import {
  resolveOrchestrationLane,
  type OrchestrationProviderCatalog,
} from "./orchestration-lanes.js";

const policy: OrchestrationDecisionPolicyConfig = {
  enabled: true,
  minimumConfidence: 0.85,
  failureDisposition: "review",
  defaultRouting: "manual",
  maxAttempts: 3,
  maxEscalations: 1,
  lanes: {
    small: { provider: "codex", model: "fast", thinkingOptionId: "low" },
    medium: { provider: "codex", model: "fast", thinkingOptionId: "medium" },
    high: { provider: "codex", model: "fast", thinkingOptionId: "high" },
    escalated: { provider: "codex", model: "strong", thinkingOptionId: "high" },
  },
};

function providerEntry(): ProviderSnapshotEntry {
  return {
    provider: "codex",
    status: "ready",
    enabled: true,
    models: [
      {
        provider: "codex",
        id: "fast",
        label: "Fast",
        thinkingOptions: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
      {
        provider: "codex",
        id: "strong",
        label: "Strong",
        thinkingOptions: [{ id: "high", label: "High" }],
      },
    ],
  };
}

function catalog(entry: ProviderSnapshotEntry): OrchestrationProviderCatalog {
  return {
    getProvider: vi.fn(async () => entry),
  };
}

describe("resolveOrchestrationLane", () => {
  test("resolves a configured lane against the live provider catalog", async () => {
    const result = await resolveOrchestrationLane({
      policy,
      laneId: "medium",
      providerCatalog: catalog(providerEntry()),
      cwd: "/repo",
    });

    expect(result).toEqual({
      laneId: "medium",
      provider: "codex",
      model: "fast",
      thinkingOptionId: "medium",
    });
  });

  test("rejects an unavailable configured model", async () => {
    const entry = providerEntry();
    entry.models = entry.models?.filter((model) => model.id !== "strong");

    await expect(
      resolveOrchestrationLane({
        policy,
        laneId: "escalated",
        providerCatalog: catalog(entry),
      }),
    ).rejects.toThrow("unavailable model 'strong'");
  });

  test("rejects an unavailable configured thinking option", async () => {
    const entry = providerEntry();
    const fast = entry.models?.find((model) => model.id === "fast");
    if (!fast) {
      throw new Error("Expected fast model fixture");
    }
    fast.thinkingOptions = fast.thinkingOptions?.filter((option) => option.id !== "high");

    await expect(
      resolveOrchestrationLane({
        policy,
        laneId: "high",
        providerCatalog: catalog(entry),
      }),
    ).rejects.toThrow("unavailable thinking option 'high'");
  });

  test("rejects disabled providers instead of falling back", async () => {
    const entry = providerEntry();
    entry.enabled = false;

    await expect(
      resolveOrchestrationLane({
        policy,
        laneId: "small",
        providerCatalog: catalog(entry),
      }),
    ).rejects.toThrow("disabled provider 'codex'");
  });
});
