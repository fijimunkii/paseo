import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonOption } from "../../utils/command-options.js";
import {
  runAxDestroyCommand,
  runAxInspectCommand,
  runAxResumeCommand,
  runAxSuspendCommand,
} from "./lifecycle.js";
import { runAxProvisionCommand } from "./provision.js";

function addAxTargetOptions<T extends Command>(command: T): T {
  return command
    .requiredOption("--context <context>", "Kubernetes context containing AX")
    .option("--namespace <namespace>", "Kubernetes namespace where AX is installed", "ax-system")
    .option("--atespace <atespace>", "AX atespace", "default");
}

function addAxDestroyOptions<T extends Command>(command: T): T {
  return addAxTargetOptions(command)
    .requiredOption("--workspace <name>", "Exact AX workspace name returned by provision")
    .requiredOption("--gateway <name>", "Exact AX gateway name returned by provision");
}

export function createAxCommand(): Command {
  const ax = new Command("ax").description(
    "Manage Paseo hosts backed by Google Agent Executor (AX)",
  );

  addJsonOption(
    addAxTargetOptions(
      ax
        .command("provision")
        .description("Provision a Paseo daemon inside an AX task")
        .argument("<task-name>", "AX task name")
        .option("--image <image>", "Paseo AX image")
        .option("--repo <url>", "Git repository to prepare in the AX workspace")
        .option("--branch <branch>", "Git branch to prepare")
        .option("--egress-host <host...>", "Replace the default HTTPS egress allowlist")
        .option("--cpu-request <cpu>", "CPU request, e.g. 500m")
        .option("--memory-request <memory>", "Memory request, e.g. 1Gi")
        .option("--cpu-limit <cpu>", "CPU limit, e.g. 2")
        .option("--memory-limit <memory>", "Memory limit, e.g. 4Gi"),
    ),
  ).action(withOutput(runAxProvisionCommand));

  addJsonOption(
    addAxTargetOptions(
      ax.command("inspect").description("Inspect an AX-backed Paseo host").argument("<task-name>"),
    ),
  ).action(withOutput(runAxInspectCommand));

  addJsonOption(
    addAxTargetOptions(
      ax
        .command("suspend")
        .description("Suspend an idle AX-backed Paseo host")
        .argument("<task-name>"),
    ),
  ).action(withOutput(runAxSuspendCommand));

  addJsonOption(
    addAxTargetOptions(
      ax.command("resume").description("Resume an AX-backed Paseo host").argument("<task-name>"),
    ),
  ).action(withOutput(runAxResumeCommand));

  addJsonOption(
    addAxDestroyOptions(
      ax
        .command("destroy")
        .description("Destroy an AX task and its managed workspace/gateway")
        .argument("<task-name>"),
    ),
  ).action(withOutput(runAxDestroyCommand));

  return ax;
}
