// `backstop demo` — the whole product in about ninety seconds, against a real
// throwaway git repository. Nothing here is simulated: real commits, a real
// derived dependency graph, a real cascade revert, a real verification run.
// If this command ever stops telling the truth, the product has stopped
// working — which is why it is a command rather than a slide.

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGraph, readHistory } from "./ledger.js";
import { transitiveDependents, commitsForTasks } from "./cascade.js";
import { revertWithVerification } from "./revert.js";
import { runLinkerPass } from "./knowledge/linker.js";
import { writePolicy, DEFAULT_POLICY } from "./policy.js";
import { startTask } from "./task.js";
import { promote } from "./gate/promote.js";
import { readRecords } from "./ledger-store.js";

const git = (dir, ...args) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function commit(dir, taskId, files, subject) {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", `${subject}\n\nTask-Id: ${taskId}`);
}

// The verify command has to stay meaningful on both sides of an undo: run the
// entry point if it is still there. Naming the file directly would "fail"
// simply because the revert correctly deleted it — which is a broken check,
// not a broken tree, and the first run of this demo made exactly that mistake.
const VERIFY = "node -e \"const fs=require('fs');if(fs.existsSync('checkout.js'))require('child_process').execSync('node checkout.js',{stdio:'inherit'})\"";

export async function runDemo({ log = console.log } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "backstop-demo-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "demo@example.com");
  git(dir, "config", "user.name", "Demo");
  writeFileSync(path.join(dir, "README.md"), "# demo shop\n");
  writePolicy(dir, { ...DEFAULT_POLICY, verifyCommand: VERIFY, meters: { spend: { limit: 10 } } });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");

  log("");
  log("  Three agents work on a shop. Each unit of work is one task.");
  log("");

  commit(dir, "pricing", { "lib/pricing.js": "export const price = (n) => n * 100;\n" }, "add pricing");
  log("    pricing   agent 1 adds lib/pricing.js");

  commit(
    dir,
    "checkout",
    { "checkout.js": "import { price } from './lib/pricing.js';\nif (price(2) !== 200) process.exit(1);\n" },
    "add checkout",
  );
  log("    checkout  agent 2 adds checkout.js — which imports pricing, but never edits its file");

  commit(dir, "banner", { "banner.js": "export const banner = 'Summer sale';\n" }, "add banner");
  log("    banner    agent 3 adds an unrelated banner");

  log("");
  log("  Nobody told Backstop what depends on what. It read the diffs and the imports:");
  log("");
  const graph = buildGraph(dir);
  for (const node of graph) {
    const deps = node.dependsOn.length ? `depends on ${node.dependsOn.join(", ")}` : "depends on nothing";
    log(`    ${node.taskId.padEnd(10)} ${deps}`);
  }

  const { relations, orphans } = runLinkerPass(dir, readHistory(dir), graph);
  log("");
  log(`    ${relations.length} relates-to edge(s), orphan rate ${(orphans.rate * 100).toFixed(0)}%`);

  log("");
  log("  Now pricing turns out to be wrong. Undo it — and only what actually needed it.");
  log("");
  const affected = transitiveDependents(graph, "pricing");
  log(`    cascade set: ${affected.join(", ")}`);
  log(`    untouched:   ${graph.map((n) => n.taskId).filter((id) => !affected.includes(id)).join(", ")}`);

  const targets = commitsForTasks(readHistory(dir), affected);
  const { status, results } = revertWithVerification(dir, targets, VERIFY);
  log("");
  for (const r of results) log(`    reverted ${r.sha.slice(0, 8)}  ${r.taskId}`);

  log("");
  log(`  Verified after the undo: ${status}`);
  log("    (the undo is checked, not assumed — a revert that leaves a broken tree reports broken)");

  const bannerSurvived = existsSync(path.join(dir, "banner.js"));
  const checkoutGone = !existsSync(path.join(dir, "checkout.js"));
  const pricingGone = !existsSync(path.join(dir, "lib/pricing.js"));

  log("");
  log(`    lib/pricing.js removed: ${pricingGone}`);
  log(`    checkout.js removed:    ${checkoutGone}   (it imported pricing — nothing in its own diff said so)`);
  log(`    banner.js still there:  ${bannerSurvived}   (unrelated work is not collateral)`);
  log("");

  // The recorder and the undo are two of the three things this claims to be.
  // Showing them and then saying "that is the product" left the breaker as a
  // word rather than a demonstration — so it runs here, for real, against the
  // same repo: a task that costs more than the project allows.
  log("  And the third part: a limit that actually stops work.");
  log("");
  startTask(dir, "pricing-v2", { scope: ["lib/**"] });
  commit(dir, "pricing-v2", { "lib/pricing.js": "export const price = (n) => n * 110;\n" }, "reprice");
  // promote, not runChecks: runChecks inspects without recording, and the
  // claim two lines below is that the decision reaches the ledger. Running the
  // cheaper call and then saying so would be exactly the kind of overclaim
  // this project keeps finding in other people's tools.
  const gate = await promote(dir, "pricing-v2", { environment: "production", spent: 42 });
  for (const c of gate.checks.filter((c) => c.status !== "pass")) {
    log(`    ${c.status === "fail" ? "\u2717" : "!"} ${c.name.padEnd(22)} ${c.detail}`);
  }
  log("");
  log(`    gate verdict: ${gate.ok ? "would promote" : "BLOCKED"} — the CLI exits non-zero, which is what`);
  log("    lets this be a required check rather than a log line nobody reads.");
  git(dir, "checkout", "-q", "main");

  const blocked = readRecords(dir).filter((r) => r.event === "blocked").length;
  log("");
  log(`  The block is written down, not just printed: ${blocked} blocked record(s) in`);
  log("  .backstop/ledger.jsonl. A gate that stops work but leaves no trace is");
  log("  indistinguishable afterwards from one that never ran.");

  const ok = bannerSurvived && checkoutGone && pricingGone
    && status === "reverted+verified" && !gate.ok && blocked > 0;
  log(ok ? "  That is the product." : "  DEMO FAILED — the mechanism did not behave as described above.");
  log(`  Repo left at ${dir} if you want to poke at it.`);
  log("");

  return { ok, dir, status, affected };
}
