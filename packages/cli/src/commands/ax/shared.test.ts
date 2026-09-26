import { describe, expect, it } from "vitest";
import { DEFAULT_AX_EGRESS_HOSTS, DEFAULT_AX_IMAGE } from "@getpaseo/protocol/managed-hosts-ax";
import {
  resolveAxDestroyTarget,
  resolveAxManagedHostProvisionSpec,
  resolveAxTarget,
} from "./shared.js";

describe("resolveAxTarget", () => {
  it("requires an explicit Kubernetes context and defaults the AX scopes", () => {
    expect(() => resolveAxTarget({})).toThrow("--context is required");
    expect(resolveAxTarget({ context: " dev-cluster " })).toEqual({
      kubeContext: "dev-cluster",
      namespace: "ax-system",
      atespace: "default",
    });
  });
});

describe("resolveAxManagedHostProvisionSpec", () => {
  it("defaults the image and restricted egress allowlist", () => {
    expect(
      resolveAxManagedHostProvisionSpec(" paseo-dev ", {
        context: "dev-cluster",
      }),
    ).toEqual({
      kubeContext: "dev-cluster",
      namespace: "ax-system",
      atespace: "default",
      taskName: "paseo-dev",
      image: DEFAULT_AX_IMAGE,
      egressHosts: [...DEFAULT_AX_EGRESS_HOSTS],
    });
  });

  it("uses explicit image, repository, resource, and egress settings", () => {
    expect(
      resolveAxManagedHostProvisionSpec("paseo-prod", {
        context: "prod",
        namespace: "custom-ax",
        atespace: "engineering",
        image: "ghcr.io/example/paseo-ax@sha256:1234",
        repo: " https://github.com/example/repo.git ",
        branch: " release ",
        egressHost: ["relay.example.com", " api.openai.com "],
        cpuRequest: "1",
        memoryRequest: "2Gi",
        cpuLimit: "4",
        memoryLimit: "8Gi",
      }),
    ).toEqual({
      kubeContext: "prod",
      namespace: "custom-ax",
      atespace: "engineering",
      taskName: "paseo-prod",
      image: "ghcr.io/example/paseo-ax@sha256:1234",
      repo: "https://github.com/example/repo.git",
      branch: "release",
      egressHosts: ["relay.example.com", "api.openai.com"],
      cpuRequest: "1",
      memoryRequest: "2Gi",
      cpuLimit: "4",
      memoryLimit: "8Gi",
    });
  });
});

describe("resolveAxDestroyTarget", () => {
  it("requires the exact workspace and gateway names returned by provision", () => {
    expect(() =>
      resolveAxDestroyTarget("paseo-prod", {
        context: "prod",
      }),
    ).toThrow("--workspace is required");

    expect(
      resolveAxDestroyTarget("paseo-prod", {
        context: "prod",
        workspace: "paseo-prod-ws-deadbeef",
        gateway: "paseo-prod-gw-deadbeef",
      }),
    ).toEqual({
      kubeContext: "prod",
      namespace: "ax-system",
      atespace: "default",
      taskName: "paseo-prod",
      workspaceName: "paseo-prod-ws-deadbeef",
      gatewayName: "paseo-prod-gw-deadbeef",
    });
  });
});
