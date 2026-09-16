#!/usr/bin/env node
// The CLI is the enforcement surface: `promote` exits non-zero when the gate
// blocks, which is what lets it be mounted as a required check rather than a
// library call an agent may skip.

import { writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildGraph, readHistory } from "../lib/ledger.js";
import { transitiveDependents, commitsForTasks } from "../lib/cascade.js";
import { revertWithVerification } from "../lib/revert.js";
import { startTask, currentTaskId, currentBranch } from "../lib/task.js";
import { appendRecord, commitLedger } from "../lib/ledger-store.js";
import { promote, runChecks } from "../lib/gate/promote.js";
import { loadPolicy, writePolicy, DEFAULT_POLICY, policyPath, ensureLedgerMergeDriver } from "../lib/policy.js";
import { parseDeployments, correlateDeployments, fetchDeployments, fetchProductionTarget, markLive, liveTaskIds } from "../lib/adapters/vercel.js";
import { renderGraphHtml } from "../lib/graph-view/render.js";
import { runLinkerPass } from "../lib/knowledge/linker.js";

const [, , command, ...args] = process.argv;
const repoDir = process.cwd();

const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const positional = () => args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

async function deploymentsForStatus(commits) {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;
  if (!token || !projectId || !teamId) {
    return { deployments: [], live: [], unavailable: "VERCEL_TOKEN, VERCEL_PROJECT_ID and VERCEL_TEAM_ID must be set" };
  }
  // Two reads, because they answer different questions: the list says what
  // exists, the project says which one is serving traffic. Neither is
  // derivable from the other.
  const [raw, production] = await Promise.all([
    fetchDeployments({ token, projectId, teamId }),
    fetchProductionTarget({ token, projectId, teamId }),
  ]);
  const deployments = markLive(
    correlateDeployments(parseDeployments(raw), commits),
    production?.deploymentId ?? null,
  );
  return { deployments, live: liveTaskIds(repoDir, commits, production?.commitSha ?? null), production };
}

/** "What shipped" and "what was approved" are different lists; say which is which. */
function marker(node) {
  if (node.status === "reverted") return "  [REVERTED]";
  if (node.promoted) return "  [PROMOTED]";
  if (node.onBase) return "  [ON BASE, NOT PROMOTED]";
  return "";
}

function printGraph(graph) {
  if (graph.length === 0) {
    console.log("No tagged units of work found yet (no commit carries a Task-Id trailer).");
    return;
  }
  for (const node of graph) {
    // "(none)" is a claim about the code, and it is wrong whenever the task
    // imports files that predate the ledger — which is every file in a
    // repository on the day it adopts Backstop. Say which kind of none it is.
    const deps = node.dependsOn.length
      ? node.dependsOn.join(", ")
      : node.untrackedRefs?.length
        ? `(none tracked; ${node.untrackedRefs.length} reference(s) into files no task owns)`
        : "(none)";
    console.log(`${node.taskId}  [${node.commits.length} commit(s)]  depends on: ${deps}${marker(node)}`);
  }
  // Work sitting on the base branch with no promotion record is the line worth
  // reading twice: it is live, and it never passed the gate.
  const ungated = graph.filter((n) => n.onBase && !n.promoted && n.status !== "reverted");
  if (ungated.length) {
    console.log("");
    console.log(`${ungated.length} task(s) on the base branch with no promotion record: ${ungated.map((n) => n.taskId).join(", ")}`);
    console.log("Live, and never passed the gate — expected where the gate is not mounted, a finding where it is.");
  }
}

async function main() {
  if (command === "status") {
    // A baseBranch that does not exist makes onBase unknowable, and an
    // unknowable answer must not render as "no". Say so instead of quietly
    // reporting every task as not-shipped.
    const configuredBase = loadPolicy(repoDir).baseBranch;
    try {
      execFileSync("git", ["rev-parse", "--verify", configuredBase], { cwd: repoDir, stdio: "ignore" });
    } catch {
      console.error(
        `Warning: baseBranch "${configuredBase}" in .backstop/policy.json does not exist — ` +
        "cannot tell which work is on the base branch.",
      );
    }
    const commits = readHistory(repoDir);
    const graph = buildGraph(repoDir);
    const withDeployments = flag("deployments");
    let deploy = { deployments: [], live: [] };
    if (withDeployments) deploy = await deploymentsForStatus(commits);

    const linked = runLinkerPass(repoDir, commits, graph);

    if (flag("json")) {
      console.log(
        JSON.stringify(
          { tasks: graph, deployments: deploy.deployments, relations: linked.relations, orphanRate: linked.orphans.rate },
          null,
          2,
        ),
      );
      return;
    }

    printGraph(graph);
    if (graph.length > 0) {
      const { rate, orphans, total } = linked.orphans;
      console.log(
        `\n${linked.relations.length} relates-to edge(s). Orphan rate: ${(rate * 100).toFixed(0)}% (${orphans.length}/${total})${orphans.length ? ` — ${orphans.join(", ")}` : ""}`,
      );
    }
    // Said here rather than only in `doctor`, because the operator who most
    // needs to know is the one who never thought to ask.
    const { assessEnforcement } = await import("../lib/enforcement.js");
    const enforcement = assessEnforcement(repoDir);
    if (enforcement.level !== "configured") {
      console.log("");
      console.log(enforcement.level === "none"
        ? "Nothing in this repository runs the gate — `backstop doctor` for what to mount."
        : "The gate is a local hook only, which the gated party can skip — `backstop doctor`.");
    }

    if (withDeployments) {
      console.log("");
      if (deploy.unavailable) {
        console.log(`Deployments unavailable: ${deploy.unavailable}`);
        return;
      }
      for (const d of deploy.deployments) {
        const task = d.taskId ?? "(untagged)";
        console.log(`${d.environment.padEnd(10)} ${d.deploymentId}  ${task}  ${d.state}${d.live ? "  [LIVE]" : ""}`);
      }
      // No [LIVE] marker above has two possible causes, and the operator
      // cannot tell them apart from silence: nothing is live, or the live
      // deployment is older than the page we listed. Say which.
      if (deploy.production?.deploymentId && !deploy.deployments.some((d) => d.live)) {
        console.log(`(live deployment ${deploy.production.deploymentId} is older than the ${deploy.deployments.length} listed above)`);
      }
      console.log(`\nLive tasks: ${deploy.live.length ? deploy.live.join(", ") : "(none)"}`);
    }
    return;
  }

  if (command === "init") {
    // Re-running init used to reset policy.json to defaults and report
    // success — silently removing an enforced spend ceiling, an enabled
    // check and the verify command. An enforced limit must never disappear
    // because someone ran a setup command twice.
    if (existsSync(policyPath(repoDir)) && !flag("force")) {
      return fail(
        `${policyPath(repoDir)} already exists — not overwriting it.\n` +
        "Edit it directly, or pass --force to replace it with defaults (this discards\n" +
        "any configured verifyCommand, checks and meter limits).",
      );
    }
    const path = writePolicy(repoDir, { ...DEFAULT_POLICY, verifyCommand: value("verify", null) });
    console.log(`Wrote ${path}. Set verifyCommand before promoting — an unset one blocks.`);
    // The ledger is append-only, so two branches appending real events must
    // end up with both. Without the union driver, git calls that a conflict
    // and the tool's own "rebase and promote again" advice cannot be followed.
    const driver = ensureLedgerMergeDriver(repoDir);
    console.log(driver === "added"
      ? "Added the ledger's union merge driver to .gitattributes — commit it."
      : ".gitattributes already carries the ledger merge driver.");
    return;
  }

  if (command === "task") {
    const [sub, taskId] = args.filter((a) => !a.startsWith("--"));
    if (sub !== "start" || !taskId) return fail("Usage: backstop task start <task-id> [--scope <glob>]...");
    const scope = args.reduce((acc, a, i) => (a === "--scope" && args[i + 1] ? [...acc, args[i + 1]] : acc), []);
    const relatesTo = args.reduce((acc, a, i) => (a === "--relates-to" && args[i + 1] ? [...acc, args[i + 1]] : acc), []);
    const decl = startTask(repoDir, taskId, {
      scope, relatesTo,
      policyCategory: value("category", "default"),
      intent: value("intent", null),
    });
    console.log(`Started ${decl.taskId} on ${decl.branch}`);
    console.log(`Declared scope: ${scope.length ? scope.join(", ") : "(none — every changed file will be out of scope)"}`);
    if (relatesTo.length) console.log(`Relates to: ${relatesTo.join(", ")}`);
    return;
  }

  if (command === "check" || command === "promote") {
    const taskId = args.find((a) => !a.startsWith("--")) ?? currentTaskId(repoDir);
    if (!taskId) return fail(`Usage: backstop ${command} <task-id> [--env <environment>] [--spent <amount>]`);
    const rawSpent = value("spent");
    if (rawSpent != null && !Number.isFinite(Number(rawSpent))) {
      return fail(`--spent ${rawSpent} is not a number. Omit it to report no spend.`);
    }
    const opts = {
      environment: value("env", "production"),
      spent: rawSpent == null ? null : Number(rawSpent),
    };

    if (command === "promote") {
      opts.push = flag("push");
      opts.deploy = flag("deploy");
      opts.vercel = {
        token: process.env.VERCEL_TOKEN,
        projectId: process.env.VERCEL_PROJECT_ID,
        teamId: process.env.VERCEL_TEAM_ID,
      };
    }
    const result = command === "check" ? runChecks(repoDir, taskId, opts) : await promote(repoDir, taskId, opts);
    for (const c of result.checks) {
      const mark = c.status === "pass" ? "✓" : c.status === "flagged" ? "!" : "✗";
      console.log(`${mark} ${c.name.padEnd(26)} ${c.detail}`);
    }
    console.log("");
    if (!result.ok) {
      console.error(`BLOCKED: ${taskId} did not pass the promotion gate (recorded in .backstop/ledger.jsonl).`);
      process.exitCode = 1;
      return;
    }
    if (command === "check") {
      console.log(`${taskId} would pass the gate.`);
      return;
    }
    // The gate passed but the merge did not happen — a conflict against a base
    // that moved, or another promote holding the working tree. Distinct from
    // BLOCKED, and the ledger says so too (promotion-started/promotion-failed).
    if (result.mergeFailed) {
      console.error(
        `NOT PROMOTED: ${taskId} passed the gate but the merge into ${result.base} failed.\n` +
        `  ${result.mergeFailed}\n` +
        `The merge was aborted and ${result.base} is unchanged. Rebase ${result.branch} on ` +
        `${result.base} and promote again.`,
      );
      process.exitCode = 1;
      return;
    }
    // Name where it actually landed. Promoting from a worktree pushes to the
    // remote and deliberately leaves the local base ref alone (TL61), so
    // "→ main" would send the operator to look at a branch that did not move.
    const landed = result.landedOn ?? result.base;
    console.log(`Promoted ${taskId} → ${landed} (${result.record.mergeCommit.slice(0, 8)}).`);
    if (result.landedOn) {
      console.log(`Local ${result.base} is unchanged — it belongs to another worktree. Fetch to see this.`);
    }
    if (result.live?.status === "live") {
      console.log(`Live: ${result.live.url} (${result.live.deploymentId})`);
    } else if (result.live) {
      console.error(`Promoted but NOT live: ${result.live.detail}`);
      process.exitCode = 1;
    }
    return;
  }

  if (command === "revert") {
    const taskId = args.find((a) => !a.startsWith("--"));
    const cascade = flag("cascade");
    if (!taskId) return fail("Usage: backstop revert <task-id> [--cascade] [--push]");

    const commits = readHistory(repoDir);
    const graph = buildGraph(repoDir);
    const knownTasks = new Set(graph.map((n) => n.taskId));
    if (!knownTasks.has(taskId)) {
      return fail(`Unknown task id "${taskId}". Known task ids: ${Array.from(knownTasks).join(", ") || "(none)"}`);
    }

    // The graph already tracks reverted work (Stage 0 scenario 5). Re-running
    // a revert used to attempt it anyway and surface git's own "Command
    // failed: git revert <sha>" — the right outcome reached uninformatively,
    // which is what that scenario asks us not to do.
    const alreadyReverted = (cascade ? transitiveDependents(graph, taskId) : [taskId])
      .filter((id) => graph.find((n) => n.taskId === id)?.status === "reverted");
    if (alreadyReverted.includes(taskId)) {
      return fail(`${taskId} is already reverted — nothing to undo. \`backstop status\` shows it as [REVERTED].`);
    }

    // Reverting without --cascade while the graph knows of live dependents
    // leaves them standing on work that is gone. The verify command may or may
    // not catch it — a thin one passes vacuously — and the graph knew before
    // anything was touched, so silence here is a choice, not a limitation.
    if (!cascade) {
      const stranded = transitiveDependents(graph, taskId)
        .filter((id) => id !== taskId)
        .filter((id) => graph.find((n) => n.taskId === id)?.status !== "reverted");
      if (stranded.length > 0) {
        return fail(
          `${taskId} has dependent work that would be left stranded: ${stranded.join(", ")}.\n` +
          `Use --cascade to revert it too, or revert those tasks first.`,
        );
      }
    }

    const affected = (cascade ? transitiveDependents(graph, taskId) : [taskId])
      .filter((id) => !alreadyReverted.includes(id));
    if (alreadyReverted.length) {
      console.log(`Skipping ${alreadyReverted.join(", ")} — already reverted.`);
    }
    const targets = commitsForTasks(commits, affected);
    console.log(`Reverting ${affected.length} task(s): ${affected.join(", ")} (${targets.length} commit(s)), newest first.`);

    const { results, verification, status } = revertWithVerification(repoDir, targets, loadPolicy(repoDir).verifyCommand, { timeoutMs: loadPolicy(repoDir).verifyTimeoutMs });
    for (const r of results) {
      console.log(`  ${r.sha.slice(0, 8)}  ${r.taskId}  ${r.status}${r.error ? `  ${r.error}` : ""}`);
    }
    console.log(`\nStatus: ${status}`);

    // An undo that leaves no record is the recorder's own blind spot. The
    // ledger held `promoted`, `blocked`, `promotion-failed` and
    // `deploy-outcome` — every consequential act except the most consequential
    // one. cascade.js already reasons that "promoted, then reverted" is the
    // truth and that a revert must never rewind the promotion record; there was
    // no "then reverted" half for it to complete. Found in the field test: two
    // tasks reverted on real data, and the ledger said promoted and nothing
    // else. Status reads [REVERTED] because it derives that from the revert
    // commits, which is the stronger source and stays the source — this record
    // is the durable, queryable half, not a second opinion.
    if (status !== "revert-failed") {
      const at = new Date().toISOString();
      for (const id of affected) {
        const mine = results.filter((x) => x.taskId === id);
        appendRecord(repoDir, {
          event: "reverted",
          taskId: id,
          at,
          revertedCommits: mine.map((x) => x.sha),
          revertCommits: mine.map((x) => x.revertCommit).filter(Boolean),
          // The whole set, on every record, so reading one task's history
          // answers "what else went with it" without re-deriving the graph.
          cascade: affected,
          requestedFor: taskId,
          verification: status,
        });
      }
      commitLedger(repoDir, { message: `Ledger: reverted ${affected.join(", ")}`, taskId });
    }

    // Reverting is local until it is pushed, and TL61 established that a
    // fleet's base branch lives on the remote. Measured in the field test: both
    // tasks reverted here, and a fresh clone still had every file and reported
    // both tasks live. Symmetric with `promote --push` rather than automatic,
    // because pushing is a decision.
    if (flag("push")) {
      const branchNow = currentBranch(repoDir);
      try {
        execFileSync("git", ["push", "origin", `HEAD:refs/heads/${branchNow}`], {
          cwd: repoDir, stdio: ["ignore", "pipe", "pipe"],
        });
        console.log(`Pushed the revert to origin/${branchNow}.`);
      } catch (err) {
        console.error(`The revert is committed locally but the push failed: ${(err.stderr?.toString() || err.message).split("\n")[0]}`);
        console.error("Until it is pushed, every other clone still has this work.");
        process.exitCode = 1;
        return;
      }
    } else {
      console.log(`This revert is local. \`backstop revert ${taskId}${cascade ? " --cascade" : ""} --push\` lands it where the work did.`);
    }

    if (status === "reverted+broken") {
      console.error("The revert applied cleanly but the tree does not verify — a dependent this cascade missed is likely broken.");
      if (verification?.output) console.error(verification.output.slice(-800));
      process.exitCode = 1;
      return;
    }
    if (status === "revert-failed") {
      process.exitCode = 1;
      return;
    }
    return;
  }

  // Exists so the pre-push hook has something repo-agnostic to call. The hook
  // used to run `node --test test/*.test.js` and `node bin/backstop.js` —
  // relative paths true only of Backstop's own checkout — so installing it
  // anywhere else aborted every push and blamed the user's ledger for it.
  if (command === "verify") {
    const { runVerify } = await import("../lib/verify.js");
    const policy = loadPolicy(repoDir);
    const result = runVerify(repoDir, policy.verifyCommand, { timeoutMs: policy.verifyTimeoutMs });
    if (result.skipped) {
      // Exit 2, not 1: "nothing is configured" and "the check failed" are
      // different facts and a caller must be able to tell them apart. The
      // gate blocks on both (an unrunnable check is not a pass); the hook is
      // a speed bump and only blocks on a real failure.
      console.error(`${result.reason}. \`backstop promote\` will block on this; this command reports it and stops.`);
      process.exitCode = 2;
      return;
    }
    if (!result.ok) {
      if (result.output) console.error(result.output.trimEnd());
      console.error(result.reason ? `verify failed: ${result.reason}` : "verify failed.");
      process.exitCode = 1;
      return;
    }
    console.log(`verify passed: ${policy.verifyCommand}`);
    return;
  }

  // The single question the product's central claim rests on, and the one it
  // could not answer: is anything actually running the gate?
  if (command === "doctor") {
    const { enforcementReport, assessEnforcement } = await import("../lib/enforcement.js");
    for (const line of enforcementReport(repoDir)) console.log(line);
    // Exit non-zero when nothing is mounted, so this can be a check in its own
    // right. "No enforcement" is a finding, not a status line.
    if (assessEnforcement(repoDir).level === "none") process.exitCode = 1;
    return;
  }

  if (command === "demo") {
    const { runDemo } = await import("../lib/demo.js");
    const result = await runDemo();
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "install-hook") {
    const { install, uninstall } = await import("../lib/hooks/install.js");
    if (flag("uninstall")) {
      const removed = uninstall(repoDir);
      console.log(removed ? `Removed ${removed}` : "No Backstop hook installed.");
      return;
    }
    console.log(`Installed ${install(repoDir)}`);
    console.log("This is a speed bump, not the breaker: `git push --no-verify` skips it.");
    console.log("Real enforcement is the same check as a required status check on the remote.");
    return;
  }

  if (command === "graph") {
    const outFile = args.find((a) => !a.startsWith("--")) ?? "backstop-graph.html";
    const commits = readHistory(repoDir);
    const tasks = buildGraph(repoDir);
    let deployments = [];
    if (flag("deployments")) ({ deployments } = await deploymentsForStatus(commits));
    const { relations } = runLinkerPass(repoDir, commits, tasks);
    writeFileSync(outFile, renderGraphHtml({ tasks, deployments, relations }));
    console.log(`Wrote ${outFile} (${tasks.length} task(s), ${deployments.length} deployment(s)). Open it directly — no server needed.`);
    return;
  }

  fail(
    [
      "Usage:",
      "  backstop init [--verify <command>] [--force]",
      "  backstop status [--json] [--deployments]",
      "  backstop task start <task-id> [--scope <glob>]... [--relates-to <task-id>]... [--category <name>] [--intent <why>]",
      "  backstop check <task-id> [--env <environment>] [--spent <amount>]",
      "  backstop promote <task-id> [--env <environment>] [--spent <amount>] [--push] [--deploy]",
      "  backstop revert <task-id> [--cascade] [--push]",
      "  backstop graph [outfile] [--deployments]",
      "  backstop install-hook [--uninstall]",
      "  backstop verify",
      "  backstop doctor",
      "  backstop demo",
      "",
      "--deploy and --deployments read VERCEL_TOKEN, VERCEL_PROJECT_ID and VERCEL_TEAM_ID from the environment.",
    ].join("\n"),
  );
}

// Every command reads git history, so "this is not a git repository" is the
// one precondition worth checking up front. Without it, `status` printed two
// raw git fatals and then "No tagged units of work found yet" with exit 0 —
// a command that could not run at all, reported as a clean empty result.
function assertGitRepo() {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repoDir, stdio: "ignore" });
  } catch {
    fail(`${repoDir} is not a git repository. backstop reads lineage from git history; run it inside a repo.`);
    return false;
  }
  return true;
}

// A thrown error is a real outcome (an unknown task, an invalid task id), not
// a bug to show a stack trace for. Exit codes were already correct; this only
// stops correct behaviour from looking like a crash.
// `demo` builds its own throwaway repo, and usage/help need no repo at all.
const NO_REPO_NEEDED = new Set([undefined, "demo", "--help", "-h", "help"]);

try {
  if (NO_REPO_NEEDED.has(command) || assertGitRepo()) await main();
} catch (err) {
  fail(`backstop: ${err.message.split("\n")[0]}`);
}
