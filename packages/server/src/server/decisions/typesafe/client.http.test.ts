import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, test } from "vitest";

import type { DecisionRequest } from "../engine.js";
import { createTypeSafeDecisionEngine } from "./client.js";

interface RunningServer {
  baseUrl: string;
  close(): Promise<void>;
}

const servers: RunningServer[] = [];

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<RunningServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP test server address");
  }
  const running: RunningServer = {
    baseUrl: "http://127.0.0.1:" + address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
  servers.push(running);
  return running;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

const decision: DecisionRequest = {
  state: {
    title: "Inspect CI",
    provider: "codex/gpt-5.6",
    initialPrompt: "Find the failing test",
  },
  model: "jev-pinned-test",
  questions: {
    disposition: {
      type: "choice",
      criteria: {
        allow: null,
        review: null,
        deny: null,
      },
    },
  },
};

describe("TypeSafe local HTTP integration", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  test("posts System One requests and parses a real HTTP response", async () => {
    let receivedAuthorization: string | undefined;
    let receivedBody: unknown;
    const server = await startServer(async (request, response) => {
      receivedAuthorization = request.headers.authorization;
      receivedBody = JSON.parse(await readBody(request));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: "jev-pinned-test",
          answers: {
            disposition: {
              type: "choice",
              choice: "allow",
              confidence: 0.97,
              probabilities: {
                allow: 0.97,
                review: 0.02,
                deny: 0.01,
              },
            },
          },
          usage: {
            input_tokens: 25,
            output_tokens: 4,
          },
        }),
      );
    });

    const engine = createTypeSafeDecisionEngine({
      apiKey: "local-test-key",
      baseUrl: server.baseUrl,
    });

    await expect(
      engine.evaluate(decision, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      engine: "typesafe-jev",
      model: "jev-pinned-test",
      answers: {
        disposition: {
          type: "choice",
          choice: "allow",
          confidence: 0.97,
        },
      },
    });
    expect(receivedAuthorization).toBe("Bearer local-test-key");
    expect(receivedBody).toEqual(decision);
  });

  test("fetches model discovery over local HTTP", async () => {
    const server = await startServer((request, response) => {
      expect(request.url).toBe("/v1/models");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          models: [
            {
              name: "jev-pinned-test",
              description: "Pinned model",
              release_date: "2026-09-15",
            },
          ],
        }),
      );
    });

    const engine = createTypeSafeDecisionEngine({
      apiKey: "local-test-key",
      baseUrl: server.baseUrl,
    });

    await expect(engine.listModels({ signal: new AbortController().signal })).resolves.toEqual([
      {
        name: "jev-pinned-test",
        description: "Pinned model",
        release_date: "2026-09-15",
      },
    ]);
  });
});
