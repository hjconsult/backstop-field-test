// Resolving a branch name to a ref that exists in THIS clone.
//
// A development clone has `refs/heads/main`. A CI clone, as `actions/checkout`
// leaves it, has no local branches at all — only `refs/remotes/origin/main` —
// so every plain `main` in a git command is an unknown revision there.
//
// This lived inside the gate, where TL48 first needed it, and the rest of the
// codebase went on using raw branch names. That is how it reached a real
// runner: `structural-validation` resolved its refs and passed, and two checks
// later `git rev-list main` died with "unknown revision". Applying a rule in
// the one place that failed, and not where the same rule holds, is the shape
// behind several of this project's defects — so it lives here now, below both
// the gate and the ledger, and both take it from the same place.

import { execFileSync } from "node:child_process";

const git = (args, repoDir) =>
  execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * @returns {string|null} a ref that exists, preferring the local branch, or
 *   null when neither exists — which callers must treat as unknowable rather
 *   than as an empty answer.
 */
export function resolveRef(repoDir, branch) {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    try {
      git(["rev-parse", "--verify", ref], repoDir);
      return ref;
    } catch { /* try the next candidate */ }
  }
  return null;
}
