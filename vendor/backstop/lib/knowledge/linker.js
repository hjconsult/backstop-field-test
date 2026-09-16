// The knowledge layer's mechanical half (DECISIONS.md D21, D27): `relates-to`
// edges in the same graph as `depends-on`, one store and two edge kinds, not
// two systems.
//
// The agreed order is: structural links first, embedding-threshold links
// second, a system-triggered linker pass third, one required structured field
// for the residual fourth, and an orphan rate as the backstop. This module is
// layers one, three and four. Layer two — embedding similarity for things that
// share no code at all — is deliberately absent: it needs a model choice
// nobody has made, and the design session established it is backfillable at
// zero cost because the recorder already keeps the raw artifacts.
//
// The difference that matters: `depends-on` carries the safety guarantee and
// must never be wrong. `relates-to` is a retrieval aid whose failure mode is
// "you didn't find a related note", so it is allowed to be best-effort — which
// is exactly why the orphan rate exists, to keep best-effort from silently
// becoming nothing.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { isSourceFile, importedPaths } from "../imports.js";

function fileAtCommit(repoDir, sha, filePath) {
  try {
    // A deleted file at that commit is an expected miss, handled below — so
    // git's "fatal: path does not exist" must not reach the operator.
    return execFileSync("git", ["show", `${sha}:${filePath}`], {
      cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

/** What each task touched, imported, and which directories it worked in. */
export function taskFootprints(repoDir, commits) {
  const footprints = new Map();
  for (const commit of commits) {
    if (!commit.taskId) continue;
    if (!footprints.has(commit.taskId)) {
      footprints.set(commit.taskId, { taskId: commit.taskId, files: new Set(), imports: new Set(), dirs: new Set() });
    }
    const fp = footprints.get(commit.taskId);
    for (const file of commit.files) {
      fp.files.add(file);
      const dir = path.posix.dirname(file);
      if (dir && dir !== ".") fp.dirs.add(dir);
      if (!isSourceFile(file)) continue;
      const source = fileAtCommit(repoDir, commit.sha, file);
      if (source === null) continue;
      for (const target of importedPaths(file, source)) fp.imports.add(canonicalImport(target));
    }
  }
  return [...footprints.values()];
}

function pairKey(a, b) {
  // Escaped rather than a literal NUL byte. The byte worked at runtime and
  // made the file binary to every text tool: grep skips it silently, which
  // it did during an audit of this very repo. Same string, same behaviour,
  // and the separator stays one a task id can never contain.
  return [a, b].sort().join("\0");
}

// importedPaths returns every extension candidate for one specifier, which is
// right for resolution and wrong for relating: it would report the same shared
// import eight times. Collapse to the extension-less form so two tasks match
// on the module, not on which candidate spelling happened to be tried.
const SOURCE_EXT = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/;
function canonicalImport(p) {
  return p.replace(SOURCE_EXT, "").replace(/\/index$/, "");
}

/**
 * Relates-to edges from mechanical signals only: two tasks that import the
 * same module, or work in the same directory, are related. Undirected, so
 * each pair is emitted once with the reasons that produced it.
 */
/**
 * Two tasks already joined by a depends-on edge are not *also* related: that
 * relationship is already recorded, with a stronger guarantee behind it.
 * The shared-import branch checked this itself, but the shared-directory
 * branch did not — so a task and the module it imports came back related
 * whenever they happened to sit in the same folder, inflating the relation
 * count and flattening the orphan rate against reality. The invariant belongs
 * in one place, applied to every structural signal.
 */
function alreadyDependent(graph) {
  const pairs = new Set();
  for (const node of graph ?? []) {
    for (const dep of node.dependsOn) pairs.add(pairKey(node.taskId, dep));
  }
  return pairs;
}

export function structuralRelations(repoDir, commits, graph = null) {
  const footprints = taskFootprints(repoDir, commits);
  const pairs = new Map();

  const note = (a, b, why) => {
    if (a === b) return;
    const key = pairKey(a, b);
    if (!pairs.has(key)) pairs.set(key, { from: [a, b].sort()[0], to: [a, b].sort()[1], kind: "relates-to", why: new Set() });
    pairs.get(key).why.add(why);
  };

  for (let i = 0; i < footprints.length; i++) {
    for (let j = i + 1; j < footprints.length; j++) {
      const a = footprints[i];
      const b = footprints[j];
      for (const imp of a.imports) {
        // A shared import only relates them if neither one *is* the imported
        // file's owner — that relationship is already a depends-on edge, and
        // duplicating it as relates-to would make the orphan rate flatter than
        // reality.
        const owns = (fp) => [...fp.files].some((f) => canonicalImport(f) === imp);
        if (b.imports.has(imp) && !owns(a) && !owns(b)) note(a.taskId, b.taskId, `shared-import:${imp}`);
      }
      for (const dir of a.dirs) {
        // A shared *top-level* directory says nothing: in a repo where
        // everything lives under src/, "both worked in src" relates every pair
        // of tasks to every other, the orphan rate falls to zero, and the
        // signal the metric exists to protect is gone. Require a real
        // subdirectory — src/billing is a claim about the work, src is not.
        if (!dir.includes("/")) continue;
        if (b.dirs.has(dir)) note(a.taskId, b.taskId, `shared-directory:${dir}`);
      }
    }
  }

  const dependent = alreadyDependent(graph);
  return [...pairs.values()]
    .filter((p) => !dependent.has(pairKey(p.from, p.to)))
    .map((p) => ({ ...p, why: [...p.why].sort() }));
}

/**
 * Declared relations — the residual that no structural signal can reach ("we
 * mapped field X to Y because of a contract clause"). Captured as a field at
 * task declaration, not volunteered later, because recalling-after-the-fact is
 * the unreliable act.
 */
export function declaredRelations(declarations) {
  const out = [];
  for (const declaration of declarations) {
    for (const other of declaration?.relatesTo ?? []) {
      out.push({ from: declaration.taskId, to: other, kind: "relates-to", why: ["declared"] });
    }
  }
  return out;
}

/**
 * The backstop metric: what share of tasks have no edge of any kind. This is
 * what converts "we might be silently missing links" from an invisible failure
 * into a number that can be watched and alerted on.
 */
export function orphanRate(graph, relations) {
  const taskIds = graph.map((n) => n.taskId);
  if (taskIds.length === 0) return { rate: 0, orphans: [], total: 0 };

  const connected = new Set();
  for (const node of graph) {
    if (node.dependsOn.length > 0) {
      connected.add(node.taskId);
      for (const dep of node.dependsOn) connected.add(dep);
    }
  }
  for (const rel of relations) {
    connected.add(rel.from);
    connected.add(rel.to);
  }

  const orphans = taskIds.filter((id) => !connected.has(id));
  return { rate: orphans.length / taskIds.length, orphans, total: taskIds.length };
}

/**
 * The linker pass. Triggered by the system at promotion — never by whether the
 * agent building a feature remembered to maintain the graph as a side task.
 */
export function runLinkerPass(repoDir, commits, graph, declarations = []) {
  const relations = [...structuralRelations(repoDir, commits, graph), ...declaredRelations(declarations)];
  return { relations, orphans: orphanRate(graph, relations) };
}
