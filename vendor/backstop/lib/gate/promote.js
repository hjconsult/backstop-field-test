// The promotion gate — the breaker (docs/design/PROMOTION-GATE.md,
// DECISIONS.md D1). Every enforced limit is checked here, at the one moment
// work reaches a live environment, and a failed check blocks: this function
// merges nothing unless every check passed. It is deliberately a command
// with an exit code rather than a library call the agent's own loop may or
// may not make — that distinction is the whole difference between this and
// the advisory budget lock that failed in the prior system.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadPolicy, resolveEnvironment } from "../policy.js";
import { runVerify } from "../verify.js";
import { checkScope, routeScopeViolation } from "./scope-check.js";
import { dialSeverity } from "./exposure.js";
import { scopeIntegrity } from "./declaration-integrity.js";
import { withMergePreview } from "./merge-preview.js";
import { resolveRef } from "../refs.js";
import { landOnRemote, worktreeHolding, worktreeRoot } from "./land.js";
import { classifyMigration } from "../adapters/supabase.js";
import { classifyBudget } from "../budget.js";
import { buildGraph, readHistory } from "../ledger.js";
import { promotedTaskIds, recordPromoted, recordBlocked, appendRecord, commitLedger } from "../ledger-store.js";
import { waitForDeployment } from "../adapters/vercel.js";
import { runLinkerPass } from "../knowledge/linker.js";
import { branchForTask, taskIdFromBranch, readTaskDeclaration, currentBranch } from "../task.js";
import { transitiveDependents } from "../cascade.js";
import { BACKSTOP_DIR } from "../policy.js";
import { runEnabledChecks, runMeters } from "../policy/registry.js";
import "../policy/builtins.js"; // registers the built-in checks and meters

function git(args, cwd) {
  // stderr is captured rather than inherited: git's own "fatal: ambiguous
  // argument" was leaking to the terminal ahead of our message, so an
  // ordinary mistake (a task branch that does not exist) read like a crash.
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * The ref that actually holds this branch — local, or the remote-tracking copy.
 *
 * This looked only at `refs/heads/`, which is every branch you have in a
 * development clone and none of them in a CI one. `actions/checkout` gives you
 * the base branch and `origin/*` remote refs, so the gate reported
 * "no branch task/x — run `backstop task start x` first" and exited 1 for every
 * task, in the one place where it is mounted as real enforcement rather than a
 * speed bump (AUDIT-05 F2). Not a false pass — a false block, with an
 * instruction that makes no sense on a CI runner. A gate nobody can mount in CI
 * is a gate that is never enforcement anywhere.
 *
 * The remote-tracking ref is if anything the better source: it is what is
 * actually on the remote, rather than a local copy that may have drifted.
 */


export { resolveRef };

/** Does this task actually have a branch? Asked before anything tries to diff it. */
export function taskBranchExists(repoDir, branch) {
  return resolveRef(repoDir, branch) !== null;
}

const PASS = "pass";
const FAIL = "fail";
const FLAGGED = "flagged";

function changedFiles(repoDir, base, branch) {
  const out = git(["diff", "--name-only", `${base}...${branch}`], repoDir);
  return out ? out.split("\n").filter(Boolean) : [];
}

/**
 * Every Task-Id carried by the commits this branch would merge into base.
 * Promotion merges a *range*, not a diff, so this is the only way to know
 * whose work actually lands. A branch started from another task's branch
 * carries that task's commits, and nothing in the file list reveals it.
 */
function taskIdsOnBranch(repoDir, base, branch) {
  const out = git(["log", "--format=%B%x00", `${base}..${branch}`], repoDir);
  const ids = new Set();
  for (const body of out.split("\0")) {
    const match = body.match(/^Task-Id:\s*(\S+)\s*$/m);
    if (match) ids.add(match[1]);
    else if (body.trim()) ids.add(null); // an untagged commit is also unaccounted for
  }
  return ids;
}

function openTaskBranches(repoDir, exceptBranch) {
  const out = git(["branch", "--list", "task/*", "--format=%(refname:short)"], repoDir);
  return out
    .split("\n")
    .filter(Boolean)
    .filter((b) => b !== exceptBranch)
    .map(taskIdFromBranch)
    .filter(Boolean);
}

/**
 * Run the checklist. Returns every check's result plus an overall verdict —
 * it never throws for a failed check, because a blocked promotion is a
 * normal, recordable outcome, not an exception.
 */
export function runChecks(repoDir, taskId, { environment = "production", spent = null } = {}) {
  const policy = loadPolicy(repoDir);
  const base = policy.baseBranch;
  const branch = branchForTask(taskId);
  // Derived, not declared — see resolveEnvironment. `environment` is what the
  // caller asked for; `exposure` is what the gate is willing to believe.
  const resolved = resolveEnvironment(policy, environment, { baseBranch: base });
  const exposure = resolved.exposure;
  const checks = [];

  // An attempted downgrade is reported, not silently corrected. A caller who
  // asked for a looser tier and was quietly given a stricter one leaves no
  // record that it was tried, and "the gate stopped this" is exactly the kind
  // of thing that has to survive in the ledger (TL3).
  if (resolved.conflict) {
    checks.push({
      name: "environment-corroboration",
      status: FAIL,
      detail: `${resolved.conflict} — gating as ${resolved.name}. A tier the caller selects for itself is not a limit.`,
    });
  }

  // No branch, no change to reason about. This used to reach `git diff` and
  // throw, which meant the gate crashed instead of blocking — the same
  // outcome by luck, but an unreadable one, and a crash is not a recordable
  // verdict the way a blocked promotion is.
  if (!taskBranchExists(repoDir, branch)) {
    checks.push({
      name: "promotable-state",
      status: FAIL,
      detail: `no branch ${branch} — run \`backstop task start ${taskId}\` first`,
    });
    return {
      ok: false, checks, branch, base, files: [], environment, exposure,
      fanOut: [], declaration: null,
    };
  }

  // Everything below needs a revision, not a branch name: in a CI clone the
  // task branch only exists as origin/<branch>, and the base may too.
  const branchRef = resolveRef(repoDir, branch) ?? branch;
  const baseRef = resolveRef(repoDir, base) ?? base;

  const files = changedFiles(repoDir, baseRef, branchRef);

  // 0a. Branch purity. Promotion merges every commit on the branch, so a
  //     branch carrying another task's work ships that work too — past the
  //     gate, and recorded as this task's promotion. The ledger would then be
  //     wrong about what shipped, which is the one thing it cannot be.
  const carried = taskIdsOnBranch(repoDir, baseRef, branchRef);
  const foreign = [...carried].filter((id) => id !== taskId);
  if (foreign.length > 0) {
    const named = foreign.map((id) => id ?? "(untagged commit)").sort();
    checks.push({
      name: "branch-purity",
      status: FAIL,
      detail:
        `${branch} carries work that is not ${taskId}: ${named.join(", ")} — ` +
        `promoting it would merge that work into ${base} unrecorded. ` +
        `Rebase ${branch} onto ${base}, or promote the other task first.`,
    });
  }

  // 0. Promotable state. Re-promoting an already-promoted task, or promoting
  //    a branch with nothing on it, would write a second ledger record for
  //    work that landed once — the ledger has to stay a true account of what
  //    was promoted and when.
  const alreadyPromoted = promotedTaskIds(repoDir).has(taskId);
  if (alreadyPromoted || files.length === 0) {
    checks.push({
      name: "promotable-state",
      status: FAIL,
      detail: alreadyPromoted
        ? `${taskId} is already promoted — nothing further to promote`
        : `no changes on ${branch} against ${base}`,
    });
    return { ok: false, checks, branch, base, files, environment, exposure, fanOut: [], declaration: null };
  }
  checks.push({ name: "promotable-state", status: PASS, detail: `${files.length} changed file(s) against ${base}` });

  // 1. Structural validation — of the MERGE RESULT, in a worktree the gate
  //    owns and then destroys, with .backstop/ removed from it first. See
  //    lib/gate/merge-preview.js: this used to verify whatever tree the
  //    operator was standing in (so promoting from base verified base, which
  //    was already green), and it used to run the gated party's code with the
  //    gate's own ledger and policy writable.
  const preview = withMergePreview(repoDir, baseRef, branchRef, (dir) =>
    runVerify(dir, policy.verifyCommand, { timeoutMs: policy.verifyTimeoutMs }),
  );

  // A worktree we could not reclaim is almost always a verify command that
  // outlived the gate and still holds files open. Say so: silent accumulation
  // is how a machine ends up with hundreds of stale checkouts and a process
  // table full of test suites holding database connections.
  if (preview.leaked?.length) {
    checks.push({
      name: "gate-hygiene",
      status: FLAGGED,
      detail:
        `${preview.leaked.length} gate worktree(s) could not be reclaimed: ${preview.leaked.join(", ")} ` +
        "— most likely a verify command still running after its gate exited. Check for orphaned processes.",
    });
  }

  if (!preview.mergeable) {
    // A branch that does not merge has no result to verify, and claiming
    // either a pass or a failure of the verify command would be an invention.
    //
    // Two different facts, and they used to print the same. A conflict is the
    // author's problem; a merge that could not run at all is the gate's, and
    // saying "does not merge cleanly" about branches that are strictly
    // fast-forwardable sends whoever reads it to look in the wrong place.
    checks.push({
      name: "structural-validation",
      status: FAIL,
      detail: preview.conflicts.length
        ? `${branch} conflicts with ${base}: ${preview.conflicts.join(", ")} — there is no merge result to verify`
        : `the gate could not merge ${branch} into ${base}, so there is no merge result to verify. ` +
          `git said: ${preview.failure ?? "nothing"}`,
    });
    return { ok: false, checks, branch, base, files, environment, exposure, fanOut: [], declaration: null };
  }

  const verify = preview.result;
  checks.push({
    name: "structural-validation",
    status: verify.ok ? PASS : FAIL,
    detail: verify.ok
      ? `verify command passed against the merge of ${branch} into ${base}`
      : verify.reason ?? verify.output.slice(-800),
  });

  // 2. Scope compliance — routed to independent review, never auto-approved
  //    or auto-rejected here; exposure decides whether that blocks.
  //    A task's own declaration is implicitly in scope: it is the task's own
  //    machinery, written by `task start`, not a change the task made. Any
  //    *other* task's declaration is not, and policy.json never is.
  const declaration = readTaskDeclaration(repoDir, taskId, branchRef);
  const ownDeclaration = `${BACKSTOP_DIR}/tasks/${taskId}.json`;
  const declaredGlobs = declaration?.scope?.length ? [...declaration.scope, ownDeclaration] : [];
  // Before asking whether the diff is in scope, ask whether the scope is still
  // the one that was declared. Checking the diff against a scope the task
  // rewrote for itself answers a question nobody asked.
  if (declaration) {
    const integrity = scopeIntegrity(repoDir, taskId, branchRef, declaration.scope);
    if (integrity.unverifiable) {
      checks.push({
        name: "scope-integrity",
        status: FAIL,
        detail:
          `no commit on ${branch} introduces ${declaration.taskId ?? taskId}'s declaration — ` +
          "its declared scope cannot be traced to a declaring commit, so it is not evidence of anything",
      });
    } else if (!integrity.ok) {
      checks.push({
        name: "scope-integrity",
        status: FAIL,
        detail:
          `declared scope was widened after declaration: added ${integrity.added.join(", ")} ` +
          `(declared as ${integrity.before.length ? integrity.before.join(", ") : "empty"}). ` +
          "A task may narrow its own scope; widening it is the task deciding what it is allowed to touch.",
      });
    } else {
      checks.push({
        name: "scope-integrity",
        status: PASS,
        detail: `declared scope unchanged since declaration (${integrity.before.length} glob(s))`,
      });
    }
  }

  const scope = checkScope(declaredGlobs, files);
  // 2a. Constitutional files, judged on their own and never dialled by
  //      exposure. D15 says policy.json is always out of scope "no matter what
  //      the task declared, and always routes to review" — but that was
  //      implemented as an ordinary out-of-scope finding, and out-of-scope
  //      findings go through dialSeverity. On any tier that is not live it
  //      became proceed-logged, so a task could merge a rewrite of the file
  //      that governs the gate (AUDIT-05 F8). `checkScope` computed
  //      `constitutional`, the gate carried it in the result, and nothing ever
  //      read it — the same shape as the `realUsers` field that was documented,
  //      carried, and never consulted.
  //
  //      There is no tier on which changing the rules the gate enforces is a
  //      logged inconvenience. A pre-launch project with no users still has a
  //      gate, and this is the file that decides what it does.
  if (scope.constitutional.length) {
    checks.push({
      name: "constitutional-change",
      status: FAIL,
      detail:
        `${scope.constitutional.join(", ")} governs the gate itself — an agent may propose a change, ` +
        "only the founder approves one (D8). This is never dialled by environment.",
      constitutional: scope.constitutional,
    });
  }

  const route = routeScopeViolation(scope.outOfScope);
  if (!route.needsIndependentReview) {
    checks.push({ name: "scope-compliance", status: PASS, detail: `${scope.inScope.length} file(s) in declared scope` });
  } else {
    const severity = dialSeverity(exposure, { type: "scope-violation" });
    const blocking = severity.action === "blocked-pending-review";
    checks.push({
      name: "scope-compliance",
      status: blocking ? FAIL : FLAGGED,
      // A declared glob that matched nothing is often the real cause of a
      // scope violation — a typo authorises nothing, and the work then looks
      // like it went out of bounds. Name it so the operator checks the
      // declaration before arguing with the diff. The task's own declaration
      // file is appended by the gate, so it never counts as the operator's typo.
      detail:
        `${route.files.length} file(s) out of declared scope → independent review (${severity.action}): ${route.files.join(", ")}` +
        (scope.unmatchedGlobs.filter((g) => g !== ownDeclaration).length
          ? ` — note: declared glob(s) matching nothing: ${scope.unmatchedGlobs.filter((g) => g !== ownDeclaration).join(", ")}`
          : ""),
      routedToReview: route.files,
      constitutional: scope.constitutional,
    });
  }

  // 3. Migration safety — destructive never applies in place; it has to have
  //    gone through fork-and-cutover, and the gate will not take that on faith.
  const migrations = files.filter((f) => f.endsWith(".sql"));
  const destructive = migrations.filter((f) => {
    const full = path.join(repoDir, f);
    return existsSync(full) && classifyMigration(readFileSync(full, "utf8")) === "destructive";
  });
  if (migrations.length === 0) {
    checks.push({ name: "migration-safety", status: PASS, detail: "no migrations in this change" });
  } else if (destructive.length === 0) {
    checks.push({ name: "migration-safety", status: PASS, detail: `${migrations.length} migration(s), all additive` });
  } else {
    const severity = dialSeverity(exposure, { type: "destructive-migration" });
    const blocking = severity.action === "blocked-pending-review";
    checks.push({
      name: "migration-safety",
      status: blocking ? FAIL : FLAGGED,
      detail: `destructive migration(s) require fork-and-cutover (${severity.action}): ${destructive.join(", ")}`,
    });
  }

  // 4. External side-effect classification — the slot exists from day one so
  //    its answer is "none detected", never "not checked". No adapter can
  //    raise one yet; when one can, real money lands here and always blocks.
  checks.push({
    name: "external-side-effects",
    status: PASS,
    detail: "none detected — no adapter in this stage can produce an irreversible external effect",
  });

  // 5. Dependency completeness, and impact fan-out for the reviewer.
  //    Read the task's own branch, not HEAD: the gate usually runs from the
  //    base branch, where the task's commits don't exist yet.
  // branchRef, not branch: readHistory swallows an unknown rev and returns
  // [], so in a CI clone this reported "no tagged commits for this task"
  // and failed rollback-readiness for every task being gated.
  const commits = readHistory(repoDir, branchRef);
  const graph = buildGraph(repoDir, branchRef);
  const node = graph.find((n) => n.taskId === taskId);
  const promoted = promotedTaskIds(repoDir);
  // baseRef, not base: a CI clone has no local `main`, so the raw name is an
  // unknown revision and this crashed the gate outright on a real runner —
  // after structural-validation had resolved its own refs and passed (TL65).
  const baseCommits = new Set(
    git(["rev-list", baseRef], repoDir).split("\n").filter(Boolean),
  );
  const unpromotedDeps = (node?.dependsOn ?? []).filter((dep) => {
    if (promoted.has(dep)) return false;
    const depCommits = commits.filter((c) => c.taskId === dep).map((c) => c.sha);
    return !depCommits.every((sha) => baseCommits.has(sha));
  });
  const fanOut = transitiveDependents(graph, taskId).filter((t) => t !== taskId);
  // Two different reasons a dependency is acceptable, and the check has always
  // known the difference: it has a promotion record, or its commits are on base
  // anyway. Reporting both as "promoted" said something false in the case the
  // field test produced — add-discount reached main through GitHub's merge
  // button, so it has no record at all, and the gate called it promoted (TL58,
  // TL62). `promoted` is a ledger record and `onBase` is reachability; the
  // whole product rests on them being separate, so the sentence a human reads
  // must not merge them either.
  const deps = node?.dependsOn ?? [];
  const promotedDeps = deps.filter((dep) => promoted.has(dep));
  const onBaseOnly = deps.filter((dep) => !promoted.has(dep) && !unpromotedDeps.includes(dep));
  checks.push({
    name: "dependency-completeness",
    status: unpromotedDeps.length === 0 ? PASS : FAIL,
    detail:
      unpromotedDeps.length > 0
        ? `depends on unpromoted task(s): ${unpromotedDeps.join(", ")}`
        : onBaseOnly.length === 0
          ? `depends on ${deps.length} promoted task(s); ${fanOut.length} task(s) downstream`
          : `depends on ${deps.length} task(s): ${promotedDeps.length} promoted, ` +
            `${onBaseOnly.length} on ${base} with no promotion record (${onBaseOnly.join(", ")}); ` +
            `${fanOut.length} task(s) downstream`,
    impactFanOut: fanOut,
  });

  // 6. Budget — a hard stop, checked before promotion, not logged after it.
  //    `budget` in policy is the built-in spend meter's limit; `meters` and
  //    `checks` add registered plugins without touching this file.
  // Shared with lib/budget.js rather than reimplemented here. The inline copy
  // this replaces was the only version the product actually ran, and it passed
  // a garbage limit straight through.
  const verdict = classifyBudget(spent, policy.budget.limit);
  const budgetDetail = {
    unset: "no budget limit configured",
    // Silence used to pass. A limit was configured, the agent omitted
    // `--spent`, and the breaker reported PASS — so the way past a spend
    // ceiling was to say nothing about spending (AUDIT-05 F1). The
    // constitution already answers this for verify: a check that cannot run
    // blocks. The budget was the one place doing the opposite.
    "no-reading": `budget limit ${policy.budget.limit} ${policy.budget.unit} is configured but no spend was reported ` +
      "— a limit that passes when nothing is reported is not a limit. Pass --spent, or remove the limit.",
    invalid: `budget limit ${JSON.stringify(policy.budget.limit)} is not a number — fix policy.json`,
    // Named as self-reported, because it is. The figure comes from the caller,
    // so the ledger must not read later as though it were measured. Deriving
    // it from a usage API is the real fix and is not done here.
    ok: `${spent} ${policy.budget.unit} (self-reported) against limit ${policy.budget.limit}`,
    over: `${spent} ${policy.budget.unit} (self-reported) against limit ${policy.budget.limit}`,
  }[verdict];
  checks.push({
    name: "budget",
    status: verdict === "over" || verdict === "invalid" || verdict === "no-reading" ? FAIL : PASS,
    detail: budgetDetail,
  });

  // 6b. Registered policy plugins — per-project, configured not coded.
  const pluginContext = {
    repoDir,
    files,
    base,
    branch,
    spent,
    readFile: (file) => {
      try {
        return git(["show", `${branch}:${file}`], repoDir);
      } catch {
        return null;
      }
    },
  };
  for (const result of runMeters(policy.meters, pluginContext)) {
    checks.push({ name: `meter:${result.name}`, status: result.ok ? PASS : FAIL, detail: result.detail });
  }
  for (const result of runEnabledChecks(policy.checks, pluginContext)) {
    checks.push({ name: `check:${result.name}`, status: result.ok ? PASS : FAIL, detail: result.detail });
  }

  // 7. Objective outcome validation — in this stage the configured verify
  //    command is that signal; category checks arrive with the policy
  //    registry in Stage 2.
  checks.push({
    name: "objective-outcome",
    status: verify.ok ? PASS : FAIL,
    detail: "covered by the configured verify command in this stage",
  });

  // 8. Rollback-readiness — nothing is promoted that cannot be undone
  const revertable = (node?.commits?.length ?? 0) > 0 && destructive.length === 0;
  checks.push({
    name: "rollback-readiness",
    status: revertable ? PASS : FAIL,
    detail: revertable
      ? `${node.commits.length} commit(s) revertable, cascade set computable`
      : destructive.length > 0
        ? "destructive migration has no verified compensating action"
        : "no tagged commits for this task — nothing to revert",
  });

  const ok = checks.every((c) => c.status !== FAIL);
  return { ok, checks, branch, branchRef, base, baseRef, files, environment, exposure, fanOut, declaration };
}

/**
 * The gate: run the checklist, record the outcome either way, and merge only
 * on a clean pass. The ledger write happens before the merge so a promotion
 * can never be invisible, even if the merge itself fails.
 */
export async function promote(repoDir, taskId, opts = {}) {
  const result = runChecks(repoDir, taskId, opts);
  const at = new Date().toISOString();

  if (!result.ok) {
    // Deliberately NOT committed. A block happens on the task branch, and that
    // branch is the thing you delete when the work was a mistake (D10) — so
    // committing the record there would take it with it. A promoted record
    // reaches base through the merge; a blocked one has no such carrier, and
    // making blocks durable needs a design call the founder has not made yet
    // (see the note in AUDIT-01.md).
    recordBlocked(repoDir, { taskId, branch: result.branch, checks: result.checks, at });
    return { ...result, promoted: false };
  }

  // The linker pass runs here because promotion is a guaranteed, mechanical
  // trigger — not because anyone remembered to link anything (D21).
  const linked = runLinkerPass(
    repoDir,
    readHistory(repoDir, result.branchRef ?? result.branch),
    buildGraph(repoDir, result.branchRef ?? result.branch),
    result.declaration ? [result.declaration] : [],
  );

  const record = {
    taskId,
    branch: result.branch,
    base: result.base,
    at,
    relations: linked.relations,
    orphanRate: linked.orphans.rate,
    policyCategory: result.declaration?.policyCategory ?? "default",
    artifactRef: { kind: "git", ref: git(["rev-parse", result.branch], repoDir) },
    inFlightAtPromotion: openTaskBranches(repoDir, result.branch),
    scope: result.declaration?.scope ?? [],
    environment: result.environment,
    checks: result.checks,
  };
  // The old order wrote `promoted` before merging, reasoning that a promotion
  // must never be invisible even if the merge fails. The intent was right and
  // the record was wrong: a merge conflict, or a second promote racing this
  // one for the working tree, left the ledger claiming a promotion that never
  // landed — and a "Ledger: promoted" commit on base asserting it. Invisible
  // and false are both failures, but only one of them is a recorder lying
  // about what shipped. So the attempt is recorded as an attempt, and only a
  // merge that actually happened is recorded as a promotion.
  // Stand on the base branch BEFORE writing anything. The ledger is base's
  // file, and writing it while standing on the task branch leaves an untracked
  // copy there — which the checkout below then refuses to overwrite, because
  // base has the same path tracked. Promoting a second task from its own
  // branch, after a first one landed, therefore failed with "untracked working
  // tree files would be overwritten by checkout" (AUDIT-05 F9). Two agents
  // cutting branches from the same base and promoting in sequence is not an
  // edge case; it is what a fleet does all day.
  //
  // The record still precedes the merge, which is the property TL17 established:
  // an attempt that fails must not be invisible.
  // Base may belong to a different working tree. Worktrees share one `.git`,
  // so `refs/heads/<base>` is shared, and `git checkout` below would fail with
  // "already used by worktree" — AUDIT-05 F9's third case, and the shape every
  // parallel-agent setup has: one clone on main, N worktrees on task/*. Every
  // check passes there; only the landing failed. Land on the remote instead of
  // moving a ref out from under a tree this process does not own.
  const onBase = currentBranch(repoDir) === result.base;
  const holder = onBase ? null : worktreeHolding(repoDir, result.base);
  if (holder && holder !== worktreeRoot(repoDir)) {
    const landing = landOnRemote(repoDir, {
      base: result.base, branch: result.branch, taskId, at, record, holder,
    });
    if (!landing.landed) return { ...result, promoted: false, mergeFailed: landing.detail };
    // No `live` here: --deploy waits on a deployment of the pushed tip, and
    // that path still runs from the tree that owns base. Reporting null rather
    // than inventing an answer is the same rule as everywhere else.
    return {
      ...result,
      promoted: true,
      live: null,
      landedOn: landing.pushedTo,
      record: { ...record, mergeCommit: landing.mergeCommit },
    };
  }

  try {
    if (!onBase) git(["checkout", "-q", result.base], repoDir);
  } catch (err) {
    const detail = err.stderr?.toString().trim() || err.message;
    return {
      ...result,
      promoted: false,
      mergeFailed: `could not switch to ${result.base} before promoting: ${detail}`,
    };
  }

  appendRecord(repoDir, { event: "promotion-started", taskId, branch: result.branch, at });

  let mergeCommit;
  try {
    git(["merge", "--no-ff", "-m", `Promote ${taskId}`, result.branch], repoDir);
    mergeCommit = git(["rev-parse", "HEAD"], repoDir);
  } catch (err) {
    // Leave no half-merged tree behind for someone to discover later.
    try { git(["merge", "--abort"], repoDir); } catch { /* nothing to abort */ }
    const detail = (err.stderr?.toString() || err.message).split("\n")[0];
    appendRecord(repoDir, { event: "promotion-failed", taskId, branch: result.branch, at, detail });
    commitLedger(repoDir, { message: `Ledger: ${taskId} promotion failed`, taskId });
    return { ...result, promoted: false, mergeFailed: detail };
  }

  recordPromoted(repoDir, { ...record, mergeCommit });
  commitLedger(repoDir, { message: `Ledger: ${taskId} promoted`, taskId });

  // Promotion means "this is the current state of the base branch". It only
  // means "live" if it actually reached a live environment — so if asked to
  // go that far, wait for the real deployment and report what happened
  // rather than inferring success from a clean merge.
  let live = null;
  // Wait for the deployment of the commit that was actually pushed, which is
  // the tip after the ledger commit — not the merge commit underneath it. A
  // host builds what it receives, so targeting the merge SHA would never match
  // and every --deploy would report promoted-not-live forever. Caught by S5
  // when the ledger commit moved after the merge.
  const pushedTip = git(["rev-parse", "HEAD"], repoDir);
  if (opts.push) git(["push", "origin", result.base], repoDir);
  if (opts.deploy) {
    const { token, projectId, teamId } = opts.vercel ?? {};
    if (!token || !projectId || !teamId) {
      live = { status: "promoted-not-live", detail: "deploy requested but Vercel credentials are not configured" };
    } else {
      const deployment = await waitForDeployment({ ...opts.vercel, commitSha: pushedTip });
      live = deployment?.state === "READY"
        ? { status: "live", deploymentId: deployment.deploymentId, url: deployment.url }
        : {
            status: "promoted-not-live",
            detail: deployment ? `deployment ${deployment.deploymentId} finished ${deployment.state}` : "timed out waiting for the deployment",
          };
    }
    appendRecord(repoDir, { event: "deploy-outcome", taskId, at: new Date().toISOString(), ...live });
    commitLedger(repoDir, { message: `Ledger: ${taskId} deploy outcome ${live.status}`, taskId });
    // The outcome record is a commit of its own, so the remote would otherwise
    // be missing the one record that says whether the deploy worked.
    if (opts.push) {
      try { git(["push", "origin", result.base], repoDir); } catch { /* reported below via live */ }
    }
  }

  return { ...result, promoted: true, live, record: { ...record, mergeCommit } };
}
