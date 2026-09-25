import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { DecisionAuditStore, type DecisionAuditRecord } from "./audit.js";
import { PRIVATE_FILE_MODE } from "../private-files.js";

const roots: string[] = [];
const MODE_MASK = 0o777;

function record(): DecisionAuditRecord {
  return {
    fingerprint: "c".repeat(64),
    createdAt: "2026-09-24T20:00:00.000Z",
    definitionId: "tool.create_agent",
    definitionVersion: "1",
    definitionHash: "d".repeat(64),
    policyVersion: "1",
    policyHash: "e".repeat(64),
    requestedModel: "jev-pinned-test",
    model: "jev-pinned-test",
    mode: "shadow",
    status: "resolved",
    wouldDisposition: { kind: "deny" },
    actualDisposition: { kind: "allow" },
    answers: {
      disposition: {
        type: "choice",
        choice: "deny",
        confidence: 0.99,
      },
    },
    usage: {
      inputTokens: 20,
      outputTokens: 4,
    },
    latencyMs: 42,
    context: {
      agentId: "agent-parent",
      tool: "create_agent",
    },
  };
}

describe("DecisionAuditStore", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists decision metadata without operation state", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-decision-audit-"));
    roots.push(root);
    const store = new DecisionAuditStore(root);
    const input = record();

    store.put(input);

    expect(store.get(input.fingerprint)).toEqual(input);
    const filePath = path.join(root, "decisions", input.fingerprint + ".json");
    const raw = readFileSync(filePath, "utf8");
    expect(raw).not.toContain("initialPrompt");
    expect(raw).not.toContain("operation");
    expect(raw).not.toContain("state");
    expect(raw).not.toContain("apiKey");
    if (process.platform !== "win32") {
      expect(statSync(filePath).mode & MODE_MASK).toBe(PRIVATE_FILE_MODE);
    }
  });
});
