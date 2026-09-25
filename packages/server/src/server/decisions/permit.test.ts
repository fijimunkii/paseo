import { describe, expect, test } from "vitest";

import { DecisionPermitIssuer, type DecisionPermitBinding } from "./permit.js";

function binding(seed: string): DecisionPermitBinding {
  return {
    decisionFingerprint: seed.repeat(64),
    operationFingerprint: seed.repeat(64),
    model: "jev-pinned-test",
    disposition: "allow",
  };
}

describe("DecisionPermitIssuer", () => {
  test("expires permits and refuses reuse", () => {
    let now = 1_000;
    const issuer = new DecisionPermitIssuer(100, () => now);
    const input = binding("a");
    const permit = issuer.issue(input);

    now = 1_101;
    expect(() => issuer.consume(permit, input.operationFingerprint)).toThrow("expired");
    expect(() => issuer.consume(permit, input.operationFingerprint)).toThrow(
      "missing or already consumed",
    );
  });

  test("prunes abandoned expired permits on the next issue", () => {
    let now = 1_000;
    const issuer = new DecisionPermitIssuer(100, () => now);
    const expiredBinding = binding("c");
    const expired = issuer.issue(expiredBinding);

    now = 1_101;
    issuer.issue(binding("d"));

    expect(() => issuer.consume(expired, expiredBinding.operationFingerprint)).toThrow(
      "missing or already consumed",
    );
  });

  test("consumes an exact permit once", () => {
    const issuer = new DecisionPermitIssuer(100, () => 1_000);
    const input = binding("b");
    const permit = issuer.issue(input);

    expect(permit).toMatchObject(input);
    issuer.consume(permit, input.operationFingerprint);
    expect(() => issuer.consume(permit, input.operationFingerprint)).toThrow(
      "missing or already consumed",
    );
  });

  test("burns a permit when bound decision metadata is tampered", () => {
    const issuer = new DecisionPermitIssuer(100, () => 1_000);
    const input = binding("e");
    const permit = issuer.issue(input);
    const tampered = {
      ...permit,
      model: "jev-other",
    };

    expect(() => issuer.consume(tampered, input.operationFingerprint)).toThrow("does not match");
    expect(() => issuer.consume(permit, input.operationFingerprint)).toThrow(
      "missing or already consumed",
    );
  });
});
