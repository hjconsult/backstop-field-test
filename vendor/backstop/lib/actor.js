// Who acted, and how well we know it.
//
// AUDIT-05 Q3: the constitution is written entirely in terms of not trusting
// "the agent", and the system had no representation of who was acting. Every
// self-report finding across three audits reduces to that — you cannot stop
// trusting the agent until you can tell the agent from the gate.
//
// The constitutional trap is that an actor the agent supplies is self-report,
// which is exactly what TL44 removed from the environment tier and the declared
// scope. So the same rule: derived where possible, and where it cannot be
// derived, labelled so a later reader cannot mistake it for a fact.
//
// See docs/design/ACTOR.md for the full ladder. This implements tier 1 (git
// identity) and labels tier 0 (declared). Tiers 2 and 3 — per-agent signatures
// and a gate principal with its own key — are designed there and not built:
// they need key management and the gate-principal decision, and belong with F9
// since both change what a record is.

import { execFileSync } from "node:child_process";

const git = (repoDir, args) =>
  execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * @returns {{id: string|null, source: "signature"|"git-identity"|"declared"|"unknown", verified: boolean}}
 *
 * `verified` is true only when the identity was cryptographically attested.
 * It is deliberately a separate field from `source` rather than something a
 * reader has to infer, because "we know who did this" and "someone told us who
 * did this" are different facts and the whole point of the record is that they
 * never blur.
 */
export function resolveActor(repoDir, { declared = null, commitSha = null } = {}) {
  // Tier 2 — a signed commit attests the actor. Checked first because it is
  // the only tier where the answer is a fact rather than a configuration.
  if (commitSha) {
    try {
      const signer = git(repoDir, ["show", "--no-patch", "--format=%GS", commitSha]);
      const status = git(repoDir, ["show", "--no-patch", "--format=%G?", commitSha]);
      // G = good signature, U = good but untrusted key. Both attest WHO;
      // trust in the key is a separate question from identity.
      if (signer && (status === "G" || status === "U")) {
        return { id: signer, source: "signature", verified: true };
      }
    } catch { /* not signed, or git too old to know — fall through */ }
  }

  // Tier 1 — git identity. A real artifact on the commit object, and in a
  // fleet it is set when the container is provisioned rather than by the agent
  // during a gate run. An agent CAN change it, so it is not verified.
  try {
    const email = commitSha
      ? git(repoDir, ["show", "--no-patch", "--format=%ae", commitSha])
      : git(repoDir, ["config", "user.email"]);
    if (email) return { id: email, source: "git-identity", verified: false };
  } catch { /* no identity configured */ }

  // Tier 0 — whatever we were told. Recorded, never evidence.
  if (declared) return { id: declared, source: "declared", verified: false };

  return { id: null, source: "unknown", verified: false };
}

/** How an actor should read in output, so provenance travels with the name. */
export function describeActor(actor) {
  if (!actor?.id) return "unknown";
  if (actor.verified) return `${actor.id} (signed)`;
  return `${actor.id} (${actor.source}, unverified)`;
}
