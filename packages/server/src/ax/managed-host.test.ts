import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  AxCommandError,
  AxManagedHostControlPlane,
  buildAxManagedHostResources,
  parseAxTaskStatus,
  serializeAxResources,
  type AxBootstrapRouter,
  type AxCommandResult,
  type AxCommandRunner,
  type AxManagedHostProvisionSpec,
  type AxManagedHostSpec,
} from "./managed-host.js";

function makeSpec(): AxManagedHostSpec {
  return {
    kubeContext: "dev-cluster",
    namespace: "ax-system",
    atespace: "default",
    taskName: "paseo-host-1",
    workspaceName: "paseo-host-1-ws-test1234",
    gatewayName: "paseo-host-1-gw-test1234",
    image: "ghcr.io/fijimunkii/paseo-ax:latest",
    repo: "https://github.com/example/storefront.git",
    branch: "main",
    egressHosts: ["api.openai.com", "github.com"],
    cpuRequest: "500m",
    memoryRequest: "1Gi",
    cpuLimit: "2",
    memoryLimit: "4Gi",
  };
}

function makeProvisionSpec(): AxManagedHostProvisionSpec {
  const spec = makeSpec();
  return {
    kubeContext: spec.kubeContext,
    namespace: spec.namespace,
    atespace: spec.atespace,
    taskName: spec.taskName,
    image: spec.image,
    repo: spec.repo,
    branch: spec.branch,
    egressHosts: spec.egressHosts,
    cpuRequest: spec.cpuRequest,
    memoryRequest: spec.memoryRequest,
    cpuLimit: spec.cpuLimit,
    memoryLimit: spec.memoryLimit,
  };
}

function makePairingUrl(): string {
  const payload = {
    v: 2,
    serverId: "srv_ax",
    daemonPublicKeyB64: "pk_ax_test",
    relay: { endpoint: "relay.paseo.sh:443", useTls: true },
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8")
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
  return `https://app.paseo.sh/#offer=${encoded}`;
}

class FakeAxRunner implements AxCommandRunner {
  readonly calls: Array<{ args: string[]; stdin?: string; timeoutMs?: number }> = [];
  private readonly responses: Array<AxCommandResult | Error>;

  constructor(responses: Array<AxCommandResult | Error>) {
    this.responses = [...responses];
  }

  async run(
    args: string[],
    options?: { stdin?: string; timeoutMs?: number },
  ): Promise<AxCommandResult> {
    this.calls.push({
      args,
      ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    const response = this.responses.shift();
    if (!response) throw new Error("No fake AX response configured");
    if (response instanceof Error) throw response;
    return response;
  }
}

function taskNotFound(): AxCommandError {
  return new AxCommandError('getting task "paseo-host-1": rpc error: code = NotFound', {
    args: ["get", "task", "paseo-host-1"],
    stderr: "rpc error: code = NotFound desc = task not found",
  });
}

class FakeBootstrapRouter implements AxBootstrapRouter {
  readonly calls: Array<{
    target: { kubeContext: string; namespace: string; atespace: string; taskName: string };
    bootstrapToken: string;
  }> = [];

  constructor(private readonly result: string | Error = makePairingUrl()) {}

  async fetchPairingUrl(
    target: { kubeContext: string; namespace: string; atespace: string; taskName: string },
    bootstrapToken: string,
  ): Promise<string> {
    this.calls.push({ target, bootstrapToken });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

function readyTaskYaml(phase = "Running"): string {
  return `apiVersion: ax.io/v1alpha1
kind: Task
metadata:
  name: paseo-host-1
status:
  phase: ${phase}
  conditions:
    - type: WorkspaceReady
      status: "True"
    - type: Ready
      status: "True"
`;
}

describe("buildAxManagedHostResources", () => {
  it("keeps durable Paseo state under the AX workspace and never enables AX debug", () => {
    const resources = buildAxManagedHostResources(makeSpec(), {
      bootstrapToken: "bootstrap-secret",
    });
    const serialized = serializeAxResources(resources);

    expect(resources.map((resource) => resource.kind)).toEqual(["Gateway", "Workspace", "Task"]);
    expect(serialized).toContain("/workspace/.paseo-host/home/.paseo");
    expect(serialized).toContain('"paseo-ax-daemon"');
    expect(serialized).toContain('"debug": false');
    expect(serialized).toContain('"name": "PASEO_AX_BOOTSTRAP_TOKEN"');
    expect(serialized).toContain('"value": "bootstrap-secret"');
    expect(serialized).toContain('"host": "relay.paseo.sh"');
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("ANTHROPIC_API_KEY");
    expect(serialized).not.toContain("GEMINI_API_KEY");
  });

  it("always includes Paseo relay egress even when the user customizes the allowlist", () => {
    const resources = buildAxManagedHostResources(makeSpec(), {
      bootstrapToken: "bootstrap-secret",
    });
    const gateway = resources[0];
    expect(gateway?.spec).toEqual({
      egress: {
        allowlist: {
          hosts: [
            { host: "api.openai.com", port: 443 },
            { host: "github.com", port: 443 },
            { host: "relay.paseo.sh", port: 443 },
          ],
        },
      },
    });
  });

  it("requires an explicit workload egress allowlist", () => {
    expect(() =>
      buildAxManagedHostResources(
        { ...makeSpec(), egressHosts: [] },
        { bootstrapToken: "bootstrap-secret" },
      ),
    ).toThrow("At least one egress host is required");
  });
});

describe("parseAxTaskStatus", () => {
  it("reads phase and Ready=True from AX structured YAML output", () => {
    expect(parseAxTaskStatus(readyTaskYaml())).toEqual({ phase: "Running", ready: true });
  });

  it("does not report ready when AX is still initializing the task", () => {
    expect(
      parseAxTaskStatus(`status:
  phase: Running
  conditions:
    - type: WorkspaceReady
      status: "True"
    - type: Ready
      status: "False"
      reason: WorkspaceInitializing
`),
    ).toEqual({ phase: "Running", ready: false });
  });

  it("does not confuse spec fields with status", () => {
    expect(
      parseAxTaskStatus(`spec:
  phase: ignored
status:
  id: task-1
  phase: Suspended
`),
    ).toEqual({ phase: "Suspended", ready: false });
  });
});

describe("AxManagedHostControlPlane", () => {
  it("rejects AX CLI versions outside the supported v1alpha1 contract", async () => {
    const runner = new FakeAxRunner([{ stdout: "ax version v2\n", stderr: "" }]);
    const controlPlane = new AxManagedHostControlPlane({ runner });

    await expect(
      controlPlane.diagnose({
        kubeContext: "dev-cluster",
        namespace: "ax-system",
        atespace: "default",
      }),
    ).rejects.toThrow("Paseo currently supports AX v1alpha1");

    expect(runner.calls).toHaveLength(1);
  });

  it("applies one structured manifest stream to the selected AX cluster", async () => {
    const runner = new FakeAxRunner([{ stdout: "applied\n", stderr: "" }]);
    const controlPlane = new AxManagedHostControlPlane({ runner });

    await controlPlane.apply(makeSpec(), "bootstrap-secret");

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.args).toEqual([
      "--context",
      "dev-cluster",
      "--namespace",
      "ax-system",
      "--atespace",
      "default",
      "apply",
      "-f",
      "-",
    ]);
    expect(runner.calls[0]?.stdin).toContain('"kind": "Task"');
    expect(runner.calls[0]?.stdin).toContain('"debug": false');
    expect(runner.calls[0]?.stdin).not.toContain("API_KEY");
  });

  it("refuses to provision over an existing AX task", async () => {
    const runner = new FakeAxRunner([
      { stdout: "ax version v1alpha1 (standalone redis engine)\n", stderr: "" },
      { stdout: "Active Kubernetes Context: dev-cluster\n", stderr: "" },
      { stdout: readyTaskYaml(), stderr: "" },
    ]);
    const controlPlane = new AxManagedHostControlPlane({
      runner,
      bootstrapRouter: new FakeBootstrapRouter(),
    });

    await expect(controlPlane.provision(makeProvisionSpec())).rejects.toThrow("already exists");
    expect(runner.calls.some((call) => call.args.includes("apply"))).toBe(false);
  });

  it("provisions without AX guest debug and retrieves pairing through the router", async () => {
    const runner = new FakeAxRunner([
      { stdout: "ax version v1alpha1 (standalone redis engine)\n", stderr: "" },
      { stdout: "Active Kubernetes Context: dev-cluster\n", stderr: "" },
      taskNotFound(),
      { stdout: "applied\n", stderr: "" },
      { stdout: readyTaskYaml(), stderr: "" },
    ]);
    const bootstrapRouter = new FakeBootstrapRouter();
    const controlPlane = new AxManagedHostControlPlane({
      runner,
      bootstrapRouter,
      createBootstrapToken: () => "bootstrap-secret",
      createResourceSuffix: () => "test1234",
    });

    await expect(controlPlane.provision(makeProvisionSpec())).resolves.toEqual({
      pairingUrl: makePairingUrl(),
      lifecycle: {
        kind: "ax",
        kubeContext: "dev-cluster",
        namespace: "ax-system",
        atespace: "default",
        taskName: "paseo-host-1",
        workspaceName: "paseo-host-1-ws-test1234",
        gatewayName: "paseo-host-1-gw-test1234",
      },
    });

    const applyCall = runner.calls.find((call) => call.args.includes("apply"));
    expect(applyCall?.stdin).toContain('"debug": false');
    expect(applyCall?.stdin).toContain('"value": "bootstrap-secret"');
    expect(bootstrapRouter.calls).toEqual([
      {
        target: {
          kubeContext: "dev-cluster",
          namespace: "ax-system",
          atespace: "default",
          taskName: "paseo-host-1",
          workspaceName: "paseo-host-1-ws-test1234",
          gatewayName: "paseo-host-1-gw-test1234",
          image: "ghcr.io/fijimunkii/paseo-ax:latest",
          repo: "https://github.com/example/storefront.git",
          branch: "main",
          egressHosts: ["api.openai.com", "github.com"],
          cpuRequest: "500m",
          memoryRequest: "1Gi",
          cpuLimit: "2",
          memoryLimit: "4Gi",
        },
        bootstrapToken: "bootstrap-secret",
      },
    ]);
  });

  it("cleans up resources when AX apply fails after a partial multi-document apply", async () => {
    const runner = new FakeAxRunner([
      { stdout: "ax version v1alpha1 (standalone redis engine)\n", stderr: "" },
      { stdout: "Active Kubernetes Context: dev-cluster\n", stderr: "" },
      taskNotFound(),
      new AxCommandError("applying document 3: task rejected", {
        args: ["apply", "-f", "-"],
        stderr: "task rejected",
      }),
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
    ]);
    const controlPlane = new AxManagedHostControlPlane({
      runner,
      bootstrapRouter: new FakeBootstrapRouter(),
      createBootstrapToken: () => "bootstrap-secret",
      createResourceSuffix: () => "test1234",
    });

    await expect(controlPlane.provision(makeProvisionSpec())).rejects.toThrow("task rejected");
    expect(runner.calls.slice(-3).map((call) => call.args.slice(-3))).toEqual([
      ["delete", "task", "paseo-host-1"],
      ["delete", "workspace", "paseo-host-1-ws-test1234"],
      ["delete", "gateway", "paseo-host-1-gw-test1234"],
    ]);
  });

  it("cleans up AX resources when bootstrap pairing fails", async () => {
    const runner = new FakeAxRunner([
      { stdout: "ax version v1alpha1 (standalone redis engine)\n", stderr: "" },
      { stdout: "Active Kubernetes Context: dev-cluster\n", stderr: "" },
      taskNotFound(),
      { stdout: "applied\n", stderr: "" },
      { stdout: readyTaskYaml(), stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
    ]);
    const bootstrapRouter = new FakeBootstrapRouter(new Error("bootstrap unavailable"));
    const controlPlane = new AxManagedHostControlPlane({
      runner,
      bootstrapRouter,
      createBootstrapToken: () => "bootstrap-secret",
      createResourceSuffix: () => "test1234",
    });

    await expect(controlPlane.provision(makeProvisionSpec())).rejects.toThrow(
      "bootstrap unavailable",
    );
    expect(runner.calls.slice(-3).map((call) => call.args.slice(-3))).toEqual([
      ["delete", "task", "paseo-host-1"],
      ["delete", "workspace", "paseo-host-1-ws-test1234"],
      ["delete", "gateway", "paseo-host-1-gw-test1234"],
    ]);
  });

  it("continues destroy when the AX task was already removed", async () => {
    const runner = new FakeAxRunner([
      new AxCommandError("rpc error: code = NotFound desc = task not found", {
        args: ["delete", "task", "paseo-host-1"],
        stderr: "rpc error: code = NotFound desc = task not found",
      }),
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
    ]);
    const controlPlane = new AxManagedHostControlPlane({ runner });

    await expect(
      controlPlane.destroy({
        kubeContext: "dev-cluster",
        namespace: "ax-system",
        atespace: "default",
        taskName: "paseo-host-1",
        workspaceName: "paseo-host-1-ws-test1234",
        gatewayName: "paseo-host-1-gw-test1234",
      }),
    ).resolves.toBeUndefined();

    expect(runner.calls.map((call) => call.args.slice(-3))).toEqual([
      ["delete", "task", "paseo-host-1"],
      ["delete", "workspace", "paseo-host-1-ws-test1234"],
      ["delete", "gateway", "paseo-host-1-gw-test1234"],
    ]);
  });

  it("destroys the task before its durable workspace and gateway", async () => {
    const runner = new FakeAxRunner([
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
    ]);
    const controlPlane = new AxManagedHostControlPlane({ runner });

    await controlPlane.destroy({
      kubeContext: "dev-cluster",
      namespace: "ax-system",
      atespace: "default",
      taskName: "paseo-host-1",
      workspaceName: "paseo-host-1-ws-test1234",
      gatewayName: "paseo-host-1-gw-test1234",
    });

    expect(runner.calls.map((call) => call.args.slice(-3))).toEqual([
      ["delete", "task", "paseo-host-1"],
      ["delete", "workspace", "paseo-host-1-ws-test1234"],
      ["delete", "gateway", "paseo-host-1-gw-test1234"],
    ]);
  });
});
