import { randomBytes } from "node:crypto";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import type {
  AxManagedHostProvisionSpec,
  AxManagedHostSpec,
  AxProvisionResult,
  AxTarget,
} from "@getpaseo/protocol/managed-hosts-ax";
import { spawnProcess } from "../utils/spawn.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";

export {
  AxDestroyTargetSchema,
  AxManagedHostProvisionSpecSchema,
  AxManagedHostSpecSchema,
  AxTaskTargetSchema,
} from "@getpaseo/protocol/managed-hosts-ax";
export type {
  AxDestroyTarget,
  AxManagedHostLifecycle,
  AxManagedHostProvisionSpec,
  AxManagedHostSpec,
  AxProvisionResult,
  AxTarget,
  AxTaskTarget,
} from "@getpaseo/protocol/managed-hosts-ax";

export interface AxCommandResult {
  stdout: string;
  stderr: string;
}

export interface AxCommandRunner {
  run(args: string[], options?: { stdin?: string; timeoutMs?: number }): Promise<AxCommandResult>;
}

export interface AxBootstrapRouter {
  fetchPairingUrl(target: AxTarget & { taskName: string }, bootstrapToken: string): Promise<string>;
}

export interface AxTaskStatus {
  phase: string;
  ready: boolean;
}

interface AxResourceMetadata {
  name: string;
  atespace: string;
}

interface AxManifestResource {
  apiVersion: "ax.io/v1alpha1";
  kind: "Gateway" | "Workspace" | "Task";
  metadata: AxResourceMetadata;
  spec: Record<string, unknown>;
}

const DEFAULT_AX_TIMEOUT_MS = 30_000;
const DEFAULT_TASK_TIMEOUT_MS = 120_000;
const DEFAULT_PORT_FORWARD_TIMEOUT_MS = 15_000;
const DEFAULT_BOOTSTRAP_REQUEST_TIMEOUT_MS = 30_000;
const BOOTSTRAP_RETRY_MS = 250;
const PASEO_AX_HOME = "/workspace/.paseo-host/home";
const PASEO_RELAY_HOST = "relay.paseo.sh";
const PASEO_RELAY_ENDPOINT = "relay.paseo.sh:443";
const ATENET_NAMESPACE = "ate-system";
const ATENET_ROUTER_SERVICE = "svc/atenet-router";
const BOOTSTRAP_PATH = "/paseo/bootstrap/pairing";

export class AxCommandError extends Error {
  readonly args: string[];
  readonly stderr: string;

  constructor(message: string, input: { args: string[]; stderr?: string; cause?: unknown }) {
    super(message, { cause: input.cause });
    this.name = "AxCommandError";
    this.args = input.args;
    this.stderr = input.stderr ?? "";
  }
}

export function createAxCommandRunner(command = "ax"): AxCommandRunner {
  return {
    run(args, options) {
      return new Promise((resolve, reject) => {
        const child = spawnProcess(command, args, {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timeoutMs = options?.timeoutMs ?? DEFAULT_AX_TIMEOUT_MS;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGKILL");
          reject(
            new AxCommandError(`AX command timed out after ${timeoutMs}ms`, {
              args,
              stderr,
            }),
          );
        }, timeoutMs);

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(
            new AxCommandError(`Failed to launch AX CLI: ${error.message}`, {
              args,
              stderr,
              cause: error,
            }),
          );
        });
        child.once("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          reject(
            new AxCommandError(
              stderr.trim() || stdout.trim() || `AX command exited with code ${code ?? "unknown"}`,
              { args, stderr },
            ),
          );
        });

        if (options?.stdin !== undefined) {
          child.stdin?.end(options.stdin);
        } else {
          child.stdin?.end();
        }
      });
    },
  };
}

export function createAxBootstrapRouter(command = "kubectl"): AxBootstrapRouter {
  return {
    async fetchPairingUrl(target, bootstrapToken) {
      const child = spawnProcess(
        command,
        [
          "--context",
          target.kubeContext,
          "-n",
          ATENET_NAMESPACE,
          "port-forward",
          ATENET_ROUTER_SERVICE,
          ":80",
          "--address",
          "127.0.0.1",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );

      try {
        const port = await waitForPortForward(child);
        const deadline = Date.now() + DEFAULT_BOOTSTRAP_REQUEST_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const controller = new AbortController();
          const requestTimeout = setTimeout(() => controller.abort(), 5_000);
          try {
            const response = await fetch(`http://127.0.0.1:${port}${BOOTSTRAP_PATH}`, {
              headers: {
                "ate-target-actor": `${target.atespace}/${target.taskName}`,
                "x-paseo-bootstrap-token": bootstrapToken,
              },
              signal: controller.signal,
            });
            const body = await response.text();
            if (response.status === 503) {
              await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_RETRY_MS));
              continue;
            }
            if (!response.ok) {
              throw new Error(
                `AX pairing bootstrap returned HTTP ${response.status}: ${body.slice(0, 500)}`,
              );
            }

            let payload: unknown;
            try {
              payload = JSON.parse(body);
            } catch (error) {
              throw new Error("AX pairing bootstrap returned invalid JSON", { cause: error });
            }
            if (
              typeof payload !== "object" ||
              payload === null ||
              !("url" in payload) ||
              typeof payload.url !== "string"
            ) {
              throw new Error("AX pairing bootstrap response did not include a pairing URL");
            }
            if (!parseConnectionOfferFromUrl(payload.url)) {
              throw new Error("AX pairing bootstrap did not contain a valid Paseo relay offer");
            }
            return payload.url;
          } finally {
            clearTimeout(requestTimeout);
          }
        }
        throw new Error(
          `Timed out waiting for AX task ${target.taskName} to publish its Paseo pairing offer`,
        );
      } finally {
        await terminateWithTreeKill(child, {
          gracefulTimeoutMs: 1_000,
          forceTimeoutMs: 1_000,
        }).catch(() => undefined);
      }
    },
  };
}

function waitForPortForward(
  child: ReturnType<typeof spawnProcess>,
  timeoutMs = DEFAULT_PORT_FORWARD_TIMEOUT_MS,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";

    const finish = (result: { port: number } | { error: Error }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if ("error" in result) reject(result.error);
      else resolve(result.port);
    };
    const inspect = (chunk: string): void => {
      output += chunk;
      const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+) -> 80/u);
      if (match?.[1]) finish({ port: Number(match[1]) });
    };
    const onError = (error: Error): void => {
      finish({
        error: new Error(
          `Failed to launch kubectl for AX pairing bootstrap: ${error.message}. Install kubectl and ensure the saved Kubernetes context is available.`,
          { cause: error },
        ),
      });
    };
    const onClose = (code: number | null): void => {
      finish({
        error: new Error(
          `kubectl port-forward exited before AX pairing bootstrap was ready (code ${code ?? "unknown"}): ${output.trim()}`,
        ),
      });
    };
    const timer = setTimeout(() => {
      finish({
        error: new Error(
          `Timed out waiting for kubectl to forward the AX atenet router after ${timeoutMs}ms`,
        ),
      });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function axTargetArgs(target: AxTarget): string[] {
  return [
    "--context",
    target.kubeContext,
    "--namespace",
    target.namespace,
    "--atespace",
    target.atespace,
  ];
}

function normalizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function isAxNotFound(error: unknown): boolean {
  return (
    error instanceof AxCommandError &&
    /(?:code\s*=\s*NotFound\b|\bNotFound\b)/u.test(`${error.message}\n${error.stderr}`)
  );
}

function ownedResourceName(taskName: string, kind: "ws" | "gw", suffix: string): string {
  const normalizedTask = normalizeRequired(taskName, "taskName")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  const tail = `-${kind}-${suffix}`;
  const maxBaseLength = Math.max(1, 63 - tail.length);
  const base = normalizedTask.slice(0, maxBaseLength).replace(/-+$/gu, "") || "paseo";
  return `${base}${tail}`;
}

function egressHosts(spec: AxManagedHostSpec): string[] {
  const hosts = new Set(spec.egressHosts.map((host) => normalizeRequired(host, "egress host")));
  hosts.add(PASEO_RELAY_HOST);
  return [...hosts];
}

function buildGateway(spec: AxManagedHostSpec): AxManifestResource {
  return {
    apiVersion: "ax.io/v1alpha1",
    kind: "Gateway",
    metadata: {
      name: normalizeRequired(spec.gatewayName, "gatewayName"),
      atespace: normalizeRequired(spec.atespace, "atespace"),
    },
    spec: {
      egress: {
        allowlist: {
          hosts: egressHosts(spec).map((host) => ({ host, port: 443 })),
        },
      },
    },
  };
}

function buildWorkspace(spec: AxManagedHostSpec): AxManifestResource {
  const workspaceSpec: Record<string, unknown> = {};
  if (spec.repo) {
    workspaceSpec.git = [
      {
        name: "origin",
        repo: normalizeRequired(spec.repo, "repo"),
        ...(spec.branch ? { branch: normalizeRequired(spec.branch, "branch") } : {}),
      },
    ];
  }
  return {
    apiVersion: "ax.io/v1alpha1",
    kind: "Workspace",
    metadata: {
      name: normalizeRequired(spec.workspaceName, "workspaceName"),
      atespace: normalizeRequired(spec.atespace, "atespace"),
    },
    spec: workspaceSpec,
  };
}

function buildTask(spec: AxManagedHostSpec, bootstrapToken: string): AxManifestResource {
  const resources =
    spec.cpuRequest || spec.memoryRequest || spec.cpuLimit || spec.memoryLimit
      ? {
          requests: {
            ...(spec.cpuRequest ? { cpu: spec.cpuRequest } : {}),
            ...(spec.memoryRequest ? { memory: spec.memoryRequest } : {}),
          },
          limits: {
            ...(spec.cpuLimit ? { cpu: spec.cpuLimit } : {}),
            ...(spec.memoryLimit ? { memory: spec.memoryLimit } : {}),
          },
        }
      : undefined;

  return {
    apiVersion: "ax.io/v1alpha1",
    kind: "Task",
    metadata: {
      name: normalizeRequired(spec.taskName, "taskName"),
      atespace: normalizeRequired(spec.atespace, "atespace"),
    },
    spec: {
      image: normalizeRequired(spec.image, "image"),
      command: ["paseo-ax-daemon"],
      env: [
        { name: "HOME", value: PASEO_AX_HOME },
        { name: "PASEO_HOME", value: `${PASEO_AX_HOME}/.paseo` },
        { name: "CLAUDE_CONFIG_DIR", value: `${PASEO_AX_HOME}/.claude` },
        { name: "CODEX_HOME", value: `${PASEO_AX_HOME}/.codex` },
        { name: "XDG_CONFIG_HOME", value: `${PASEO_AX_HOME}/.config` },
        { name: "XDG_DATA_HOME", value: `${PASEO_AX_HOME}/.local/share` },
        { name: "XDG_STATE_HOME", value: `${PASEO_AX_HOME}/.local/state` },
        { name: "XDG_CACHE_HOME", value: `${PASEO_AX_HOME}/.cache` },
        { name: "PASEO_LISTEN", value: "127.0.0.1:6767" },
        { name: "PASEO_WEB_UI_ENABLED", value: "false" },
        { name: "PASEO_RELAY_ENABLED", value: "true" },
        { name: "PASEO_RELAY_ENDPOINT", value: PASEO_RELAY_ENDPOINT },
        { name: "PASEO_RELAY_USE_TLS", value: "true" },
        {
          name: "PASEO_AX_BOOTSTRAP_TOKEN",
          value: normalizeRequired(bootstrapToken, "bootstrapToken"),
        },
      ],
      workspaces: [
        {
          name: normalizeRequired(spec.workspaceName, "workspaceName"),
          path: "/workspace",
        },
      ],
      gateway: { name: normalizeRequired(spec.gatewayName, "gatewayName") },
      debug: false,
      ...(resources ? { resources } : {}),
    },
  };
}

export function buildAxManagedHostResources(
  spec: AxManagedHostSpec,
  options: { bootstrapToken: string },
): AxManifestResource[] {
  if (spec.egressHosts.length === 0) {
    throw new Error("At least one egress host is required");
  }
  return [buildGateway(spec), buildWorkspace(spec), buildTask(spec, options.bootstrapToken)];
}

export function serializeAxResources(resources: AxManifestResource[]): string {
  return resources.map((resource) => JSON.stringify(resource, null, 2)).join("\n---\n");
}

export function parseAxTaskStatus(output: string): AxTaskStatus {
  const lines = output.split(/\r?\n/u);
  const statusIndex = lines.findIndex((line) => line.trim() === "status:");
  if (statusIndex < 0) throw new Error("AX task response did not include status");

  let phase: string | null = null;
  let conditionType: string | null = null;
  let ready = false;
  for (let index = statusIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length > 0 && !/^\s/u.test(line)) break;

    const phaseMatch = line.match(/^\s+phase:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/u);
    if (phaseMatch?.[1]) {
      phase = phaseMatch[1];
      continue;
    }

    const typeMatch = line.match(/^\s*(?:-\s*)?type:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/u);
    if (typeMatch?.[1]) {
      conditionType = typeMatch[1];
      continue;
    }

    const conditionStatusMatch = line.match(/^\s+status:\s*["']?([^"'#\s]+)["']?\s*(?:#.*)?$/u);
    if (conditionStatusMatch?.[1] && conditionType === "Ready") {
      ready = conditionStatusMatch[1].toLowerCase() === "true";
    }
  }

  if (!phase) throw new Error("AX task response did not include status.phase");
  return { phase, ready };
}

export class AxManagedHostControlPlane {
  private readonly runner: AxCommandRunner;
  private readonly bootstrapRouter: AxBootstrapRouter;
  private readonly createBootstrapToken: () => string;
  private readonly createResourceSuffix: () => string;

  constructor(input?: {
    runner?: AxCommandRunner;
    bootstrapRouter?: AxBootstrapRouter;
    createBootstrapToken?: () => string;
    createResourceSuffix?: () => string;
  }) {
    this.runner = input?.runner ?? createAxCommandRunner();
    this.bootstrapRouter = input?.bootstrapRouter ?? createAxBootstrapRouter();
    this.createBootstrapToken =
      input?.createBootstrapToken ?? (() => randomBytes(32).toString("base64url"));
    this.createResourceSuffix =
      input?.createResourceSuffix ?? (() => randomBytes(16).toString("hex"));
  }

  async diagnose(target: AxTarget): Promise<{ version: string; context: string }> {
    const version = await this.runner.run(["version"]);
    const versionText = version.stdout.trim();
    if (!/^ax version v1alpha1(?:\s|$)/u.test(versionText)) {
      throw new Error(
        `Unsupported AX CLI version: ${versionText || "unknown"}. Paseo currently supports AX v1alpha1.`,
      );
    }
    const context = await this.runner.run([...axTargetArgs(target), "ctx"]);
    return {
      version: versionText,
      context: context.stdout.trim(),
    };
  }

  async apply(spec: AxManagedHostSpec, bootstrapToken: string): Promise<void> {
    const manifest = serializeAxResources(buildAxManagedHostResources(spec, { bootstrapToken }));
    await this.runner.run([...axTargetArgs(spec), "apply", "-f", "-"], {
      stdin: manifest,
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
    });
  }

  async inspectTask(target: AxTarget & { taskName: string }): Promise<AxTaskStatus> {
    const result = await this.runner.run([...axTargetArgs(target), "get", "task", target.taskName]);
    return parseAxTaskStatus(result.stdout);
  }

  async waitUntilReady(
    target: AxTarget & { taskName: string },
    options?: { timeoutMs?: number; pollMs?: number },
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    const pollMs = options?.pollMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.inspectTask(target);
      if (status.phase === "Running" && status.ready) return;
      if (status.phase === "Failed" || status.phase === "Completed") {
        throw new Error(`AX task ${target.taskName} reached ${status.phase} before becoming ready`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`Timed out waiting for AX task ${target.taskName} to become ready`);
  }

  async provision(input: AxManagedHostProvisionSpec): Promise<AxProvisionResult> {
    await this.diagnose(input);
    await this.assertTaskAbsent(input);
    const spec = this.resolveOwnedResources(input);
    const bootstrapToken = this.createBootstrapToken();
    let resourcesMayExist = false;
    try {
      resourcesMayExist = true;
      await this.apply(spec, bootstrapToken);
      await this.waitUntilReady(spec);
      const pairingUrl = await this.bootstrapRouter.fetchPairingUrl(spec, bootstrapToken);
      return {
        pairingUrl,
        lifecycle: {
          kind: "ax",
          kubeContext: spec.kubeContext,
          namespace: spec.namespace,
          atespace: spec.atespace,
          taskName: spec.taskName,
          workspaceName: spec.workspaceName,
          gatewayName: spec.gatewayName,
        },
      };
    } catch (error) {
      if (resourcesMayExist) {
        await this.cleanupFailedProvision(spec);
      }
      throw error;
    }
  }

  private resolveOwnedResources(input: AxManagedHostProvisionSpec): AxManagedHostSpec {
    const suffix = normalizeRequired(this.createResourceSuffix(), "resourceSuffix");
    return {
      ...input,
      workspaceName: ownedResourceName(input.taskName, "ws", suffix),
      gatewayName: ownedResourceName(input.taskName, "gw", suffix),
    };
  }

  async suspend(target: AxTarget & { taskName: string }): Promise<void> {
    await this.runner.run([...axTargetArgs(target), "suspend", "task", target.taskName]);
  }

  async resume(target: AxTarget & { taskName: string }): Promise<void> {
    await this.runner.run([...axTargetArgs(target), "resume", "task", target.taskName]);
    await this.waitUntilReady(target);
  }

  async destroy(
    target: AxTarget & { taskName: string; workspaceName: string; gatewayName: string },
  ): Promise<void> {
    await this.deleteIfPresent(target, "task", target.taskName, 5 * 60_000);
    await this.deleteIfPresent(target, "workspace", target.workspaceName);
    await this.deleteIfPresent(target, "gateway", target.gatewayName);
  }

  private async assertTaskAbsent(target: AxTarget & { taskName: string }): Promise<void> {
    try {
      await this.runner.run([...axTargetArgs(target), "get", "task", target.taskName]);
    } catch (error) {
      if (isAxNotFound(error)) return;
      throw error;
    }
    throw new Error(
      `AX task ${target.atespace}/${target.taskName} already exists. Use the existing Paseo host or destroy that AX host before provisioning this task name again.`,
    );
  }

  private async deleteIfPresent(
    target: AxTarget,
    kind: "task" | "workspace" | "gateway",
    name: string,
    timeoutMs = DEFAULT_AX_TIMEOUT_MS,
  ): Promise<void> {
    try {
      await this.runner.run([...axTargetArgs(target), "delete", kind, name], {
        timeoutMs,
      });
    } catch (error) {
      if (isAxNotFound(error)) return;
      throw error;
    }
  }

  private async cleanupFailedProvision(
    target: AxTarget & {
      taskName: string;
      workspaceName: string;
      gatewayName: string;
    },
  ): Promise<void> {
    for (const [kind, name, timeoutMs] of [
      ["task", target.taskName, 5 * 60_000],
      ["workspace", target.workspaceName, DEFAULT_AX_TIMEOUT_MS],
      ["gateway", target.gatewayName, DEFAULT_AX_TIMEOUT_MS],
    ] as const) {
      try {
        await this.runner.run([...axTargetArgs(target), "delete", kind, name], { timeoutMs });
      } catch {
        // Preserve the provisioning error. Any surviving resource remains visible
        // through normal AX tooling and can be removed explicitly.
      }
    }
  }
}
