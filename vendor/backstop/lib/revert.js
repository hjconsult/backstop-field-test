// Performs the actual git revert operations for a cascade revert. Reverts
// affected commits newest-first (the safe order — undo the most recent
// change before the one it was built on) using real `git revert`, never a
// hand-rolled diff/patch.

import { execFileSync } from "node:child_process";
import { runVerify } from "./verify.js";

export function revertCommits(repoDir, commits) {
  // commits arrive oldest-first (repo-chronological); revert newest-first.
  const newestFirst = [...commits].reverse();
  const results = [];
  for (const { sha, taskId } of newestFirst) {
    try {
      execFileSync(
        "git",
        ["revert", "--no-edit", "-m", "1", sha],
        { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] },
      );
      results.push({ sha, taskId, status: "reverted" });
    } catch (err) {
      // A merge commit has no parent 1 in a linear history; retry as a
      // normal revert before giving up.
      try {
        execFileSync("git", ["revert", "--no-edit", sha], {
          cwd: repoDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        results.push({ sha, taskId, status: "reverted" });
      } catch (err2) {
        results.push({
          sha,
          taskId,
          status: "failed",
          error: err2.stderr?.toString() || err2.message,
        });
        // Stop on first failure — do not keep reverting into an unknown
        // state. This is a hard blocker for a human, not something to push
        // through silently.
        break;
      }
    }
  }
  return results;
}

/**
 * An undo that git performed successfully is not an undo that worked
 * (DECISIONS.md D2). File-overlap edges miss cross-file dependencies — an
 * importer the cascade never touched still breaks — so the reverted tree
 * gets the project's own verify command run against it, and a task ends up
 * `reverted+verified` or `reverted+broken`. Broken is never promotable, and
 * it is reported, not swallowed.
 */
export function revertWithVerification(repoDir, commits, verifyCommand, { timeoutMs } = {}) {
  const results = revertCommits(repoDir, commits);
  if (results.some((r) => r.status === "failed")) {
    return { results, verification: null, status: "revert-failed" };
  }
  const verification = runVerify(repoDir, verifyCommand, timeoutMs ? { timeoutMs } : {});
  return {
    results,
    verification,
    status: verification.ok ? "reverted+verified" : "reverted+broken",
  };
}
