// The promotion ledger: append-only, one JSON object per line, versioned by
// git like everything else. Dependency edges are still derived mechanically
// from commits (lib/ledger.js) — this file records the *decisions*: what was
// promoted, which checks ran, and the day-one fields (DECISIONS.md D9) that
// would be expensive to retrofit onto months of history later.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { BACKSTOP_DIR } from "./policy.js";
import { resolveActor } from "./actor.js";

export const LEDGER_FILE = path.join(BACKSTOP_DIR, "ledger.jsonl");

export function ledgerPath(repoDir) {
  return path.join(repoDir, LEDGER_FILE);
}

export function readRecords(repoDir) {
  const file = ledgerPath(repoDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Every record carries who wrote it. Done here rather than at each call site
 * so it cannot be forgotten: a record without an actor is one that can never
 * answer a fleet operator's first question, and D9's argument is that the
 * field is free now and a fan-out to backfill (docs/design/ACTOR.md).
 *
 * The actor is derived, not declared — and `source`/`verified` travel with it,
 * so "we know who did this" and "someone told us who did this" stay different
 * facts in the record itself.
 */
export function appendRecord(repoDir, record) {
  mkdirSync(path.join(repoDir, BACKSTOP_DIR), { recursive: true });
  const withActor = { ...record, actor: record.actor ?? resolveActor(repoDir) };
  appendFileSync(ledgerPath(repoDir), JSON.stringify(withActor) + "\n");
  return withActor;
}

export function promotedTaskIds(repoDir) {
  return new Set(
    readRecords(repoDir)
      .filter((r) => r.event === "promoted")
      .map((r) => r.taskId),
  );
}

/**
 * A blocked promotion is recorded too. A gate that stops execution but
 * leaves no trace is indistinguishable afterwards from one that never ran —
 * the block has to be as visible in the ledger as the promotion.
 */
export function recordBlocked(repoDir, { taskId, branch, checks, at }) {
  return appendRecord(repoDir, { event: "blocked", taskId, branch, checks, at });
}

export function recordPromoted(repoDir, record) {
  return appendRecord(repoDir, { event: "promoted", ...record });
}

/**
 * Commit the ledger, because "append-only records versioned by git" (D18) was
 * only ever true of the first half. The file was written and never committed,
 * so a fresh clone had no ledger at all: what was promoted, what was blocked,
 * which checks ran and what a deploy did existed solely in the working tree of
 * whichever machine ran `promote`. A recorder whose records do not survive a
 * clone is not recording anything, and TL3's "a block must leave a trace"
 * meant a trace only its own operator could ever see.
 *
 * `--only` so this commits the ledger and nothing else: an operator with other
 * work staged must not have it swept into a bookkeeping commit.
 */
export function commitLedger(repoDir, { message, taskId }) {
  const run = (args) => execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    run(["add", "--", LEDGER_FILE]);
    if (!run(["diff", "--cached", "--name-only", "--", LEDGER_FILE])) return null;
    const trailer = taskId ? `\n\nTask-Id: ${taskId}` : "";
    run(["commit", "-q", "--only", "-m", `${message}${trailer}`, "--", LEDGER_FILE]);
    return run(["rev-parse", "HEAD"]);
  } catch (err) {
    // The record is already on disk, and for a promotion the merge has already
    // landed — neither can be undone here. Report rather than pretend.
    return { error: err.stderr?.toString().trim() || err.message };
  }
}
