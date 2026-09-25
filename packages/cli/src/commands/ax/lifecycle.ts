import { AxManagedHostControlPlane } from "@getpaseo/server/ax";
import type { Command } from "commander";
import type { CommandOptions, SingleResult } from "../../output/index.js";
import {
  axHostSchema,
  resolveAxDestroyTarget,
  resolveAxTarget,
  toAxHostRow,
  type AxCommandOptions,
  type AxHostRow,
} from "./shared.js";

export async function runAxInspectCommand(
  taskName: string,
  options: CommandOptions & AxCommandOptions,
  _command: Command,
): Promise<SingleResult<AxHostRow>> {
  const target = resolveAxTarget(options);
  const controlPlane = new AxManagedHostControlPlane();
  const status = await controlPlane.inspectTask({ ...target, taskName });
  return {
    type: "single",
    data: toAxHostRow({ task: taskName, target, status: status.phase }),
    schema: axHostSchema,
  };
}

export async function runAxSuspendCommand(
  taskName: string,
  options: CommandOptions & AxCommandOptions,
  _command: Command,
): Promise<SingleResult<AxHostRow>> {
  const target = resolveAxTarget(options);
  const controlPlane = new AxManagedHostControlPlane();
  await controlPlane.suspend({ ...target, taskName });
  return {
    type: "single",
    data: toAxHostRow({ task: taskName, target, status: "Suspended" }),
    schema: axHostSchema,
  };
}

export async function runAxResumeCommand(
  taskName: string,
  options: CommandOptions & AxCommandOptions,
  _command: Command,
): Promise<SingleResult<AxHostRow>> {
  const target = resolveAxTarget(options);
  const controlPlane = new AxManagedHostControlPlane();
  await controlPlane.resume({ ...target, taskName });
  return {
    type: "single",
    data: toAxHostRow({ task: taskName, target, status: "Running" }),
    schema: axHostSchema,
  };
}

export async function runAxDestroyCommand(
  taskName: string,
  options: CommandOptions & AxCommandOptions,
  _command: Command,
): Promise<SingleResult<AxHostRow>> {
  const target = resolveAxDestroyTarget(taskName, options);
  const controlPlane = new AxManagedHostControlPlane();
  await controlPlane.destroy(target);
  return {
    type: "single",
    data: toAxHostRow({ task: taskName, target, status: "Destroyed" }),
    schema: axHostSchema,
  };
}
