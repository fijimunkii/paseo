import { randomUUID } from "node:crypto";

export interface DecisionPermit {
  id: string;
  decisionFingerprint: string;
  operationFingerprint: string;
  model: string | null;
  disposition: "allow";
  expiresAt: number;
}

export interface DecisionPermitBinding {
  decisionFingerprint: string;
  operationFingerprint: string;
  model: string | null;
  disposition: "allow";
}

type PermitRecord = DecisionPermit;

export class DecisionPermitIssuer {
  private readonly records = new Map<string, PermitRecord>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(binding: DecisionPermitBinding): DecisionPermit {
    this.pruneExpired();
    const permit: PermitRecord = {
      id: randomUUID(),
      ...binding,
      expiresAt: this.now() + this.ttlMs,
    };
    this.records.set(permit.id, permit);
    return { ...permit };
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(id);
      }
    }
  }

  consume(permit: DecisionPermit, expectedOperationFingerprint: string): void {
    const record = this.records.get(permit.id);
    if (!record) {
      throw new Error("Decision permit is missing or already consumed");
    }

    const matchesBinding =
      record.decisionFingerprint === permit.decisionFingerprint &&
      record.operationFingerprint === permit.operationFingerprint &&
      record.model === permit.model &&
      record.disposition === permit.disposition &&
      record.expiresAt === permit.expiresAt;

    if (
      !matchesBinding ||
      record.operationFingerprint !== expectedOperationFingerprint ||
      permit.operationFingerprint !== expectedOperationFingerprint
    ) {
      this.records.delete(permit.id);
      throw new Error("Decision permit does not match the authorized operation");
    }
    if (record.expiresAt <= this.now()) {
      this.records.delete(permit.id);
      throw new Error("Decision permit has expired");
    }
    this.records.delete(permit.id);
  }
}
