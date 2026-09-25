import {
  AxDestroyTargetSchema,
  AxManagedHostControlPlane,
  AxManagedHostProvisionSpecSchema,
  AxTaskTargetSchema,
} from "@getpaseo/server/ax";
import { z } from "zod";
import type { DesktopCommandHandler } from "../settings/desktop-settings-commands.js";

function parseArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown> | undefined): T {
  return schema.parse(args ?? {});
}

export function createAxManagedHostCommandHandlers(): Record<string, DesktopCommandHandler> {
  const controlPlane = new AxManagedHostControlPlane();
  return {
    ax_managed_host_provision: (args) =>
      controlPlane.provision(parseArgs(AxManagedHostProvisionSpecSchema, args)),
    ax_managed_host_inspect: async (args) => {
      const target = parseArgs(AxTaskTargetSchema, args);
      return controlPlane.inspectTask(target);
    },
    ax_managed_host_suspend: (args) => controlPlane.suspend(parseArgs(AxTaskTargetSchema, args)),
    ax_managed_host_resume: (args) => controlPlane.resume(parseArgs(AxTaskTargetSchema, args)),
    ax_managed_host_destroy: (args) => controlPlane.destroy(parseArgs(AxDestroyTargetSchema, args)),
  };
}
