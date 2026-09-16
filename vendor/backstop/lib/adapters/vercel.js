// Vercel adapter: correlates Vercel deployments to ledger tasks via the
// commit SHA Vercel already attaches to every deployment — no custom
// instrumentation needed on Vercel's side, and no self-report from an
// agent about what it deployed.

import { execFileSync } from "node:child_process";

/** Normalize Vercel's raw /v6/deployments response into our internal shape. */
export function parseDeployments(rawDeployments) {
  return rawDeployments.map((d) => ({
    deploymentId: d.uid,
    environment: d.target === "production" ? "production" : "preview",
    commitSha: d.meta?.githubCommitSha ?? null,
    createdAt: d.createdAt ?? d.created ?? null,
    url: d.url ?? null,
    state: d.readyState ?? d.state ?? null,
    // `readySubstate: PROMOTED` is a historical marker: it means this
    // deployment was promoted at some point, NOT that it is serving traffic
    // now. Vercel returns it for every past production deployment — verified
    // against the real API, where 20 of 20 came back PROMOTED. Reading it as
    // "live" made `status --deployments` report twenty deployments live at
    // once, on the one question this product exists to answer.
    //
    // Liveness is a property of the project, not of a deployment row: exactly
    // one deployment is the project's production target. See markLive().
    everPromoted: d.readySubstate === "PROMOTED",
    live: false,
  }));
}

/**
 * Mark the one deployment the project actually points production at.
 * Takes the id from fetchProductionTarget rather than inferring it, because
 * every candidate signal in the deployment row itself — PROMOTED, READY,
 * newest createdAt — is either true of all of them or true by luck of
 * ordering. `null` marks nothing live, which is the honest answer when the
 * project read failed.
 */
export function markLive(deployments, liveDeploymentId) {
  return deployments.map((d) => ({
    ...d,
    live: liveDeploymentId != null && d.deploymentId === liveDeploymentId,
  }));
}

/**
 * Which tasks are live: a deployment ships a commit that contains every
 * commit before it, so every task whose commits are ancestors of the live
 * production commit is live — read from git's own ancestry, not from one
 * deployment <-> one task.
 *
 * Takes the live commit SHA directly rather than searching the deployment
 * list for a flagged row. Searching made the answer depend on the list: if
 * the live deployment were older than the page Vercel returned, the search
 * would find nothing and report an empty live set — "nothing is live" is a
 * different claim from "I could not see it", and only one of them is true.
 */
export function liveTaskIds(repoDir, commits, liveCommitSha) {
  if (!liveCommitSha) return [];
  let ancestors;
  try {
    ancestors = new Set(
      // A handled absence must not print. The catch below treats "that commit
      // is not in this clone" as a normal answer, so git's "fatal: bad object"
      // reaching the terminal would contradict it.
      execFileSync("git", ["rev-list", liveCommitSha], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
        .split("\n")
        .filter(Boolean),
    );
  } catch {
    return []; // the deployed commit isn't in this clone — say nothing rather than guess
  }
  const ids = new Set();
  for (const c of commits) {
    if (c.taskId && ancestors.has(c.sha)) ids.add(c.taskId);
  }
  return [...ids];
}

/**
 * Attach the ledger task id to each deployment by matching its commit SHA
 * against the ledger's own commit history — never against an agent's claim
 * about what it deployed. A deployment whose commit isn't in the ledger
 * (e.g. an untagged commit) gets taskId: null, not guessed.
 */
export function correlateDeployments(deployments, commits) {
  const shaToTask = new Map(commits.filter((c) => c.taskId).map((c) => [c.sha, c.taskId]));
  return deployments.map((d) => {
    const taskId = d.commitSha
      ? shaToTask.get(d.commitSha) ??
        [...shaToTask.entries()].find(([sha]) => sha.startsWith(d.commitSha) || d.commitSha.startsWith(sha))?.[1] ??
        null
      : null;
    return { ...d, taskId };
  });
}

/**
 * Wait for the deployment Vercel creates for a given commit to finish, so
 * "promoted" can mean "live" rather than "merged" (STAGE2.md item 2). Returns
 * the deployment once it reaches a terminal state, or null on timeout — the
 * caller records `promoted-not-live` rather than assuming success.
 */
export async function waitForDeployment({
  token, projectId, teamId, commitSha, timeoutMs = 180000, pollMs = 5000,
  // Seam, not a mock of the mechanism: the polling, the terminal-state set
  // and the timeout are the logic under test, and only the HTTP call is
  // swapped out. A deploy that never finishes is otherwise untestable except
  // by waiting three real minutes on a real stuck build.
  fetchFn = fetchDeployments,
}) {
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(["READY", "ERROR", "CANCELED"]);
  while (Date.now() < deadline) {
    const raw = await fetchFn({ token, projectId, teamId, limit: 20 });
    const match = parseDeployments(raw).find((d) => d.commitSha === commitSha);
    if (match && terminal.has(match.state)) return match;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return null;
}

/** Thin I/O: fetch this project's real deployments from Vercel's REST API. */
export async function fetchDeployments({ token, projectId, teamId, limit = 20 }) {
  const url = new URL("https://api.vercel.com/v6/deployments");
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("teamId", teamId);
  url.searchParams.set("limit", String(limit));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Vercel API error ${res.status}: ${await res.text()}`);
  }
  const body = await res.json();
  return body.deployments ?? [];
}

/**
 * The authoritative answer to "what is live": the project's own production
 * target. One read, one deployment, no inference from substates that every
 * past deployment shares.
 */
export async function fetchProductionTarget({ token, projectId, teamId }) {
  const url = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Vercel API error ${res.status}: ${await res.text()}`);
  }
  const production = (await res.json()).targets?.production;
  if (!production) return null;
  return {
    deploymentId: production.id ?? null,
    commitSha: production.meta?.githubCommitSha ?? null,
  };
}
