// Given a target task, find every task that depends on it — directly or
// transitively — using only the structural graph from ledger.js. This is
// the "and whatever provably depended on it" half of dependency-aware
// selective rollback.

export function transitiveDependents(graph, targetTaskId) {
  const dependents = new Map(); // taskId -> set of taskIds it directly depends on
  for (const node of graph) {
    dependents.set(node.taskId, new Set(node.dependsOn));
  }

  const affected = new Set([targetTaskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [taskId, dependsOn] of dependents) {
      if (affected.has(taskId)) continue;
      for (const dep of dependsOn) {
        if (affected.has(dep)) {
          affected.add(taskId);
          changed = true;
          break;
        }
      }
    }
  }

  return Array.from(affected);
}

/**
 * Every commit belonging to the given task ids, in real repo-chronological
 * order (oldest first) — takes the full ordered commit history, not just
 * the per-task graph, because revert order must follow actual commit
 * sequence across the whole repo, not per-task grouping.
 */
export function commitsForTasks(orderedCommits, taskIds) {
  const wanted = new Set(taskIds);
  return orderedCommits
    .filter((c) => c.taskId && wanted.has(c.taskId))
    // Skip commits that touched nothing outside .backstop/ — readHistory has
    // already filtered those files out, so such a commit carries no product
    // change at all. Two reasons, and the second is the sharp one:
    //
    // The ledger is append-only. "Promoted, then reverted" is the truth; a
    // revert that rewinds the promotion record would falsify history rather
    // than record it. The record of a promotion outlives the promotion.
    //
    // And reverting one is destructive in practice: `revert` on a promoted
    // task tried to undo its own "Ledger: X promoted" commit, conflicted with
    // every later append to the same file, and wrote conflict markers into
    // ledger.jsonl — leaving the durable record unparseable and the repo with
    // unmerged files. The undo corrupted the recorder.
    .filter((c) => c.files.length > 0)
    .map((c) => ({ sha: c.sha, taskId: c.taskId, message: c.message }));
}
