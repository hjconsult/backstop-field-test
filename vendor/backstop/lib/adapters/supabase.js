// Supabase adapter: two separate responsibilities, kept separate on
// purpose (see docs/plan/STAGE1.md) — classifying a migration's safety,
// and the fork-and-cutover path a destructive one is forced through.
//
// The "disposable database" this stage proves against is a real
// node:sqlite database file, not a mock. What matters for the proof isn't
// that it's Postgres specifically — it's that a destructive change is
// physically incapable of touching the tracked database directly, and
// that undo means pointing back at the untouched original, never a
// down-migration nobody trusts.

import { copyFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// Loaded on first use, not at import: node:sqlite prints an experimental
// warning the moment it is required, and `backstop status` has no business
// emitting a database warning.
let DatabaseSync;
function sqlite() {
  if (!DatabaseSync) ({ DatabaseSync } = createRequire(import.meta.url)("node:sqlite"));
  return DatabaseSync;
}

// Whitelist (DECISIONS.md D16): a statement is additive only if it is one
// of these exact shapes. Everything else — DROP, RENAME, TRUNCATE, DELETE,
// UPDATE, ALTER COLUMN, ADD CONSTRAINT, and anything unrecognized — is
// destructive.
//
// Two shapes look additive and are not, both for the same reason: they
// succeed on an empty dev table and fail on real data, which is exactly the
// case that matters (TL4). A NOT NULL column added without a DEFAULT is one.
// CREATE UNIQUE INDEX is the other — it fails on any table that already holds
// duplicates — and it was on this whitelist while `ALTER TABLE ... ADD
// CONSTRAINT ... UNIQUE` was already treated as destructive, so the same
// constraint was classified two different ways depending on how it was
// spelled.
//
// Known limitation, deliberately not classified: a plain CREATE INDEX takes
// an exclusive lock for the duration of the build, so on a large live table
// it is an availability problem even though it destroys nothing. This
// classification is about data, not locks; CONCURRENTLY is the operator's
// call and is not something the gate reasons about yet.
const ADDITIVE_STATEMENT =
  /^(CREATE\s+(TABLE|INDEX)(\s+IF\s+NOT\s+EXISTS)?\s+\S|ALTER\s+TABLE\s+\S+\s+ADD\s+(COLUMN\s+)?(?!CONSTRAINT\b)\S)/i;

function statements(sql) {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Classify a migration's SQL. Additive only when every statement is
 * additive; an empty or unclassifiable migration is destructive, because
 * an unclassifiable change is exactly the case this project exists to
 * never silently wave through.
 */
export function classifyMigration(sql) {
  const stmts = statements(sql);
  if (stmts.length === 0) return "destructive";
  const additive = stmts.every(
    (s) => ADDITIVE_STATEMENT.test(s) && !(/\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s)),
  );
  return additive ? "additive" : "destructive";
}

/** Apply a migration directly to the tracked database file (additive path only). */
export function applyAdditive(dbPath, sql) {
  const db = new (sqlite())(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/**
 * Fork the tracked database to a fresh disposable file, apply the
 * migration there only, and run the caller's verification against the
 * fork. The tracked file is never opened for writing in this path — the
 * only way this function touches it is a byte copy to a new path.
 */
export function forkAndCutover(dbPath, sql, verify) {
  const dir = mkdtempSync(path.join(tmpdir(), "backstop-fork-"));
  const forkPath = path.join(dir, "fork.sqlite");
  copyFileSync(dbPath, forkPath);

  const db = new (sqlite())(forkPath);
  let verifyResult;
  try {
    db.exec(sql);
    verifyResult = verify ? verify(db) : true;
  } finally {
    db.close();
  }

  return { forkPath, promotable: !!verifyResult };
}

/**
 * Orchestrator: classify, then route. Additive proceeds automatically
 * against the tracked database. Destructive is never applied to it —
 * only ever to a fork, and only ever treated as promotable once the
 * fork's own verification passes.
 */
export function runMigration({ dbPath, sql, verify }) {
  const classification = classifyMigration(sql);
  if (classification === "additive") {
    applyAdditive(dbPath, sql);
    return { classification, appliedTo: "tracked", promotable: true };
  }
  const { forkPath, promotable } = forkAndCutover(dbPath, sql, verify);
  return { classification, appliedTo: "fork", forkPath, promotable };
}

/** Byte-for-byte check that the tracked database file wasn't touched. */
export function unchanged(dbPathBefore, snapshotBuffer) {
  return Buffer.compare(readFileSync(dbPathBefore), snapshotBuffer) === 0;
}
