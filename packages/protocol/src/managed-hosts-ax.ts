import { z } from "zod";

export const DEFAULT_AX_IMAGE = "ghcr.io/fijimunkii/paseo-ax:latest";
export const DEFAULT_AX_NAMESPACE = "ax-system";
export const DEFAULT_AX_ATESPACE = "default";
export const DEFAULT_AX_EGRESS_HOSTS = [
  "relay.paseo.sh",
  "github.com",
  "api.github.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
  "api.openai.com",
  "api.anthropic.com",
] as const;

export const AxTargetSchema = z.strictObject({
  kubeContext: z.string().trim().min(1),
  namespace: z.string().trim().min(1),
  atespace: z.string().trim().min(1),
});

const AxExecutionOptionsSchema = z.strictObject({
  taskName: z.string().trim().min(1),
  image: z.string().trim().min(1),
  repo: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  egressHosts: z.array(z.string().trim().min(1)).min(1),
  cpuRequest: z.string().trim().min(1).optional(),
  memoryRequest: z.string().trim().min(1).optional(),
  cpuLimit: z.string().trim().min(1).optional(),
  memoryLimit: z.string().trim().min(1).optional(),
});

export const AxManagedHostProvisionSpecSchema = AxTargetSchema.extend(
  AxExecutionOptionsSchema.shape,
);

export const AxManagedHostSpecSchema = AxManagedHostProvisionSpecSchema.extend({
  workspaceName: z.string().trim().min(1),
  gatewayName: z.string().trim().min(1),
});

export const AxManagedHostLifecycleSchema = AxTargetSchema.extend({
  kind: z.literal("ax"),
  taskName: z.string().trim().min(1),
  workspaceName: z.string().trim().min(1),
  gatewayName: z.string().trim().min(1),
});

export const AxTaskTargetSchema = AxTargetSchema.extend({
  taskName: z.string().trim().min(1),
});

export const AxDestroyTargetSchema = AxTaskTargetSchema.extend({
  workspaceName: z.string().trim().min(1),
  gatewayName: z.string().trim().min(1),
});

export const AxProvisionResultSchema = z.strictObject({
  pairingUrl: z.string().trim().min(1),
  lifecycle: AxManagedHostLifecycleSchema,
});

export type AxTarget = z.infer<typeof AxTargetSchema>;
export type AxManagedHostProvisionSpec = z.infer<typeof AxManagedHostProvisionSpecSchema>;
export type AxManagedHostSpec = z.infer<typeof AxManagedHostSpecSchema>;
export type AxManagedHostLifecycle = z.infer<typeof AxManagedHostLifecycleSchema>;
export type AxTaskTarget = z.infer<typeof AxTaskTargetSchema>;
export type AxDestroyTarget = z.infer<typeof AxDestroyTargetSchema>;
export type AxProvisionResult = z.infer<typeof AxProvisionResultSchema>;
