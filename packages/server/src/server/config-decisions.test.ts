import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-decisions-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon decision config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("does not activate TypeSafe from credentials alone", async () => {
    const home = await createPaseoHome({ version: 1 });

    const config = loadConfig(home, {
      env: { TYPESAFE_API_KEY: "secret-without-opt-in" },
    });

    expect(config.decisions).toBeUndefined();
  });

  test("loads explicit shadow policy config and resolves the API key from the environment", async () => {
    const home = await createPaseoHome({
      version: 1,
      decisions: {
        mode: "shadow",
        typesafe: {
          enabled: true,
          model: "jev-latest",
        },
        policies: {
          agentCreate: {
            enabled: true,
          },
        },
      },
    });

    const config = loadConfig(home, {
      env: { TYPESAFE_API_KEY: "typesafe-secret" },
    });

    expect(config.decisions).toEqual({
      mode: "shadow",
      typesafe: {
        enabled: true,
        baseUrl: "https://api.typesafe.ai",
        model: "jev-latest",
        timeoutMs: 10_000,
        maxConcurrency: 4,
        apiKey: "typesafe-secret",
      },
      policies: {
        agentCreate: {
          enabled: true,
          minimumConfidence: 0.9,
          failureDisposition: "review",
        },
      },
    });
  });

  test("keeps an opted-in decision engine uncredentialed when the environment key is absent", async () => {
    const home = await createPaseoHome({
      version: 1,
      decisions: {
        typesafe: {
          enabled: true,
        },
      },
    });

    expect(loadConfig(home, { env: {} }).decisions).toEqual({
      mode: "shadow",
      typesafe: {
        enabled: true,
        baseUrl: "https://api.typesafe.ai",
        model: "jev-latest",
        timeoutMs: 10_000,
        maxConcurrency: 4,
      },
      policies: {},
    });
  });

  test("rejects moving model aliases for enabled enforcement policies", async () => {
    const home = await createPaseoHome({
      version: 1,
      decisions: {
        mode: "enforce",
        typesafe: {
          enabled: true,
          model: "jev-latest",
        },
        policies: {
          agentCreate: {
            enabled: true,
          },
        },
      },
    });

    expect(() => loadConfig(home, { env: { TYPESAFE_API_KEY: "typesafe-secret" } })).toThrow(
      "Enforced decisions require a pinned TypeSafe model",
    );
  });

  test("accepts a pinned model for enforcement", async () => {
    const home = await createPaseoHome({
      version: 1,
      decisions: {
        mode: "enforce",
        typesafe: {
          enabled: true,
          model: "jev-1.13.0",
        },
        policies: {
          agentCreate: {
            enabled: true,
            minimumConfidence: 0.95,
            failureDisposition: "deny",
          },
        },
      },
    });

    expect(loadConfig(home, { env: { TYPESAFE_API_KEY: "typesafe-secret" } }).decisions).toMatchObject({
      mode: "enforce",
      typesafe: {
        model: "jev-1.13.0",
        apiKey: "typesafe-secret",
      },
      policies: {
        agentCreate: {
          enabled: true,
          minimumConfidence: 0.95,
          failureDisposition: "deny",
        },
      },
    });
  });
});
