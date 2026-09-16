// Is the breaker actually mounted?
//
// Backstop's central claim is that its limits are enforced rather than
// advisory, and the mechanism is that `promote` exits non-zero so it can be
// mounted where the pusher cannot reach it. Nothing in the tool ever checked
// whether anyone had done that.
//
// Two findings converged on this. An adversarial agent got four changes onto
// main that the gate had blocked — not by defeating a check (it blocked 2 of 2
// and promoted 0) but by running `git merge` instead of `backstop promote`, in
// a repo where no hook, no CI and no remote existed. And TL52: this project's
// own CI was configured, correct, and had never executed once in 71 runs.
//
// Both are the same gap. The gate works; there was no way to find out whether
// it was in the path. A governance tool that cannot tell you whether it is
// governing anything is the failure mode it exists to prevent.
//
// Deliberately local-only, because the recorder and breaker must run with no
// network (CLAUDE.md). That means this reports what is CONFIGURED, and says
// plainly that configuration is not execution — which is exactly the mistake
// TL52 recorded.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const WORKFLOW_DIRS = [".github/workflows", ".gitlab-ci.yml", ".circleci"];

/** Does this CI config actually invoke the gate, rather than merely mention it? */
function invokesGate(text) {
  // `backstop check` or `backstop promote` on a command line. A workflow NAMED
  // "backstop gate" that runs a test suite is precisely what AUDIT-05 F2 found,
  // so the name is not evidence — the invocation is.
  return /backstop(\.js)?['"\s]+(check|promote)\b/.test(text);
}

function ciAssessment(repoDir) {
  const found = [];
  for (const rel of WORKFLOW_DIRS) {
    const full = path.join(repoDir, rel);
    if (!existsSync(full)) continue;
    const files = rel.endsWith(".yml")
      ? [full]
      : readdirSync(full).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(full, f));
    for (const file of files) {
      let text;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      found.push({ file: path.relative(repoDir, file), invokesGate: invokesGate(text) });
    }
  }
  return found;
}

/**
 * @returns {{level: "none"|"speed-bump"|"configured", hook: boolean,
 *            ci: Array, remote: string|null, notes: string[]}}
 *
 * `level` is the strongest thing found, and "configured" is deliberately not
 * called "enforced": whether CI ever runs, and whether the branch actually
 * requires it, are facts on the host that cannot be read from here.
 */
export function assessEnforcement(repoDir) {
  const hookPath = path.join(repoDir, ".git", "hooks", "pre-push");
  const hook = existsSync(hookPath) &&
    readFileSync(hookPath, "utf8").includes("Backstop pre-push hook");

  const ci = ciAssessment(repoDir);
  const gateInCi = ci.some((c) => c.invokesGate);

  let remote = null;
  try {
    remote = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim() || null;
  } catch { /* no remote configured */ }

  const notes = [];
  if (gateInCi && !remote) {
    notes.push("CI invokes the gate but this repository has no remote, so nothing runs it.");
  }
  if (ci.length && !gateInCi) {
    notes.push(
      `${ci.map((c) => c.file).join(", ")} exists but does not invoke \`backstop check\` or ` +
      "`backstop promote` — a workflow named after the gate is not the gate (AUDIT-05 F2).",
    );
  }
  if (gateInCi) {
    notes.push(
      "Configured is not running. Backstop's own CI was correct and never executed once in 71 " +
      "runs (TL52) — read the run history on the host, and confirm the check is REQUIRED on the " +
      "protected branch. Neither fact is visible from here.",
    );
  }

  const level = gateInCi && remote ? "configured" : hook ? "speed-bump" : "none";
  return { level, hook, ci, remote, notes };
}

/** Human-readable lines. Returns [] when enforcement is configured and nothing needs saying. */
export function enforcementReport(repoDir) {
  const a = assessEnforcement(repoDir);
  const lines = [];

  if (a.level === "none") {
    lines.push("NOT ENFORCED — nothing in this repository runs the gate.");
    lines.push("  Every check below can be skipped by running `git merge` instead of `backstop promote`.");
    lines.push("  That is not a flaw in the checks; it is that nothing has been mounted to run them.");
  } else if (a.level === "speed-bump") {
    lines.push("SPEED BUMP ONLY — the pre-push hook is installed, and `git push --no-verify` skips it.");
    lines.push("  A local hook is not enforcement: whoever is being gated can bypass it.");
  } else {
    lines.push("Gate is invoked by CI, against a remote. That is where enforcement can be real.");
  }

  lines.push(`  pre-push hook:  ${a.hook ? "installed" : "not installed (backstop install-hook)"}`);
  lines.push(`  CI invokes gate: ${a.ci.some((c) => c.invokesGate)
    ? a.ci.filter((c) => c.invokesGate).map((c) => c.file).join(", ")
    : "no"}`);
  lines.push(`  remote:         ${a.remote ?? "none"}`);
  for (const note of a.notes) lines.push(`  ! ${note}`);
  return lines;
}
