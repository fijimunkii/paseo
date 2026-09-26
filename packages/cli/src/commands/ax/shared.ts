import {
  DEFAULT_AX_ATESPACE,
  DEFAULT_AX_EGRESS_HOSTS,
  DEFAULT_AX_IMAGE,
  DEFAULT_AX_NAMESPACE,
  type AxDestroyTarget,
  type AxManagedHostProvisionSpec,
  type AxTarget,
} from "@getpaseo/protocol/managed-hosts-ax";
import type { OutputSchema } from "../../output/index.js";

export interface AxCommandOptions {
  context?: string;
  namespace?: string;
  atespace?: string;
  workspace?: string;
  gateway?: string;
  image?: string;
  repo?: string;
  branch?: string;
  egressHost?: string[];
  cpuRequest?: string;
  memoryRequest?: string;
  cpuLimit?: string;
  memoryLimit?: string;
}

export interface AxHostRow {
  task: string;
  atespace: string;
  context: string;
  namespace: string;
  status: string;
  workspace?: string;
  gateway?: string;
  pairingUrl?: string;
}

export const axHostSchema: OutputSchema<AxHostRow> = {
  idField: "task",
  columns: [
    { header: "TASK", field: "task" },
    { header: "STATUS", field: "status" },
    { header: "CONTEXT", field: "context" },
    { header: "ATESPACE", field: "atespace" },
    { header: "WORKSPACE", field: (row) => row.workspace ?? "" },
    { header: "GATEWAY", field: (row) => row.gateway ?? "" },
    { header: "PAIRING URL", field: (row) => row.pairingUrl ?? "" },
  ],
};

function required(value: string | undefined, flag: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw {
      code: "AX_INPUT_INVALID",
      message: `${flag} is required`,
    };
  }
  return normalized;
}

export function resolveAxTarget(options: AxCommandOptions): AxTarget {
  return {
    kubeContext: required(options.context, "--context"),
    namespace: options.namespace?.trim() || DEFAULT_AX_NAMESPACE,
    atespace: options.atespace?.trim() || DEFAULT_AX_ATESPACE,
  };
}

export function resolveAxManagedHostProvisionSpec(
  taskName: string,
  options: AxCommandOptions,
): AxManagedHostProvisionSpec {
  const target = resolveAxTarget(options);
  const task = required(taskName, "task name");
  return {
    ...target,
    taskName: task,
    image: options.image?.trim() || DEFAULT_AX_IMAGE,
    ...(options.repo?.trim() ? { repo: options.repo.trim() } : {}),
    ...(options.branch?.trim() ? { branch: options.branch.trim() } : {}),
    egressHosts: options.egressHost
      ?.map((host) => host.trim())
      .filter((host) => host.length > 0) ?? [...DEFAULT_AX_EGRESS_HOSTS],
    ...(options.cpuRequest?.trim() ? { cpuRequest: options.cpuRequest.trim() } : {}),
    ...(options.memoryRequest?.trim() ? { memoryRequest: options.memoryRequest.trim() } : {}),
    ...(options.cpuLimit?.trim() ? { cpuLimit: options.cpuLimit.trim() } : {}),
    ...(options.memoryLimit?.trim() ? { memoryLimit: options.memoryLimit.trim() } : {}),
  };
}

export function resolveAxDestroyTarget(
  taskName: string,
  options: AxCommandOptions,
): AxDestroyTarget {
  return {
    ...resolveAxTarget(options),
    taskName: required(taskName, "task name"),
    workspaceName: required(options.workspace, "--workspace"),
    gatewayName: required(options.gateway, "--gateway"),
  };
}

export function toAxHostRow(input: {
  task: string;
  target: AxTarget;
  status: string;
  workspace?: string;
  gateway?: string;
  pairingUrl?: string;
}): AxHostRow {
  return {
    task: input.task,
    atespace: input.target.atespace,
    context: input.target.kubeContext,
    namespace: input.target.namespace,
    status: input.status,
    ...(input.workspace ? { workspace: input.workspace } : {}),
    ...(input.gateway ? { gateway: input.gateway } : {}),
    ...(input.pairingUrl ? { pairingUrl: input.pairingUrl } : {}),
  };
}
