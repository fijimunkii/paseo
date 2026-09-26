import { AxManagedHostControlPlane } from "@getpaseo/server/ax";
import type { Command } from "commander";
import type { CommandOptions, SingleResult } from "../../output/index.js";
import {
  axHostSchema,
  resolveAxManagedHostProvisionSpec,
  toAxHostRow,
  type AxCommandOptions,
  type AxHostRow,
} from "./shared.js";

export async function runAxProvisionCommand(
  taskName: string,
  options: CommandOptions & AxCommandOptions,
  _command: Command,
): Promise<SingleResult<AxHostRow>> {
  const spec = resolveAxManagedHostProvisionSpec(taskName, options);
  const controlPlane = new AxManagedHostControlPlane();
  const result = await controlPlane.provision(spec);
  return {
    type: "single",
    data: toAxHostRow({
      task: spec.taskName,
      target: spec,
      status: "Running",
      workspace: result.lifecycle.workspaceName,
      gateway: result.lifecycle.gatewayName,
      pairingUrl: result.pairingUrl,
    }),
    schema: axHostSchema,
  };
}
