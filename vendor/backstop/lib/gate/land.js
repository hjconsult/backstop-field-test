// Landing a promotion from a worktree, where the base branch belongs to
// someone else's working tree.
//
// AUDIT-05 F9's third case. Claude Code, Cursor and Codex all run parallel
// agents in git worktrees, so the shape is: one clone on `main`, N worktrees
// on `task/*`. Promotion from a worktree died on its last step —
//
//   fatal: 'main' is already used by worktree at '/…'
//
// — because `promote` checked out the base branch in the caller's tree in
// order to merge into it. Every one of the ten checks passed first; only the
// landing failed. Reproduced before anything was changed.
//
// The constraint is real and git is right to enforce it: worktrees share one
// `.git`, so `refs/heads/main` is shared. Moving it while another worktree has
// it checked out leaves that tree's index describing a commit its HEAD no
// longer names, and `git status` there reports the whole promotion as
// uncommitted local deletions. Nothing here will do that to a tree it does not
// own — "unrelated work is not collateral" applies to a colleague's checkout
// as much as to a revert.
//
// So the work lands where a fleet's base branch actually lives: the remote.
// The merge is built and committed in a gate-owned detached worktree and
// pushed to base. The local base ref is left where it was, which is the
// ordinary state of anyone's local `main` after a colleague merges. If the
// push is rejected, nothing is kept — no local commit, no ledger record
// claiming a promotion that did not land.

import { execFileSync } from "node:child_process";
import { appendRecord, recordPromoted, commitLedger } from "../ledger-store.js";
import { withGateWorktree, GATE_IDENTITY } from "./merge-preview.js";

const git = (dir, args) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * The worktree that currently has `branch` checked out, or null.
 * Read from git's own bookkeeping rather than guessed from paths.
 */
export function worktreeHolding(repoDir, branch) {
  let listing;
  try {
    listing = git(repoDir, ["worktree", "list", "--porcelain"]);
  } catch {
    return null; // not a worktree-capable git, or not a repo — caller falls back
  }
  let current = null;
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return current;
  }
  return null;
}

/** This checkout's own root, so a worktree can tell whether it holds base itself. */
export function worktreeRoot(repoDir) {
  try {
    return git(repoDir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

function remoteUrl(repoDir) {
  try {
    return git(repoDir, ["remote", "get-url", "origin"]) || null;
  } catch {
    return null;
  }
}

/**
 * Merge `branch` into `base` without touching any working tree but a
 * throwaway one, and land the result on the remote.
 *
 * @returns {{landed: true, mergeCommit: string, pushedTip: string, pushedTo: string}}
 *        | {landed: false, detail: string}
 */
export function landOnRemote(repoDir, { base, branch, taskId, at, record, holder }) {
  const remote = remoteUrl(repoDir);
  if (!remote) {
    return {
      landed: false,
      detail:
        `${base} is checked out in ${holder}, so promoting from here cannot move it ` +
        "without corrupting that working tree's index, and there is no remote to land on " +
        `instead. Promote from ${holder}, or switch it off ${base}, or add an origin remote.`,
    };
  }

  const { result } = withGateWorktree(repoDir, base, (worktree) => {
    // Same order as the in-place path: the attempt is recorded before the
    // merge, so a promotion that fails halfway is never invisible (TL17).
    appendRecord(worktree, { event: "promotion-started", taskId, branch, at });

    let mergeCommit;
    try {
      git(worktree, [...GATE_IDENTITY, "merge", "--no-ff", "-m", `Promote ${taskId}`, branch]);
      mergeCommit = git(worktree, ["rev-parse", "HEAD"]);
    } catch (err) {
      const detail = (err.stderr?.toString() || err.message).split("\n")[0];
      appendRecord(worktree, { event: "promotion-failed", taskId, branch, at, detail });
      commitLedger(worktree, { message: `Ledger: ${taskId} promotion failed`, taskId });
      // Push the failure record too. TL3: a gate that stops work and leaves no
      // trace is indistinguishable afterwards from one that never ran, and in
      // this path the only durable place for that trace is the remote.
      try {
        git(worktree, ["push", "origin", `HEAD:refs/heads/${base}`]);
      } catch { /* the merge already failed; a rejected trace does not change that */ }
      return { landed: false, detail };
    }

    recordPromoted(worktree, { ...record, mergeCommit });
    commitLedger(worktree, { message: `Ledger: ${taskId} promoted`, taskId });
    const pushedTip = git(worktree, ["rev-parse", "HEAD"]);

    try {
      git(worktree, ["push", "origin", `HEAD:refs/heads/${base}`]);
    } catch (err) {
      const stderr = (err.stderr?.toString() || err.message).trim();
      // The worktree is discarded on the way out, so a rejected push leaves
      // nothing behind — no local commit, and no ledger record asserting a
      // promotion that never landed. That is the property worth keeping.
      const behind = /non-fast-forward|fetch first|rejected/.test(stderr)
        ? ` Local ${base} is behind origin/${base}: fetch and promote again.`
        : "";
      return { landed: false, detail: `push to origin/${base} was rejected — nothing was kept.${behind}` };
    }

    return { landed: true, mergeCommit, pushedTip, pushedTo: `origin/${base}` };
  });

  return result;
}
