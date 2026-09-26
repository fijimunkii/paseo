import {
  AxDestroyTargetSchema,
  AxManagedHostProvisionSpecSchema,
  AxProvisionResultSchema,
  AxTaskTargetSchema,
  type AxDestroyTarget,
  type AxManagedHostProvisionSpec,
  type AxProvisionResult,
  type AxTaskTarget,
} from "@getpaseo/protocol/managed-hosts-ax";
import { getDesktopHost } from "@/desktop/host";

type DesktopInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

function requireInvoke(): DesktopInvoke {
  const invoke = getDesktopHost()?.invoke;
  if (!invoke) {
    throw new Error("AX managed hosts require Paseo Desktop or the Paseo CLI");
  }
  return invoke;
}

export interface AxManagedHostBackend {
  provision(spec: AxManagedHostProvisionSpec): Promise<AxProvisionResult>;
  inspect(target: AxTaskTarget): Promise<{ phase: string }>;
  suspend(target: AxTaskTarget): Promise<void>;
  resume(target: AxTaskTarget): Promise<void>;
  destroy(target: AxDestroyTarget): Promise<void>;
}

async function provision(spec: AxManagedHostProvisionSpec): Promise<AxProvisionResult> {
  const result = await requireInvoke()(
    "ax_managed_host_provision",
    AxManagedHostProvisionSpecSchema.parse(spec),
  );
  return AxProvisionResultSchema.parse(result);
}

function taskTarget(target: AxTaskTarget): AxTaskTarget {
  return AxTaskTargetSchema.parse({
    kubeContext: target.kubeContext,
    namespace: target.namespace,
    atespace: target.atespace,
    taskName: target.taskName,
  });
}

function destroyTarget(target: AxDestroyTarget): AxDestroyTarget {
  return AxDestroyTargetSchema.parse({
    kubeContext: target.kubeContext,
    namespace: target.namespace,
    atespace: target.atespace,
    taskName: target.taskName,
    workspaceName: target.workspaceName,
    gatewayName: target.gatewayName,
  });
}

async function inspect(target: AxTaskTarget): Promise<{ phase: string }> {
  const result = await requireInvoke()("ax_managed_host_inspect", taskTarget(target));
  if (
    typeof result !== "object" ||
    result === null ||
    !("phase" in result) ||
    typeof result.phase !== "string"
  ) {
    throw new Error("Desktop returned an invalid AX task status");
  }
  return { phase: result.phase };
}

async function suspend(target: AxTaskTarget): Promise<void> {
  await requireInvoke()("ax_managed_host_suspend", taskTarget(target));
}

async function resume(target: AxTaskTarget): Promise<void> {
  await requireInvoke()("ax_managed_host_resume", taskTarget(target));
}

async function destroy(target: AxDestroyTarget): Promise<void> {
  await requireInvoke()("ax_managed_host_destroy", destroyTarget(target));
}

export const desktopAxManagedHostBackend: AxManagedHostBackend = {
  provision,
  inspect,
  suspend,
  resume,
  destroy,
};
