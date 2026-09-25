import { AxManagedHostLifecycleSchema } from "@getpaseo/protocol/managed-hosts-ax";
import { z } from "zod";

export const HostLifecycleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unmanaged") }),
  AxManagedHostLifecycleSchema,
]);

export const StoredHostLifecycleSchema = z.union([z.strictObject({}), HostLifecycleSchema]);

export type HostLifecycle = z.infer<typeof HostLifecycleSchema>;
type StoredHostLifecycle = z.infer<typeof StoredHostLifecycleSchema>;

export function defaultHostLifecycle(): HostLifecycle {
  return { kind: "unmanaged" };
}

export function normalizeStoredHostLifecycle(
  lifecycle: StoredHostLifecycle | undefined,
): HostLifecycle {
  const parsed = HostLifecycleSchema.safeParse(lifecycle);
  return parsed.success ? parsed.data : defaultHostLifecycle();
}
