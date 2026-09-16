// Verify the merge RESULT, in a worktree the gate owns, with the gate's own
// state removed from it.
//
// This closes two of the three highest-severity findings at once, because they
// turned out to be one mistake wearing two faces.
//
// AUDIT-04 §2: the gate ran verify in whatever tree the operator happened to
// be standing in. Promoting from the base branch — the natural path, and the
// one the gate is designed to support — meant verifying base, which was
// already green. A branch that broke the build was promoted with
// "verify command passed" written into the ledger, and main was left failing.
// The check was not weak; it was answering a different question.
//
// AUDIT-05 F7: verify runs code the gated party wrote, as the same user, with
// `.backstop/` writable. A task's test file appended a forged record and
// `commitLedger` committed `promoted:GHOST` onto main. The same run rewrote
// policy.json to disable the gate for every later task, and the rewrite
// survived because `task start`'s dirty-tree guard deliberately excludes
// `.backstop/`. The breaker was running the agent's code and then believing
// its own files.
//
// A private worktree fixes both. The merge result is what gets verified, so
// the answer is about the code that would actually land. The worktree is
// created by the gate, stripped of `.backstop/` before any agent code runs,
// and destroyed afterwards — so whatever verify writes there is discarded
// with it, and the real ledger and policy are not reachable from the process
// that the gated party controls.
//
// It also means the operator's working tree is never touched by the gate.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKSTOP_DIR } from "../policy.js";

const git = (repoDir, args) =>
  execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * The gate acts as itself, never as whoever happens to be logged in.
 *
 * A stock GitHub Actions runner has no `user.name` or `user.email` — nothing
 * in the default setup configures one — so `git merge` died with
 * `fatal: empty ident name (for <runner@runnervm….internal.cloudapp.net>)`
 * on the very first gate run against a real host. Every PR would have been
 * blocked, on the most ordinary CI configuration there is, and (until the
 * preview stopped swallowing git's error) the message would have said the
 * branch did not merge cleanly.
 *
 * Passing the identity per-invocation rather than writing it into the repo's
 * config keeps it out of the operator's settings, and it is the same identity
 * every time, so a merge the gate built is attributable to the gate.
 */
export const GATE_IDENTITY = [
  "-c", "user.name=Backstop gate",
  "-c", "user.email=gate@backstop.invalid",
];

const gitAsGate = (repoDir, args) => git(repoDir, [...GATE_IDENTITY, ...args]);

/**
 * Build the merge of `branch` into `base` in a throwaway worktree and hand it
 * to `fn`. Never mutates the repository: the worktree is detached, no branch
 * moves, and the merge is left uncommitted.
 *
 * @returns {{mergeable: boolean, conflicts: string[], result: unknown}}
 *   `result` is whatever `fn(dir)` returned, or null when the merge conflicted
 *   — there is no merge result to verify, and saying so is the honest answer.
 */
// Worktrees are cheap to create and easy to accumulate. A gate killed by a CI
// timeout, an OOM, or a Ctrl-C never reaches its `finally`, and leaves behind a
// full checkout plus an entry in .git/worktrees/ that nothing later removes.
// Hundreds of runs of that is a clogged disk and a `git worktree list` nobody
// can read — a failure mode this project's own founder has lived through on
// other systems, and the reason the discipline here is explicit rather than
// assumed.
//
// So each worktree carries the pid of the process that made it, and every gate
// run sweeps the ones whose process is gone before creating its own. That is
// self-healing without being dangerous: a live concurrent gate run's worktree
// has a live pid and is never touched.
const PREFIX = "backstop-gate-";

const isAlive = (pid) => {
  try {
    process.kill(pid, 0); // signal 0 tests existence without delivering anything
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists, owned by someone else — not ours to reap
  }
};

function gateWorktrees(repoDir) {
  let listing;
  try {
    listing = git(repoDir, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  return listing
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter((dir) => path.basename(dir).startsWith(PREFIX))
    .map((dir) => ({ dir, pid: Number.parseInt(path.basename(dir).slice(PREFIX.length), 10) }));
}

/**
 * Remove gate worktrees whose creating process is no longer running, and drop
 * the git metadata for any whose directory is already gone.
 *
 * @returns {{removed: string[], stuck: string[]}} `stuck` is a worktree we
 *   could not remove — almost always a verify command that outlived the gate
 *   and still holds files open. Reported rather than swallowed, because the
 *   alternative is exactly the silent accumulation this exists to prevent.
 */
export function sweepGateWorktrees(repoDir) {
  try {
    git(repoDir, ["worktree", "prune"]);
  } catch { /* prune is advisory; a failure here must not block a promotion */ }

  const removed = [];
  const stuck = [];
  for (const { dir, pid } of gateWorktrees(repoDir)) {
    if (Number.isFinite(pid) && isAlive(pid)) continue; // a concurrent gate run
    try {
      git(repoDir, ["worktree", "remove", "--force", dir]);
      removed.push(dir);
    } catch {
      try {
        rmSync(dir, { recursive: true, force: true });
        git(repoDir, ["worktree", "prune"]);
        removed.push(dir);
      } catch {
        stuck.push(dir);
      }
    }
  }
  return { removed, stuck };
}

/**
 * Build the merge of `branch` into `base` in a throwaway worktree and hand it
 * to `fn`. Never mutates the repository: the worktree is detached, no branch
 * moves, and the merge is left uncommitted.
 *
 * @returns {{mergeable: boolean, conflicts: string[], result: unknown, leaked?: string[]}}
 *   `result` is whatever `fn(dir)` returned, or null when the merge conflicted
 *   — there is no merge result to verify, and saying so is the honest answer.
 */
/**
 * A detached, gate-owned worktree at `at`, handed to `fn`, removed afterwards
 * whatever happens. Extracted so the landing path (lib/gate/land.js) creates
 * its worktrees the same way this one does — same prefix, so the same sweep
 * reclaims both, which is the whole reason the pid tagging exists.
 *
 * @returns {{result: unknown, leaked: string[]}} `leaked` is worktrees the
 *   sweep could not remove; reported rather than swallowed.
 */
export function withGateWorktree(repoDir, at, fn) {
  // Before creating another one, clear any left by runs that died. Doing this
  // at the START rather than only at the end is what makes a killed gate
  // self-correcting instead of cumulative.
  const swept = sweepGateWorktrees(repoDir);

  const worktree = mkdtempSync(path.join(tmpdir(), `${PREFIX}${process.pid}-`));
  // mkdtemp created it; `git worktree add` insists on making it itself.
  rmSync(worktree, { recursive: true, force: true });

  try {
    git(repoDir, ["worktree", "add", "--detach", "--quiet", worktree, at]);
    return { result: fn(worktree), leaked: swept.stuck };
  } finally {
    // --force because verify is expected to have left the tree dirty, and a
    // gate that refuses to clean up after a messy verify would leak a
    // worktree per promotion.
    try {
      git(repoDir, ["worktree", "remove", "--force", worktree]);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
      try { git(repoDir, ["worktree", "prune"]); } catch { /* best effort */ }
    }
    if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
  }
}

export function withMergePreview(repoDir, base, branch, fn) {
  const { result, leaked } = withGateWorktree(repoDir, base, (worktree) => {
    let conflicts = [];
    try {
      // --no-commit: we want the tree, not a commit. Nothing here should be
      // able to leave a commit behind that someone later mistakes for real.
      gitAsGate(worktree, ["merge", "--no-commit", "--no-ff", branch]);
    } catch (err) {
      try {
        conflicts = git(worktree, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
      } catch { /* the conflict list is a nicety; failing to read it is not fatal */ }
      // "git merge failed" and "the branches conflict" are different facts, and
      // this catch used to report both as the second. A gate blocked a change
      // on a real host with "does not merge cleanly" when the two branches were
      // strictly fast-forwardable and could not possibly conflict — the merge
      // had failed for an environmental reason, and the one line that would
      // have named it was discarded here. That is the swallow-into-a-fallback
      // shape CLAUDE.md already forbids on the derivation side; a breaker that
      // cannot say why it blocked is not much better than one that cannot
      // block.
      const stderr = (err.stderr?.toString() || err.message || "").trim();
      const failure = conflicts.length > 0
        ? null
        : stderr.split("\n").filter(Boolean).pop() || "git merge failed and said nothing";
      return { mergeable: false, conflicts, failure, result: null };
    }

    // Strip the gate's own state BEFORE anything the gated party wrote can
    // run. Not hidden, not read-only — absent. A verify command that reads
    // .backstop/ to decide what to do is a verify command shaping the gate,
    // and the point of this boundary is that it cannot.
    rmSync(path.join(worktree, BACKSTOP_DIR), { recursive: true, force: true });

    return { mergeable: true, conflicts: [], result: fn(worktree) };
  });
  return { ...result, leaked };
}
