// Branch-per-task (DECISIONS.md D10): a unit of work lives on its own
// branch, so most mistakes cost nothing — delete the branch. The branch is
// also the structural fact that identifies the task (D13), which is why
// task identity never has to depend on an agent remembering a trailer.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BACKSTOP_DIR, loadPolicy } from "./policy.js";

const BRANCH_PREFIX = "task/";
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASKS_DIR = path.join(BACKSTOP_DIR, "tasks");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function declarationPath(repoDir, taskId) {
  return path.join(repoDir, TASKS_DIR, `${taskId}.json`);
}

/**
 * A task's declaration (scope, policy category) as recorded at creation.
 * Read from the task's own branch when it isn't on the current checkout,
 * so the gate can read it while standing on the base branch.
 */
export function readTaskDeclaration(repoDir, taskId, branch) {
  const file = declarationPath(repoDir, taskId);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  if (!branch) return null;
  try {
    const raw = git(["show", `${branch}:${path.join(TASKS_DIR, `${taskId}.json`)}`], repoDir);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function branchForTask(taskId) {
  return `${BRANCH_PREFIX}${taskId}`;
}

/** The task id implied by a branch name, or null if it isn't a task branch. */
export function taskIdFromBranch(branch) {
  if (!branch.startsWith(BRANCH_PREFIX)) return null;
  const id = branch.slice(BRANCH_PREFIX.length);
  return TASK_ID.test(id) ? id : null;
}

export function currentBranch(repoDir) {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], repoDir);
}

/** The task id of the branch currently checked out, or null. */
export function currentTaskId(repoDir) {
  return taskIdFromBranch(currentBranch(repoDir));
}

/**
 * Start a task: create and check out its branch, and record its declared
 * scope. Scope is a mandatory field at creation time — a task with no
 * declared scope has nothing to check its diff against, so scope-check
 * treats every file as out of scope rather than waving it through.
 */
export function startTask(repoDir, taskId, { scope = [], policyCategory = "default", relatesTo = [], intent = null } = {}) {
  if (!TASK_ID.test(taskId)) {
    throw new Error(`Invalid task id "${taskId}": use letters, digits, dot, dash or underscore.`);
  }
  const branch = branchForTask(taskId);
  const existing = git(["branch", "--list", branch], repoDir);
  if (existing) {
    throw new Error(`Branch ${branch} already exists — pick a new task id or check it out directly.`);
  }

  // Branch from the base branch, never from whatever happens to be checked
  // out. Starting task B while still on task A's branch used to stack B on
  // top of A, so promoting B merged A's unpromoted commits into main while
  // the ledger recorded only B as promoted — work live that never passed the
  // gate, and a recorder wrong about the one question it exists to answer.
  // An agent running tasks in sequence hits this by default.
  const base = loadPolicy(repoDir).baseBranch;
  try {
    git(["rev-parse", "--verify", base], repoDir);
  } catch {
    throw new Error(
      `Base branch "${base}" does not exist (set as baseBranch in .backstop/policy.json). ` +
      "Create it, or point policy.json at the branch tasks should branch from.",
    );
  }
  // Backstop's own bookkeeping under .backstop/ is not the operator's
  // work-in-progress, and must never be what blocks starting the next task.
  const dirty = git(["status", "--porcelain", "--", ":(exclude).backstop"], repoDir);
  if (dirty) {
    throw new Error(
      `Working tree is not clean — commit or stash before starting ${taskId}, ` +
      `so its branch starts from ${base} with nothing carried over.`,
    );
  }
  git(["checkout", "-q", "-b", branch, base], repoDir);

  // relatesTo is the residual knowledge layer nothing structural can reach
  // (DECISIONS.md D21): captured at declaration, never recalled later.
  // Intent is the one field that genuinely cannot be derived — a diff shows
  // what changed, never what it was for. So it is captured here, at
  // declaration, when whoever is acting still knows it; recorded permanently as
  // declared; and never read by a gate check or turned into a graph edge. A
  // gate that reads intent is a gate an agent can talk its way past
  // (docs/design/ACTOR.md). Pillar 1 promises "why" and had no field for it.
  const declaration = {
    taskId, branch, scope, policyCategory, relatesTo,
    intent: intent ? { text: intent, source: "declared" } : null,
    declaredAt: new Date().toISOString(),
  };
  mkdirSync(path.join(repoDir, TASKS_DIR), { recursive: true });
  writeFileSync(declarationPath(repoDir, taskId), JSON.stringify(declaration, null, 2) + "\n");
  git(["add", path.join(TASKS_DIR, `${taskId}.json`)], repoDir);
  git(["commit", "-q", "-m", `Declare task ${taskId}\n\nTask-Id: ${taskId}`], repoDir);

  return declaration;
}
