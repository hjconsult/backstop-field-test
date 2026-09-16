// Installs the pre-push hook. Deliberately modelled on the one genuinely
// good pattern the competitor audit turned up: an install that states exactly
// what it touches and is fully reversible (`--uninstall` removes precisely
// what was added, nothing else).

import { chmodSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "pre-push");
/** This installation's own CLI entry point, resolved absolutely. */
export const CLI_PATH = path.resolve(HERE, "..", "..", "bin", "backstop.js");

export function hookPath(repoDir) {
  return path.join(repoDir, ".git", "hooks", "pre-push");
}

export function install(repoDir) {
  const target = hookPath(repoDir);
  if (existsSync(target) && !readFileSync(target, "utf8").includes("Backstop pre-push hook")) {
    throw new Error(`Refusing to overwrite an existing pre-push hook at ${target}. Move it aside first.`);
  }
  // Write in the absolute path of the CLI doing the installing, rather than
  // copying a script that shells out to a relative `bin/backstop.js`. That
  // relative path resolves only inside Backstop's own checkout: installed
  // into a user's repo the old hook aborted every push and reported "the
  // ledger does not build", which blamed the user for the hook's own bug.
  const script = readFileSync(SOURCE, "utf8").replaceAll("__BACKSTOP_CLI__", CLI_PATH);
  writeFileSync(target, script);
  chmodSync(target, 0o755);
  return target;
}

export function uninstall(repoDir) {
  const target = hookPath(repoDir);
  if (!existsSync(target)) return null;
  if (!readFileSync(target, "utf8").includes("Backstop pre-push hook")) {
    throw new Error(`${target} is not Backstop's hook — leaving it alone.`);
  }
  rmSync(target);
  return target;
}
