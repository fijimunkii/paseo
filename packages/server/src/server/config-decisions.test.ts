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

  test("loads an explicit TypeSafe opt-in and resolves the API key from the environment", async () => {
    const home = await createPaseoHome({
      version: 1,
      decisions: {
        typesafe: {
          enabled: true,
          model: "jev-1.13.0",
        },
      },
    });

    const config = loadConfig(home, {
      env: { TYPESAFE_API_KEY: "typesafe-secret" },
    });

    expect(config.decisions).toEqual({
      typesafe: {
        enabled: true,
        baseUrl: "https://api.typesafe.ai",
        model: "jev-1.13.0",
        timeoutMs: 10_000,
        maxConcurrency: 4,
        apiKey: "typesafe-secret",
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
      typesafe: {
        enabled: true,
        baseUrl: "https://api.typesafe.ai",
        model: "jev-latest",
        timeoutMs: 10_000,
        maxConcurrency: 4,
      },
    });
  });
});
