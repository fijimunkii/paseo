import { randomUUID } from "node:crypto";

export interface DecisionPermit {
  id: string;
  fingerprint: string;
  expiresAt: number;
}

interface PermitRecord extends DecisionPermit {
  consumed: boolean;
}

export class DecisionPermitIssuer {
  private readonly records = new Map<string, PermitRecord>();

  constructor(
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(fingerprint: string): DecisionPermit {
    const permit: PermitRecord = {
      id: randomUUID(),
      fingerprint,
      expiresAt: this.now() + this.ttlMs,
      consumed: false,
    };
    this.records.set(permit.id, permit);
    return {
      id: permit.id,
      fingerprint: permit.fingerprint,
      expiresAt: permit.expiresAt,
    };
  }

  consume(permit: DecisionPermit, expectedFingerprint: string): void {
    const record = this.records.get(permit.id);
    if (!record || record.consumed) {
      throw new Error("Decision permit is missing or already consumed");
    }
    if (record.fingerprint !== expectedFingerprint || permit.fingerprint !== expectedFingerprint) {
      this.records.delete(permit.id);
      throw new Error("Decision permit does not match the authorized operation");
    }
    if (record.expiresAt !== permit.expiresAt || record.expiresAt <= this.now()) {
      this.records.delete(permit.id);
      throw new Error("Decision permit has expired");
    }
    record.consumed = true;
    this.records.delete(permit.id);
  }
}
