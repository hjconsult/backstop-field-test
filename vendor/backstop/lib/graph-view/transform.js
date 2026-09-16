// Pure transform: backstop status --json's shape -> {nodes, edges} for
// rendering. No new data model — this reshapes exactly what the ledger
// and the Vercel adapter already computed.

/**
 * @param {{tasks: Array, deployments: Array}} status
 */
export function graphFromStatus(status) {
  const nodes = [];
  const edges = [];

  for (const task of status.tasks ?? []) {
    // promoted and onBase are carried through deliberately, and undefined is
    // NOT collapsed to false: a status file written before these existed
    // cannot distinguish "did not pass the gate" from "we do not know", and
    // rendering the second as the first would accuse work that is fine.
    nodes.push({
      id: task.taskId,
      kind: "task",
      status: task.status ?? "active",
      promoted: task.promoted,
      onBase: task.onBase,
    });
    for (const dep of task.dependsOn ?? []) {
      edges.push({ from: dep, to: task.taskId, kind: "dep" });
    }
  }

  // relates-to lives in the same graph as depends-on, as a second edge kind
  // (D27) — one store, two relationships.
  for (const relation of status.relations ?? []) {
    edges.push({ from: relation.from, to: relation.to, kind: "relates-to" });
  }

  for (const dep of status.deployments ?? []) {
    nodes.push({
      id: dep.deploymentId,
      kind: "deployment",
      environment: dep.environment,
    });
    if (dep.taskId) {
      edges.push({ from: dep.taskId, to: dep.deploymentId, kind: "deploy" });
    }
  }

  return { nodes, edges };
}
