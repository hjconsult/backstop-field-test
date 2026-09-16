// Policy lives as versioned data in the repo (DECISIONS.md D18), not in
// code and not in a service: git already versions, diffs and reverts it,
// which makes a policy change a unit of work like any other. Everything in
// here is constitutional tier — an agent may propose a change, only the
// founder approves one (D8), which is why scope-check treats this file as
// always out of scope (D15).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const BACKSTOP_DIR = ".backstop";
export const POLICY_FILE = path.join(BACKSTOP_DIR, "policy.json");

export const DEFAULT_POLICY = {
  version: 1,
  // The command that decides "does this actually work" — structural
  // validation at the gate, and the post-revert check (D2). Null means
  // unset, which blocks promotion rather than passing silently.
  verifyCommand: null,
  // A verify command that never finishes is a failure, not a pass — see
  // lib/verify.js. Per project, because a monorepo's suite and a small
  // service's are not the same length of patience.
  verifyTimeoutMs: 600_000,
  budget: { limit: null, unit: "usd" },
  // Registered policy plugins, enabled per project. Names resolve through
  // lib/policy/registry.js; an enabled-but-unregistered name fails the gate
  // rather than being ignored.
  checks: {},
  meters: {},
  environments: {
    production: { live: true, realUsers: true },
    preview: { live: false, realUsers: false },
  },
  // Files several tasks touch without depending on one another — see
  // DEFAULT_LINEAGE_IGNORE in lib/ledger.js for why this is configurable.
  lineageIgnore: null,
  baseBranch: "main",
};

export function policyPath(repoDir) {
  return path.join(repoDir, POLICY_FILE);
}

export function loadPolicy(repoDir) {
  const file = policyPath(repoDir);
  if (!existsSync(file)) return { ...DEFAULT_POLICY, configured: false };
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return {
    ...DEFAULT_POLICY,
    ...raw,
    budget: { ...DEFAULT_POLICY.budget, ...(raw.budget ?? {}) },
    checks: { ...(raw.checks ?? {}) },
    meters: { ...(raw.meters ?? {}) },
    environments: { ...DEFAULT_POLICY.environments, ...(raw.environments ?? {}) },
    configured: true,
  };
}

export function writePolicy(repoDir, policy) {
  mkdirSync(path.join(repoDir, BACKSTOP_DIR), { recursive: true });
  const { configured, ...rest } = policy;
  writeFileSync(policyPath(repoDir), JSON.stringify(rest, null, 2) + "\n");
  return policyPath(repoDir);
}

/** The exposure record for an environment; unknown environments are treated as live. */
export function exposureFor(policy, environment) {
  return policy.environments[environment] ?? STRICTEST_EXPOSURE;
}

/** The safe reading of an environment we cannot establish anything about. */
export const STRICTEST_EXPOSURE = { live: true, realUsers: true };

const strictness = (e) => (e?.live ? 1 : 0) + (e?.realUsers ? 1 : 0);

/**
 * Which environment a promotion is actually against — derived where possible,
 * never merely declared.
 *
 * The gate used to take the environment from `--env`, a flag chosen by the
 * caller, and `dialSeverity` then correctly dialled severity for whatever it
 * was handed. Nothing bound that name to where the code actually goes, so an
 * agent blocked against production passed `--env preview` and the identical
 * findings came back `proceed-logged` (AUDIT-04 finding 1a). The recorder
 * refuses an agent's account of its own work; the breaker was accepting one
 * for the input that decides whether it blocks.
 *
 * An environment may declare `branches: [...]`, which is a structural fact:
 * promotion merges into `baseBranch`, so the branch says which environment
 * this really is. A declared name that agrees is corroborated. A declared name
 * that is *stricter* is honoured — asking for more scrutiny needs no proof. A
 * declared name that is looser than what we can establish is a conflict: the
 * stricter reading wins and the attempt is reported, because a downgrade that
 * silently failed would leave no trace that it was tried (TL3).
 *
 * With no `branches` mapping anywhere there is nothing to corroborate against,
 * and the safe reading of "unknown" is the strict one. That is the same rule
 * `dialSeverity` already applies to a contradictory `realUsers`: a declaration
 * can make the gate stricter, never looser.
 */
export function resolveEnvironment(policy, declaredName, { baseBranch } = {}) {
  const environments = policy.environments ?? {};
  const declared = environments[declaredName] ?? null;
  const derived = baseBranch
    ? Object.entries(environments).find(([, e]) => (e.branches ?? []).includes(baseBranch))
    : undefined;

  if (derived) {
    const [derivedName, derivedExposure] = derived;
    if (!declaredName || declaredName === derivedName) {
      return { name: derivedName, exposure: derivedExposure, corroborated: true, conflict: null };
    }
    if (strictness(declared ?? STRICTEST_EXPOSURE) >= strictness(derivedExposure)) {
      return { name: declaredName, exposure: declared ?? STRICTEST_EXPOSURE, corroborated: true, conflict: null };
    }
    return {
      name: derivedName,
      exposure: derivedExposure,
      corroborated: true,
      conflict:
        `--env ${declaredName} is looser than the environment this promotion is actually against: ` +
        `policy.json maps base branch "${baseBranch}" to ${derivedName}`,
    };
  }

  const declaredIsLooser = strictness(declared ?? STRICTEST_EXPOSURE) < strictness(STRICTEST_EXPOSURE);
  return {
    name: declaredName ?? "production",
    exposure: STRICTEST_EXPOSURE,
    corroborated: false,
    conflict: declaredIsLooser
      ? `--env ${declaredName} cannot be corroborated: no environment in policy.json claims base branch ` +
        `"${baseBranch ?? "(unknown)"}". Add "branches": ["${baseBranch ?? "..."}"] to the environment it belongs to.`
      : null,
  };
}


/**
 * The ledger is append-only and line-oriented, which is exactly what git's
 * built-in `union` merge driver is for: it keeps both sides' lines instead of
 * raising a conflict.
 *
 * Without it, the tool's own recovery advice failed. A promotion that hit a
 * merge problem committed "Ledger: X promotion failed" onto the task branch,
 * and "rebase onto main and promote again" then died with
 * `CONFLICT (content): Merge conflict in .backstop/ledger.jsonl` — the tool
 * telling the operator to do something the tool had made impossible
 * (AUDIT-05 F9). Measured: rebase exit 1 with a conflict before, exit 0 with
 * zero conflicts after.
 *
 * Union is right rather than `ours` or `theirs` because both sides' records
 * are true. Two branches that each appended a real event must end up with both
 * events; picking a side would discard one, which is the recorder losing a
 * record to make a merge tidy.
 */
export const LEDGER_GITATTRIBUTES = ".backstop/ledger.jsonl merge=union\n";

/**
 * Ensure the repository's .gitattributes carries the union driver. Appends
 * rather than overwrites: a project's own attributes are not ours to replace.
 * @returns {"added" | "already-present"}
 */
export function ensureLedgerMergeDriver(repoDir) {
  const file = path.join(repoDir, ".gitattributes");
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (existing.includes(".backstop/ledger.jsonl")) return "already-present";
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(file, existing + separator + LEDGER_GITATTRIBUTES);
  return "added";
}
