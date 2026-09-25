import pLimit from "p-limit";

import type {
  ChoiceDecisionQuestion,
  DecisionAnswer,
  DecisionEngine,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  ScoreDecisionQuestion,
} from "../engine.js";
import {
  TypeSafeModelsResponseSchema,
  TypeSafeSystemOneResponseSchema,
  type TypeSafeModel,
  type TypeSafeSystemOneResponse,
} from "./schemas.js";

const DEFAULT_BASE_URL = "https://api.typesafe.ai";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENCY = 4;

export type TypeSafeDecisionErrorKind =
  | "invalid_request"
  | "invalid_response"
  | "http"
  | "timeout"
  | "aborted"
  | "network";

export class TypeSafeDecisionError extends Error {
  readonly kind: TypeSafeDecisionErrorKind;
  readonly status: number | null;

  constructor(kind: TypeSafeDecisionErrorKind, message: string, options: { status?: number } = {}) {
    super(message);
    this.name = "TypeSafeDecisionError";
    this.kind = kind;
    this.status = options.status ?? null;
  }
}

export interface TypeSafeDecisionEngineOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxConcurrency?: number;
  fetch?: typeof fetch;
}

export interface TypeSafeDecisionEngine extends DecisionEngine {
  listModels(options: { signal: AbortSignal }): Promise<TypeSafeModel[]>;
}

interface RequestSignal {
  signal: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
}

function createRequestSignal(signal: AbortSignal, timeoutMs: number): RequestSignal {
  const controller = new AbortController();
  let didTimeout = false;

  function abortFromCaller(): void {
    controller.abort(signal.reason);
  }

  if (signal.aborted) {
    abortFromCaller();
  } else {
    signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  const timeout = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abortFromCaller);
    },
  };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  const isLocalhost = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.username || url.password) {
    throw new TypeSafeDecisionError(
      "invalid_request",
      "TypeSafe base URL must not contain embedded credentials",
    );
  }
  if (url.protocol !== "https:" && !isLocalhost) {
    throw new TypeSafeDecisionError(
      "invalid_request",
      "TypeSafe base URL must use HTTPS unless it targets localhost",
    );
  }
  return url.toString().replace(/\/+$/, "");
}

function endpointUrl(baseUrl: string, path: string): string {
  return new URL(path.replace(/^\//, ""), baseUrl + "/").toString();
}

function assertRequest(request: DecisionRequest): void {
  const questionEntries = Object.entries(request.questions);
  if (questionEntries.length === 0) {
    throw new TypeSafeDecisionError("invalid_request", "Decision request must include a question");
  }
  if (!request.model.trim()) {
    throw new TypeSafeDecisionError("invalid_request", "Decision request model must not be empty");
  }

  for (const [name, question] of questionEntries) {
    if (question.type === "score" && question.criteria.length < 2) {
      throw new TypeSafeDecisionError(
        "invalid_request",
        'Score question "' + name + '" must define at least 2 criteria',
      );
    }
  }
}

function sameKeys(actual: Record<string, unknown>, expected: readonly string[]): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = [...expected].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function validateChoiceAnswer(
  name: string,
  question: ChoiceDecisionQuestion,
  answer: Extract<TypeSafeSystemOneResponse["answers"][string], { type: "choice" }>,
): void {
  const labels = Object.keys(question.criteria);
  if (!labels.includes(answer.choice) || !sameKeys(answer.probabilities, labels)) {
    throw new TypeSafeDecisionError(
      "invalid_response",
      'TypeSafe returned an invalid choice answer for "' + name + '"',
    );
  }
}

function expectedScoreKeys(question: ScoreDecisionQuestion): string[] {
  return Array.from({ length: question.criteria.length }, (_, index) => String(index));
}

function validateScoreAnswer(
  name: string,
  question: ScoreDecisionQuestion,
  answer: Extract<TypeSafeSystemOneResponse["answers"][string], { type: "score" }>,
): void {
  const keys = expectedScoreKeys(question);
  const maximumScore = question.criteria.length - 1;
  if (
    answer.score < 0 ||
    answer.score > maximumScore ||
    !sameKeys(answer.probabilities, keys) ||
    !sameKeys(answer.legend, keys)
  ) {
    throw new TypeSafeDecisionError(
      "invalid_response",
      'TypeSafe returned an invalid score answer for "' + name + '"',
    );
  }
}

function validateAnswer(
  name: string,
  question: DecisionQuestion,
  answer: TypeSafeSystemOneResponse["answers"][string],
): void {
  if (answer.type !== question.type) {
    throw new TypeSafeDecisionError(
      "invalid_response",
      'TypeSafe returned the wrong answer type for "' + name + '"',
    );
  }

  if (question.type === "choice" && answer.type === "choice") {
    validateChoiceAnswer(name, question, answer);
  }
  if (question.type === "score" && answer.type === "score") {
    validateScoreAnswer(name, question, answer);
  }
}

function mapAnswer(answer: TypeSafeSystemOneResponse["answers"][string]): DecisionAnswer {
  if (answer.type === "noul") {
    return { type: "noul", probability: answer.noul };
  }
  if (answer.type === "choice") {
    return {
      type: "choice",
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
    };
  }
  return {
    type: "score",
    score: answer.score,
    confidence: answer.confidence,
    probabilities: answer.probabilities,
  };
}

function parseDecisionResult(
  request: DecisionRequest,
  payload: unknown,
): Omit<DecisionResult, "engine"> {
  const parsed = TypeSafeSystemOneResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new TypeSafeDecisionError(
      "invalid_response",
      "TypeSafe returned a response that did not match the System One schema",
    );
  }

  const questionNames = Object.keys(request.questions);
  if (!sameKeys(parsed.data.answers, questionNames)) {
    throw new TypeSafeDecisionError(
      "invalid_response",
      "TypeSafe returned answers that did not match the requested questions",
    );
  }

  const answers: Record<string, DecisionAnswer> = {};
  for (const name of questionNames) {
    const question = request.questions[name];
    const answer = parsed.data.answers[name];
    validateAnswer(name, question, answer);
    answers[name] = mapAnswer(answer);
  }

  return {
    model: parsed.data.model,
    answers,
    usage: {
      inputTokens: parsed.data.usage.input_tokens,
      outputTokens: parsed.data.usage.output_tokens,
    },
  };
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new TypeSafeDecisionError(
      "invalid_response",
      "TypeSafe returned a response body that was not valid JSON",
    );
  }
}

function throwTransportError(input: {
  signal: AbortSignal;
  requestSignal: RequestSignal;
  timeoutMs: number;
}): never {
  if (input.signal.aborted) {
    throw new TypeSafeDecisionError("aborted", "TypeSafe request was canceled");
  }
  if (input.requestSignal.timedOut()) {
    throw new TypeSafeDecisionError(
      "timeout",
      "TypeSafe request timed out after " + input.timeoutMs + "ms",
    );
  }
  throw new TypeSafeDecisionError(
    "network",
    "TypeSafe request failed before a response was received",
  );
}

export function createTypeSafeDecisionEngine(
  options: TypeSafeDecisionEngineOptions,
): TypeSafeDecisionEngine {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new TypeSafeDecisionError("invalid_request", "TypeSafe API key must not be empty");
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeSafeDecisionError("invalid_request", "TypeSafe timeout must be positive");
  }
  if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
    throw new TypeSafeDecisionError("invalid_request", "TypeSafe max concurrency must be positive");
  }

  const limit = pLimit(maxConcurrency);

  async function request(
    method: "GET" | "POST",
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    if (signal.aborted) {
      throw new TypeSafeDecisionError("aborted", "TypeSafe request was canceled");
    }

    return limit(async () => {
      if (signal.aborted) {
        throw new TypeSafeDecisionError("aborted", "TypeSafe request was canceled");
      }

      const requestSignal = createRequestSignal(signal, timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(endpointUrl(baseUrl, path), {
            method,
            headers: {
              accept: "application/json",
              authorization: "Bearer " + apiKey,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: "error",
            signal: requestSignal.signal,
          });
        } catch {
          throwTransportError({ signal, requestSignal, timeoutMs });
        }

        if (!response.ok) {
          throw new TypeSafeDecisionError(
            "http",
            "TypeSafe API request failed with HTTP " + response.status,
            { status: response.status },
          );
        }

        return await readJsonResponse(response);
      } finally {
        requestSignal.cleanup();
      }
    });
  }

  return {
    id: "typesafe-jev",

    async evaluate(requestInput, requestOptions) {
      assertRequest(requestInput);
      const payload = await request("POST", "/v1/systemone", requestOptions.signal, requestInput);
      return {
        engine: "typesafe-jev",
        ...parseDecisionResult(requestInput, payload),
      };
    },

    async listModels(requestOptions) {
      const payload = await request("GET", "/v1/models", requestOptions.signal);
      const parsed = TypeSafeModelsResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new TypeSafeDecisionError(
          "invalid_response",
          "TypeSafe returned a response that did not match the models schema",
        );
      }
      return parsed.data.models;
    },
  };
}
