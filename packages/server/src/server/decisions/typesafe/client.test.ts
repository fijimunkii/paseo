import { describe, expect, test } from "vitest";

import type { DecisionRequest } from "../engine.js";
import { createTypeSafeDecisionEngine, TypeSafeDecisionError } from "./client.js";

const request: DecisionRequest = {
  state: { command: "npm test", risk: "low" },
  model: "jev-pinned-test",
  questions: {
    allowed: {
      type: "noul",
      instructions: "Should this operation be allowed?",
    },
    action: {
      type: "choice",
      instructions: "How should Paseo handle this operation?",
      criteria: {
        allow: null,
        review: null,
        deny: null,
      },
    },
    risk: {
      type: "score",
      instructions: "How risky is this operation?",
      criteria: ["low", "medium", "high"],
    },
  },
};

function successPayload() {
  return {
    model: "jev-pinned-test",
    answers: {
      allowed: { type: "noul", noul: 0.92 },
      action: {
        type: "choice",
        choice: "allow",
        confidence: 0.8,
        probabilities: {
          allow: 0.8,
          review: 0.15,
          deny: 0.05,
        },
      },
      risk: {
        type: "score",
        score: 0.4,
        confidence: 0.7,
        legend: {
          "0": "low",
          "1": "medium",
          "2": "high",
        },
        probabilities: {
          "0": 0.65,
          "1": 0.3,
          "2": 0.05,
        },
      },
    },
    usage: {
      input_tokens: 42,
      output_tokens: 9,
    },
  };
}

describe("TypeSafe decision engine", () => {
  test("maps typed System One answers into Paseo decision results", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;

    async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify(successPayload()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const engine = createTypeSafeDecisionEngine({
      apiKey: "test-secret",
      fetch: fakeFetch,
    });

    const result = await engine.evaluate(request, {
      signal: new AbortController().signal,
    });

    expect(requestUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(requestInit?.method).toBe("POST");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe("Bearer test-secret");
    expect(JSON.parse(String(requestInit?.body))).toEqual(request);
    expect(result).toEqual({
      engine: "typesafe-jev",
      model: "jev-pinned-test",
      answers: {
        allowed: { type: "noul", probability: 0.92 },
        action: {
          type: "choice",
          choice: "allow",
          confidence: 0.8,
          probabilities: {
            allow: 0.8,
            review: 0.15,
            deny: 0.05,
          },
        },
        risk: {
          type: "score",
          score: 0.4,
          confidence: 0.7,
          probabilities: {
            "0": 0.65,
            "1": 0.3,
            "2": 0.05,
          },
        },
      },
      usage: {
        inputTokens: 42,
        outputTokens: 9,
      },
    });
  });

  test("rejects answers that do not match the requested criteria", async () => {
    const payload = successPayload();
    const invalidPayload = {
      ...payload,
      answers: {
        ...payload.answers,
        action: {
          ...payload.answers.action,
          probabilities: {
            allow: 0.8,
            review: 0.2,
          },
        },
      },
    };

    async function fakeFetch(): Promise<Response> {
      return new Response(JSON.stringify(invalidPayload), { status: 200 });
    }

    const engine = createTypeSafeDecisionEngine({
      apiKey: "test-secret",
      fetch: fakeFetch,
    });

    await expect(
      engine.evaluate(request, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      name: "TypeSafeDecisionError",
      kind: "invalid_response",
    });
  });

  test("does not expose credentials or response bodies in HTTP errors", async () => {
    const apiKey = "super-secret-typesafe-key";

    async function fakeFetch(): Promise<Response> {
      return new Response(
        JSON.stringify({
          error: "upstream echoed " + apiKey,
        }),
        { status: 401 },
      );
    }

    const engine = createTypeSafeDecisionEngine({
      apiKey,
      fetch: fakeFetch,
    });

    let thrown: unknown;
    try {
      await engine.evaluate(request, { signal: new AbortController().signal });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TypeSafeDecisionError);
    expect(thrown).toMatchObject({
      kind: "http",
      status: 401,
      message: "TypeSafe API request failed with HTTP 401",
    });
    expect(String(thrown)).not.toContain(apiKey);
    expect(JSON.stringify(thrown)).not.toContain(apiKey);
  });

  test("turns timeout aborts into a typed error without retrying the request", async () => {
    let calls = 0;

    async function hangingFetch(
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    }

    const engine = createTypeSafeDecisionEngine({
      apiKey: "test-secret",
      timeoutMs: 5,
      fetch: hangingFetch,
    });

    await expect(
      engine.evaluate(request, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      kind: "timeout",
    });
    expect(calls).toBe(1);
  });

  test("turns caller cancellation into a typed error without retrying the request", async () => {
    let calls = 0;
    const controller = new AbortController();

    async function hangingFetch(
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
        controller.abort();
      });
    }

    const engine = createTypeSafeDecisionEngine({
      apiKey: "test-secret",
      fetch: hangingFetch,
    });

    await expect(engine.evaluate(request, { signal: controller.signal })).rejects.toMatchObject({
      kind: "aborted",
    });
    expect(calls).toBe(1);
  });

  test("lists and validates models", async () => {
    async function fakeFetch(): Promise<Response> {
      return new Response(
        JSON.stringify({
          models: [
            {
              name: "jev-pinned-test",
              description: "Pinned Jev release",
              release_date: "2026-09-15",
              tags: ["internal"],
            },
          ],
        }),
        { status: 200 },
      );
    }

    const engine = createTypeSafeDecisionEngine({
      apiKey: "test-secret",
      fetch: fakeFetch,
    });

    await expect(engine.listModels({ signal: new AbortController().signal })).resolves.toEqual([
      {
        name: "jev-pinned-test",
        description: "Pinned Jev release",
        release_date: "2026-09-15",
        tags: ["internal"],
      },
    ]);
  });

  test("rejects TypeSafe base URLs with embedded credentials", () => {
    expect(() =>
      createTypeSafeDecisionEngine({
        apiKey: "test-secret",
        baseUrl: "https://user:password@typesafe.example.test",
      }),
    ).toThrowError(TypeSafeDecisionError);
  });

  test("rejects insecure non-local TypeSafe base URLs", () => {
    expect(() =>
      createTypeSafeDecisionEngine({
        apiKey: "test-secret",
        baseUrl: "http://typesafe.example.test",
      }),
    ).toThrowError(TypeSafeDecisionError);
  });
});
