// Stage 0: one hardcoded budget stop, enforced, not advisory. No general
// multi-category framework yet — see docs/plan/STAGES.md for why that's
// deliberately deferred. This one check exists because it's cheap and it
// closes a real, previously-observed gap: a check that logs a warning but
// doesn't actually halt execution is not a check, it's a note nobody reads.

export class BudgetExceededError extends Error {
  constructor(spent, limit) {
    super(`Budget exceeded: ${spent} > limit ${limit}. Halting before proceeding.`);
    this.name = "BudgetExceededError";
    this.spent = spent;
    this.limit = limit;
  }
}

/**
 * The single definition of "is this over budget", used by the gate and by
 * enforceBudget alike. It used to exist twice: this module, and an inline
 * comparison inside the gate that was the only one actually running. The
 * duplicate had a hole this one closes.
 *
 * Returns "unset" | "no-reading" | "ok" | "over" | "invalid".
 */
export function classifyBudget(spent, limit) {
  if (limit == null) return "unset";
  // A limit that is present but not a usable number is a misconfiguration, and
  // it blocks. The inline version compared `spent > "abc"`, which is false for
  // every NaN comparison — so a garbage limit reported 999999 usd as a PASS.
  // Same defect as TL12's meter limits; the built-in budget sitting in another
  // file is exactly how it survived that fix.
  if (!Number.isFinite(limit)) return "invalid";
  if (spent == null) return "no-reading";
  if (!Number.isFinite(spent)) return "invalid";
  return spent > limit ? "over" : "ok";
}

/** Throws if spend would exceed the limit. Called BEFORE the spending
 * action proceeds, not after — a halt that happens after the money's
 * already spent isn't a breaker, it's a postmortem. */
export function enforceBudget(spent, limit) {
  const verdict = classifyBudget(spent, limit);
  if (verdict === "over" || verdict === "invalid") {
    throw new BudgetExceededError(spent, limit);
  }
  return true;
}
