// A task's declaration must still say what it said when it was declared.
//
// Scope lives in .backstop/tasks/<id>.json, committed on the task's own
// branch, and the gate reads it from there. So the task can edit it. Observed
// (AUDIT-04 finding 1b): scope-check fails; the task rewrites its own
// declaration to ["**"]; scope-check passes, the promotion goes through, and
// the ledger faithfully records `scope: ["**"]` — a true record of a
// constraint that constrains nothing.
//
// This is the same defect as the environment flag, in a second place: the
// breaker was taking an input from the party being gated. The fix is the one
// the recorder already uses — derive the answer from a structural artifact
// rather than believe a declaration. The artifact here is the commit that
// introduced the declaration, which `task start` makes and which a later edit
// cannot retroactively change.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { BACKSTOP_DIR } from "../policy.js";

const git = (repoDir, args) =>
  execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function declarationRelPath(taskId) {
  return path.join(BACKSTOP_DIR, "tasks", `${taskId}.json`);
}

/**
 * The declaration as it was first committed — `task start`'s own commit.
 * Returns null when no such commit exists, which is itself a finding: a
 * declaration the gate is asked to trust but cannot trace to a declaring
 * commit is exactly the tampering case.
 */
export function declarationAsDeclared(repoDir, taskId, branch) {
  const rel = declarationRelPath(taskId);
  try {
    // --diff-filter=A: the commits that ADDED this path. Take the oldest, so
    // a task that deleted and re-added its declaration cannot launder a
    // widening through the re-add.
    const adds = git(repoDir, ["log", "--diff-filter=A", "--format=%H", branch, "--", rel])
      .split("\n")
      .filter(Boolean);
    const sha = adds[adds.length - 1];
    if (!sha) return null;
    return JSON.parse(git(repoDir, ["show", `${sha}:${rel}`]));
  } catch {
    return null;
  }
}

/**
 * @returns {{ok: boolean, added: string[], before: string[]|null, unverifiable?: true}}
 *
 * Narrowing is fine — a task that restricts itself further needs no
 * permission. Only globs that were not there at declaration time are a
 * finding, because only those admit files the declaration did not.
 */
export function scopeIntegrity(repoDir, taskId, branch, currentScope) {
  const original = declarationAsDeclared(repoDir, taskId, branch);
  if (!original) {
    return { ok: false, unverifiable: true, added: [], before: null };
  }
  const before = original.scope ?? [];
  const known = new Set(before);
  const added = (currentScope ?? []).filter((glob) => !known.has(glob));
  return { ok: added.length === 0, added, before };
}
