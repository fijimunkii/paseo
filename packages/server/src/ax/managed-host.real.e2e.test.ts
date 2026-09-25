import { randomBytes } from "node:crypto";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { test, expect } from "vitest";
import {
  AxManagedHostControlPlane,
  type AxManagedHostLifecycle,
  type AxManagedHostProvisionSpec,
} from "./managed-host.js";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when RUN_AX_REAL_E2E=1`);
  return value;
}

test(
  "provisions, pairs, suspends, resumes, and destroys a real AX-backed Paseo host",
  async (context) => {
    if (process.env.RUN_AX_REAL_E2E !== "1") {
      context.skip();
    }

    const suffix = randomBytes(4).toString("hex");
    const taskName = `paseo-real-${suffix}`;
    const spec: AxManagedHostProvisionSpec = {
      kubeContext: requiredEnv("AX_TEST_CONTEXT"),
      namespace: process.env.AX_TEST_NAMESPACE?.trim() || "ax-system",
      atespace: process.env.AX_TEST_ATESPACE?.trim() || "default",
      taskName,
      image: requiredEnv("AX_TEST_IMAGE"),
      egressHosts: ["relay.paseo.sh"],
    };

    const controlPlane = new AxManagedHostControlPlane();
    let lifecycle: AxManagedHostLifecycle | null = null;
    try {
      const result = await controlPlane.provision(spec);
      lifecycle = result.lifecycle;
      expect(parseConnectionOfferFromUrl(result.pairingUrl)).not.toBeNull();

      await expect(controlPlane.inspectTask(lifecycle)).resolves.toMatchObject({
        phase: "Running",
        ready: true,
      });

      await controlPlane.suspend(lifecycle);
      await expect(controlPlane.inspectTask(lifecycle)).resolves.toMatchObject({
        phase: "Suspended",
      });

      await controlPlane.resume(lifecycle);
      await expect(controlPlane.inspectTask(lifecycle)).resolves.toMatchObject({
        phase: "Running",
        ready: true,
      });
    } finally {
      if (lifecycle) {
        await controlPlane.destroy(lifecycle);
      }
    }
  },
  10 * 60_000,
);
