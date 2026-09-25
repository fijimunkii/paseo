import { describe, expect, test, vi } from "vitest";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

import {
  AgentCreateDecisionError,
  enforceAgentCreateDecision,
  type AgentCreateDecisionGate,
} from "./agent-create-gate.js";

const request = {
  provider: "codex/gpt-5.6",
  title: "Investigate",
  initialPrompt: "Inspect the failing test",
} satisfies JsonValue;

function gateWithAuthorization(
  authorization: Awaited<ReturnType<AgentCreateDecisionGate["authorizeAgentCreate"]>>,
) {
  return {
    authorizeAgentCreate: vi.fn().mockResolvedValue(authorization),
    consumeAgentCreatePermit: vi.fn(),
  };
}

describe("enforceAgentCreateDecision", () => {
  test("does nothing without a configured decision service", async () => {
    await expect(
      enforceAgentCreateDecision({
        service: undefined,
        request,
        signal: new AbortController().signal,
      }),
    ).resolves.toBeUndefined();
  });

  test("does not invoke the decision service for an already canceled call", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller canceled"));
    const gate = gateWithAuthorization(null);

    await expect(
      enforceAgentCreateDecision({
        service: gate,
        request,
        signal: controller.signal,
      }),
    ).rejects.toThrow("caller canceled");
    expect(gate.authorizeAgentCreate).not.toHaveBeenCalled();
  });

  test("stops after evaluation when the caller cancels before permit consumption", async () => {
    const controller = new AbortController();
    const permit = {
      id: "permit-late-cancel",
      decisionFingerprint: "f".repeat(64),
      operationFingerprint: "1".repeat(64),
      model: "jev-pinned-test",
      disposition: "allow" as const,
      expiresAt: Date.now() + 60_000,
    };
    const gate = {
      authorizeAgentCreate: vi.fn().mockImplementation(async () => {
        controller.abort(new Error("late cancel"));
        return {
          fingerprint: permit.decisionFingerprint,
          mode: "enforce" as const,
          actualDisposition: { kind: "allow" as const },
          wouldDisposition: { kind: "allow" as const },
          reused: false,
          permit,
        };
      }),
      consumeAgentCreatePermit: vi.fn(),
    };

    await expect(
      enforceAgentCreateDecision({
        service: gate,
        request,
        signal: controller.signal,
      }),
    ).rejects.toThrow("late cancel");
    expect(gate.consumeAgentCreatePermit).not.toHaveBeenCalled();
  });

  test("allows shadow execution while consuming the exact-operation permit", async () => {
    const permit = {
      id: "permit-1",
      decisionFingerprint: "a".repeat(64),
      operationFingerprint: "2".repeat(64),
      model: null,
      disposition: "allow" as const,
      expiresAt: Date.now() + 60_000,
    };
    const gate = gateWithAuthorization({
      fingerprint: permit.decisionFingerprint,
      mode: "shadow",
      actualDisposition: { kind: "allow" },
      wouldDisposition: { kind: "deny" },
      reused: false,
      permit,
    });

    await enforceAgentCreateDecision({
      service: gate,
      request,
      callerAgentId: "agent-parent",
      signal: new AbortController().signal,
    });

    const operation = {
      tool: "create_agent",
      callerAgentId: "agent-parent",
      request,
    };
    expect(gate.authorizeAgentCreate).toHaveBeenCalledWith({
      operation,
      state: {
        title: "Investigate",
        provider: "codex/gpt-5.6",
        initialPrompt: "Inspect the failing test",
      },
      context: {
        agentId: "agent-parent",
        tool: "create_agent",
      },
      signal: expect.any(AbortSignal),
    });
    expect(gate.consumeAgentCreatePermit).toHaveBeenCalledWith(permit, operation);
  });

  test("does not send passthrough fields, labels, or arbitrary feature values to Jev", async () => {
    const gate = gateWithAuthorization(null);
    const requestWithExtra = {
      ...request,
      labels: { sensitivity: "internal" },
      settings: {
        thinkingOptionId: "high",
        features: { privateFeaturePayload: "do-not-send" },
      },
      arbitrarySecret: "do-not-send",
    } satisfies JsonValue;

    await enforceAgentCreateDecision({
      service: gate,
      request: requestWithExtra,
      signal: new AbortController().signal,
    });

    expect(gate.authorizeAgentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        state: {
          title: "Investigate",
          provider: "codex/gpt-5.6",
          initialPrompt: "Inspect the failing test",
          settings: {
            thinkingOptionId: "high",
          },
        },
      }),
    );
  });

  test("blocks deny before a permit can be consumed", async () => {
    const gate = gateWithAuthorization({
      fingerprint: "b".repeat(64),
      mode: "enforce",
      actualDisposition: { kind: "deny" },
      wouldDisposition: { kind: "deny" },
      reused: false,
      permit: null,
    });

    await expect(
      enforceAgentCreateDecision({
        service: gate,
        request,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      name: "AgentCreateDecisionError",
      kind: "deny",
    });
    expect(gate.consumeAgentCreatePermit).not.toHaveBeenCalled();
  });

  test("blocks review and route dispositions as human-review-required", async () => {
    for (const actualDisposition of [
      { kind: "review" as const },
      { kind: "route" as const, target: "other-agent" },
    ]) {
      const gate = gateWithAuthorization({
        fingerprint: "c".repeat(64),
        mode: "enforce",
        actualDisposition,
        wouldDisposition: actualDisposition,
        reused: false,
        permit: null,
      });

      let thrown: unknown;
      try {
        await enforceAgentCreateDecision({
          service: gate,
          request,
          signal: new AbortController().signal,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AgentCreateDecisionError);
      expect(thrown).toMatchObject({ kind: "review" });
      expect(gate.consumeAgentCreatePermit).not.toHaveBeenCalled();
    }
  });
});
