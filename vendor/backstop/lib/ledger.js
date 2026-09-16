// Stage 0 ledger: dependency edges are derived mechanically from real git
// artifacts (diffs, changed files, parent commits) — never from an agent's
// own narration of what it did. See CLAUDE.md's constitutional rules.

import { execFileSync } from "node:child_process";
import { isSourceFile, importedPaths } from "./imports.js";
import { BACKSTOP_DIR, loadPolicy } from "./policy.js";
import { matchesAnyGlob } from "./gate/scope-check.js";
import { promotedTaskIds } from "./ledger-store.js";

const TASK_ID_TRAILER = /^Task-Id:\s*(\S+)\s*$/m;

function git(args, cwd) {
  // stderr piped, not inherited: several call sites probe for things that may
  // not exist (a base branch, an ancestor), and git's "fatal:" printing over
  // our own output made a handled absence look like a crash.
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A file's contents as of one commit — what it imported when it was written. */
function fileAtCommit(repoDir, sha, filePath) {
  try {
    return git(["show", `${sha}:${filePath}`], repoDir);
  } catch {
    return null; // deleted in this commit, or otherwise unreadable
  }
}

/**
 * Read many blobs in ONE `git cat-file --batch` instead of a `git show` each.
 *
 * Deriving import edges reads every source file a commit touched, and since
 * TL53 it reads the parent's version too — so a repo of 89 commits was
 * spawning over 300 processes for content git will stream in a single pass
 * (AUDIT-05 F10). The protocol: write `<rev>:<path>` lines on stdin, read back
 * `<sha> <type> <size>\n<contents>\n` per line, or `<spec> missing` for one
 * that does not resolve — which is the normal answer for a file the parent
 * commit did not have.
 *
 * @param {string[]} specs `<rev>:<path>` strings
 * @returns {Map<string, string|null>} spec -> contents, null when missing
 */
function batchReadBlobs(repoDir, specs) {
  const out = new Map();
  const wanted = [...new Set(specs)];
  if (!wanted.length) return out;

  let stdout;
  try {
    stdout = execFileSync("git", ["cat-file", "--batch"], {
      cwd: repoDir,
      input: wanted.join("\n") + "\n",
      // No `encoding` at all, so stdout comes back as a Buffer: the header
      // carries a BYTE length, and decoding first would make that length
      // disagree with the string for any non-ASCII content. Setting
      // `encoding: "buffer"` does NOT do this — execFileSync uses it to encode
      // the INPUT and throws ERR_UNKNOWN_ENCODING, which the catch below
      // swallowed into a silent per-file fallback. The batch appeared to work
      // and bought nothing.
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return out; // fall back to per-file reads rather than losing the answer
  }

  let offset = 0;
  for (const spec of wanted) {
    const newline = stdout.indexOf(0x0a, offset);
    if (newline === -1) break;
    const header = stdout.toString("utf8", offset, newline);
    if (header.endsWith(" missing")) {
      out.set(spec, null);
      offset = newline + 1;
      continue;
    }
    const size = Number.parseInt(header.slice(header.lastIndexOf(" ") + 1), 10);
    if (!Number.isFinite(size)) break;
    const start = newline + 1;
    out.set(spec, stdout.toString("utf8", start, start + size));
    offset = start + size + 1; // git writes a trailing newline after contents
  }
  return out;
}

/**
 * Every commit reachable from `ref`, oldest first, with its task id and
 * changed files. The ref is explicit because the gate evaluates a task
 * branch while standing on the base branch — reading HEAD there would
 * silently answer about the wrong history.
 */
export function readHistory(repoDir, ref = "HEAD") {
  // An empty repo (no commits yet) makes `git log` fail rather than return
  // nothing — check first so an empty ledger is a clean [], not a crash.
  try {
    git(["rev-parse", "--verify", "-q", ref], repoDir);
  } catch {
    return [];
  }

  // %x1f after %B too: --name-only appends the file list after the format
  // output, and the body can contain newlines, so the list needs its own field
  // rather than being told apart by position within the body.
  // The record separator LEADS, because --name-only appends the file list
  // after the format output — with a trailing separator the files land at the
  // start of the NEXT record instead of the end of their own. And %x1f after
  // %B so the list is its own field: a commit body contains newlines, so the
  // files cannot be told apart by position within it.
  const format = "%x1e" + ["%H", "%P", "%B"].join("%x1f") + "%x1f";
  // --topo-order, not git log's default date order. Default order interleaves
  // branches by commit timestamp, which can emit a commit BEFORE its own
  // parent when the two were made on machines whose clocks disagree — routine
  // for a fleet of agents on separate containers, which is the deployment
  // model this exists for.
  //
  // Both things built from this order break if it is wrong. Revert order must
  // undo a child before its parent. And buildGraph derives dependency edges by
  // walking commits in this order and recording which task last touched each
  // file: see a descendant first and the edge is recorded backwards — the
  // parent is reported as depending on its own child. A lineage graph that
  // inverts an edge under clock skew is not mechanically derived, it is
  // derived from the clock. --topo-order guarantees no commit is emitted
  // before its ancestors, which is exactly the invariant both uses need.
  // --name-only in the same pass, and --root so the first commit reports its
  // files rather than silently reporting none — without it, dependency
  // detection breaks for everything built on top of a repo's first commit.
  const raw = git(
    ["log", "--topo-order", "--reverse", "--root", "--name-only", `--pretty=format:${format}`, ref],
    repoDir,
  );
  const commits = raw
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, parents, rawBodyField, fileLines = ""] = chunk.split("\x1f");
      // trimEnd to match what the old parse produced: the body used to be the
      // last field, so `chunk.trim()` stripped its trailing newline. Keeping
      // that exactly is the point — this change is a speed-up and must not
      // alter a single byte of output.
      const body = rawBodyField.trimEnd();
      const taskMatch = body.match(TASK_ID_TRAILER);
      // File names come from the same `git log` pass as everything else —
      // see the --name-only note above. This used to spawn `git diff-tree`
      // per commit, which is one subprocess per commit for data git was
      // already willing to emit alongside the commit header (AUDIT-05 F10).
      const files = fileLines
        .split("\n")
        .filter(Boolean)
        .filter(isLineageBearing);
      return {
        sha,
        parents: parents.split(" ").filter(Boolean),
        taskId: taskMatch ? taskMatch[1] : null,
        message: body.split("\n")[0],
        rawBody: body,
        files,
      };
    });
  return commits;
}

/**
 * Backstop's own bookkeeping is not product lineage. Once promotion records
 * became real commits, every promoted task touched `.backstop/ledger.jsonl`,
 * so file-overlap chained each task to whichever task promoted before it:
 * an unrelated banner "depended on" a shopping cart, and a cascade from the
 * first task would have taken every later one down with it. The recorder must
 * not appear in its own record. (Same reasoning as TL8 for scope-check.)
 */
function isLineageBearing(file) {
  return !file.startsWith(`${BACKSTOP_DIR}/`);
}

/**
 * Does touching this file mean one task depends on another?
 *
 * Deliberately separate from isLineageBearing, and applied only when deriving
 * edges — never when reading history. A task that edited only a README must
 * still be revertable, so the file has to stay in the commit's file list; it
 * just must not chain that task to whoever edited the README before it.
 * Filtering in readHistory would have made such a task invisible and
 * unrevertable, which is a worse bug than the one being fixed.
 */
function createsDependencyEdge(file, ignoreGlobs) {
  return !matchesAnyGlob(ignoreGlobs, file);
}

/**
 * Files that several tasks touch without depending on one another.
 *
 * `.backstop/` was special-cased for exactly this reason and the rule was
 * never generalised. A manifest is the same shape of problem: most tasks add a
 * dependency line, so file-overlap chains every task to whichever one edited
 * package.json before it. Measured on a corpus built through the gate with no
 * cross-task imports at all, every false edge came from package.json or a
 * markdown file — the worst cascade took 8 of 16 tasks that nothing connected.
 *
 * Dropping the overlap edge does not lose a real dependency: if task B's code
 * actually uses what task A added to the manifest, B imports it, and the
 * import graph carries that edge properly. What is lost is the *conflict* —
 * two tasks editing the same manifest block will conflict on revert, and that
 * is a one-file conflict to resolve, not a reason to revert everything after.
 * Reporting it as such is the remaining half of this, and is not done here.
 *
 * Configurable, because "which files are shared bookkeeping" is a property of
 * a project, not of this tool.
 */
export const DEFAULT_LINEAGE_IGNORE = [
  "**/*.md",
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock", "poetry.lock",
];

/**
 * Did this edit only register something in the file, rather than change what
 * it does?
 *
 * A barrel (`src/index.js`, `mod.rs`, `__init__.py`, a router table, a DI
 * registration) is appended to by every task. File-overlap then reads that as
 * a dependency chain: four unrelated functions became a spine where reverting
 * the first took all four (TL50). It is the manifest problem from TL49 wearing
 * a source file, so `lineageIgnore` cannot answer it — a barrel IS source, and
 * a real change to one is a real dependency.
 *
 * The distinguishing fact is in the diff. Adding `const x = require('./x')` and
 * an entry to the export list is *registration*: the task is announcing itself
 * alongside the others, not using them. Changing logic in the same file is not.
 *
 * Deliberately errs toward dropping an edge rather than inventing one. An edge
 * we miss under-cascades, and a revert that leaves a broken tree is caught by
 * post-revert verification and reported as `reverted+broken` (D2). An edge we
 * invent over-cascades, and destroying unrelated work has no such backstop.
 * Given one of the two failures is checked and the other is silent, the checked
 * one is the safer place to be wrong.
 */
const REGISTRATION_LINE = [
  /^\s*import\b/,                                            // an import binding
  // Only a re-export — `export { x }` or `export * from`. NOT `export const`,
  // which is a declaration and the most ordinary line in a source file. The
  // first version of this matched any line starting with `export`, so editing
  // `export const core = 1` to `export const core = 2` read as registration
  // and the real dependency vanished. Caught by C2, which exists for an
  // unrelated reason (clock skew) and happened to use exactly that shape.
  /^\s*export\s*(\{|\*)/,
  /^\s*(const|let|var)\s+[\w${},\s]+=\s*require\(/,          // CJS require binding
  /^\s*module\.exports\s*=/,                                // CJS export opener
  // A bare entry in an export list. Must look like an identifier: the first
  // version accepted any word characters, so a line containing just `2` read
  // as an export entry and a real overlap edge disappeared.
  /^\s*[A-Za-z_$][\w$]*\s*(:\s*[\w$.]+)?\s*,?\s*$/,
  /^\s*[{}()[\];,]*\s*$/,                                   // punctuation and blanks
  /^\s*(\/\/|\/\*|\*)/,                                     // comments
];

const isRegistrationLine = (line) => REGISTRATION_LINE.some((re) => re.test(line));

/**
 * Is this file an aggregator — nothing but wiring?
 *
 * The stronger predicate, and the one that carries the meaning. Judging an
 * *edit* by its changed lines alone misfires: a two-line fixture where `auth.js`
 * goes from "1" to "1\n2" had its added line read as an export entry, and a
 * real overlap edge vanished. Asking whether the whole file is wiring cannot
 * make that mistake, and it is what "barrel" actually means.
 */
export function isAggregatorFile(content) {
  if (content === null) return false;
  const lines = content.split("\n").filter((l) => l.trim().length);
  // An empty or near-empty file is not an aggregator; it has not declared
  // itself to be anything yet.
  if (lines.length < 2) return false;
  return lines.every(isRegistrationLine);
}

export function isRegistrationOnlyEdit(before, after) {
  if (before === null || after === null) return false; // a created or deleted file is not registration
  // Both sides must be pure wiring. A file that had logic and lost it, or
  // gained some, is a real change to a real file.
  if (!isAggregatorFile(before) || !isAggregatorFile(after)) return false;
  const beforeLines = new Set(before.split("\n"));
  const afterLines = new Set(after.split("\n"));
  const changed = [
    ...after.split("\n").filter((l) => !beforeLines.has(l)),
    ...before.split("\n").filter((l) => !afterLines.has(l)),
  ];
  if (changed.length === 0) return false; // nothing changed here; let the normal rules apply
  return changed.every(isRegistrationLine);
}

/**
 * Dependency edges, computed structurally: task B depends on task A if a
 * file B's commit touched was last touched (before B) by a commit tagged
 * with task A. No agent is asked; this is derived from real diffs only.
 */
export function computeDependencyGraph(commits, { repoDir = null, lineageIgnore = DEFAULT_LINEAGE_IGNORE } = {}) {
  // One pass to work out which blobs are needed, one batch to fetch them, then
  // the derivation reads from memory. Nothing about the result changes; the
  // only difference is how many processes it costs.
  const blobs = new Map();
  if (repoDir) {
    const specs = [];
    for (const commit of commits) {
      if (!commit.taskId) continue;
      const parent = commit.parents?.[0] ?? null;
      for (const file of commit.files) {
        if (!isSourceFile(file)) continue;
        specs.push(`${commit.sha}:${file}`);
        if (parent) specs.push(`${parent}:${file}`);
      }
    }
    for (const [spec, contents] of batchReadBlobs(repoDir, specs)) blobs.set(spec, contents);
  }
  const readBlob = (sha, file) => {
    const spec = `${sha}:${file}`;
    // A spec the batch did not answer for falls back to a direct read, so a
    // batch that fails or truncates degrades in speed rather than in truth.
    return blobs.has(spec) ? blobs.get(spec) : fileAtCommit(repoDir, sha, file);
  };

  const lastTouchedBy = new Map(); // file path -> task id
  const nodes = new Map(); // task id -> { taskId, commits: [], dependsOn: Set }

  for (const commit of commits) {
    if (!commit.taskId) continue; // untagged commits carry no lineage
    if (!nodes.has(commit.taskId)) {
      nodes.set(commit.taskId, {
        taskId: commit.taskId,
        commits: [],
        dependsOn: new Set(),
        edges: [],
      });
    }
    const node = nodes.get(commit.taskId);
    node.commits.push(commit.sha);

    // Why an edge exists is as much a fact as that it exists, and it is the
    // only way to answer "why would reverting X take Y down with it" — the
    // question an operator actually asks. It is also how the barrel-file spine
    // was diagnosed: the shape of the fix depends on which rule fired.
    const edge = (to, kind, via) => {
      if (to === commit.taskId) return;
      node.dependsOn.add(to);
      node.edges.push({ to, kind, via });
    };

    // Import edges, from the references this commit ADDED — not from every
    // reference the file happens to contain.
    //
    // Reading the whole file attributed its entire import list to whoever
    // edited it last, which is how a barrel file chained a repo into one
    // spine: four unrelated functions, each registering itself in
    // src/index.js, and the fourth inherited edges to all three earlier ones
    // because index.js already required them (TL50, measured on an
    // agent-built repo — three import edges and one overlap edge, so fixing
    // overlap alone would have removed a quarter of the problem).
    //
    // A task depends on what it newly references. The requires that were
    // already in that file were put there by earlier tasks and belong to them.
    // This needs no notion of "is this a barrel" — it is the same rule for
    // every file, and it is what "derived from structural artifacts" should
    // have meant all along: the artifact is the diff, not the file.
    if (repoDir) {
      const parent = commit.parents?.[0] ?? null;
      for (const file of commit.files) {
        if (!isSourceFile(file)) continue;
        const source = readBlob(commit.sha, file);
        if (source === null) continue;
        // A file this commit created has no earlier version, so every
        // reference in it is new — which is the correct reading.
        const before = parent ? readBlob(parent, file) : null;
        const alreadyThere = before === null ? new Set() : new Set(importedPaths(file, before));
        for (const target of importedPaths(file, source)) {
          if (alreadyThere.has(target)) continue;
          const priorTask = lastTouchedBy.get(target);
          if (priorTask) edge(priorTask, "import", `${file} -> ${target}`);
        }
      }
    }

    for (const file of commit.files) {
      // A shared manifest or a doc is touched by most tasks and connects none
      // of them. It neither creates an edge nor claims the file, so the next
      // task to touch it does not inherit one either.
      if (!createsDependencyEdge(file, lineageIgnore)) continue;

      // Nor does merely registering yourself in a barrel. Same treatment: no
      // edge, and no claim on the file, so the next task to register does not
      // inherit one either. Claiming it would rebuild the chain one hop later.
      if (repoDir && isSourceFile(file)) {
        const parent = commit.parents?.[0] ?? null;
        const after = readBlob(commit.sha, file);
        const before = parent ? readBlob(parent, file) : null;
        if (isRegistrationOnlyEdit(before, after)) continue;
      }

      const priorTask = lastTouchedBy.get(file);
      if (priorTask) edge(priorTask, "overlap", file);
      lastTouchedBy.set(file, commit.taskId);
    }
  }

  return Array.from(nodes.values()).map((n) => ({
    ...n,
    dependsOn: Array.from(n.dependsOn),
    edges: n.edges,
  }));
}

const REVERT_SUBJECT = /^Revert "/;
const REVERTS_COMMIT = /This reverts commit ([0-9a-f]{7,40})/;

/**
 * Marks tasks as reverted by detecting git's own `git revert` commit
 * convention (`Revert "<subject>"` + `This reverts commit <sha>.`) — never
 * a custom trailer we'd have to trust an agent to add correctly. A task
 * counts as reverted once every one of its commits has been reverted.
 */
export function applyRevertStatus(commits, graph) {
  const shaToTask = new Map();
  for (const commit of commits) {
    if (commit.taskId) shaToTask.set(commit.sha, commit.taskId);
  }

  const revertedShas = new Set();
  for (const commit of commits) {
    if (!REVERT_SUBJECT.test(commit.message)) continue;
    // %B (full body) was only used for trailer parsing before; re-derive
    // the "This reverts commit" line from the raw message stored on it.
    const match = commit.rawBody?.match(REVERTS_COMMIT);
    if (match) revertedShas.add(match[1]);
  }

  return graph.map((node) => {
    // Only commits that changed something outside .backstop/ count. A task's
    // declaration and its promotion record are never reverted (see
    // commitsForTasks), so counting them here meant a task whose actual work
    // was fully undone still read as active — and a later cascade would try
    // to revert it a second time and fail.
    const commitShas = commits
      .filter((c) => c.taskId === node.taskId && c.files.length > 0)
      .map((c) => c.sha);
    const allReverted =
      commitShas.length > 0 &&
      commitShas.every((sha) => [...revertedShas].some((r) => sha.startsWith(r) || r.startsWith(sha)));
    return { ...node, status: allReverted ? "reverted" : "active" };
  });
}

/**
 * Two different questions, deliberately kept apart.
 *
 * `promoted` — a promotion record exists for this task: it went through the
 * gate. That comes from Backstop's own ledger, which is a record it wrote
 * itself, not an agent's account of its own work.
 *
 * `onBase` — the task's commits are reachable from the base branch: the work
 * is *there*, however it arrived. Purely structural, derived from git.
 *
 * Collapsing these would hide the case worth seeing. Work that is on the base
 * branch with no promotion record reached production without passing the
 * breaker — which is exactly the failure branch-purity was written for
 * (TL14), and the honest answer for a repo where the gate is not yet mounted.
 * "What shipped" and "what was approved" are not the same list, and a tool
 * that cannot show the difference cannot show the problem.
 */
function applyPromotionState(repoDir, commits, graph) {
  const promoted = promotedTaskIds(repoDir);
  let base;
  try {
    base = loadPolicy(repoDir).baseBranch;
    git(["rev-parse", "--verify", base], repoDir);
  } catch {
    base = null; // no policy or no base branch yet — onBase is unknowable, not false
  }

  // One rev-list for every ancestor of base, instead of a `merge-base
  // --is-ancestor` per commit. Same answer, one process rather than one per
  // commit — the last of the per-commit spawns AUDIT-05 F10 counted, and the
  // same shape of fix the Vercel adapter already uses for liveTaskIds.
  let ancestors = null;
  if (base) {
    try {
      ancestors = new Set(
        git(["rev-list", base], repoDir).split("\n").filter(Boolean),
      );
    } catch {
      ancestors = null; // unreadable base — onBase stays unknowable, not false
    }
  }
  const reachable = (sha) => (ancestors === null ? null : ancestors.has(sha));

  return graph.map((node) => {
    const work = commits.filter((c) => c.taskId === node.taskId && c.files.length > 0);
    const states = work.map((c) => reachable(c.sha));
    const onBase = states.length > 0 && states.every((v) => v === true);
    return { ...node, promoted: promoted.has(node.taskId), onBase };
  });
}

export function buildGraph(repoDir, ref = "HEAD") {
  const commits = readHistory(repoDir, ref);
  const lineageIgnore = loadPolicy(repoDir).lineageIgnore ?? DEFAULT_LINEAGE_IGNORE;
  const graph = computeDependencyGraph(commits, { repoDir, lineageIgnore });
  return applyPromotionState(repoDir, commits, applyRevertStatus(commits, graph));
}
