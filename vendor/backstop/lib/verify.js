// Runs the project's own configured verification command. This is the
// objective signal the gate and the post-revert check both stand on — not
// an agent's assessment of its own work.

import { execSync } from "node:child_process";

/** Ten minutes. Long enough for a real suite, short enough that a stuck gate surfaces. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000;

/**
 * @returns {{ok: boolean, output: string, skipped?: true, timedOut?: true, reason?: string}}
 * An unset command is NOT a pass: it returns ok:false with a reason, so a
 * project that never configured verification is blocked rather than waved
 * through (CLAUDE.md: if a check can't run, that blocks promotion).
 *
 * Neither is a command that never finishes. Without a timeout this blocked
 * forever on anything that hangs — a test waiting on a port, a runner that
 * opens a prompt, a dev server started by mistake — and a gate that never
 * returns does not block and does not pass: it records nothing and leaves an
 * autonomous agent stuck with no signal at all. A timeout is what turns
 * "never finished" into the blocking answer the constitution already
 * requires for "could not run".
 */
export function runVerify(repoDir, command, { timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS } = {}) {
  if (!command) {
    return { ok: false, output: "", skipped: true, reason: "No verifyCommand configured in .backstop/policy.json" };
  }
  try {
    const output = execSync(command, {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // NODE_TEST_CONTEXT is set by Node's test runner and inherited by any
      // child. A nested `node --test` sees it, switches to child-reporter
      // mode, and EXITS 0 REGARDLESS OF FAILURES — so a project whose verify
      // command is `node --test` gets a false pass from the gate whenever the
      // gate itself runs inside a test process. That is not hypothetical: it
      // is exactly what this project's own suite does when it exercises
      // promote(). A verify command must be judged on its own exit status, not
      // on an environment variable it inherited from whoever invoked the gate.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      timeout: timeoutMs,
      // SIGKILL rather than SIGTERM: a hung runner may ignore a polite signal,
      // and the whole point here is that the gate is guaranteed to return.
      killSignal: "SIGKILL",
    });
    return { ok: true, output };
  } catch (err) {
    const partial = `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
    if (err.killed || err.signal === "SIGKILL") {
      return {
        ok: false,
        timedOut: true,
        output: partial,
        // Rounding 1500ms to "2s" misreports the operator's own setting back
        // to them; show the configured value, not a rounded one.
        reason: `verify command exceeded ${timeoutMs >= 10_000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`} and was killed — treated as a failure, not a pass`,
      };
    }
    return { ok: false, output: partial || err.message };
  }
}
