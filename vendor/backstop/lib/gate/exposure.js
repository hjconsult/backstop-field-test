// Exposure-aware gate severity: the same finding (a destructive migration,
// an out-of-scope change) means something very different against a
// pre-launch environment than against one serving real users. This module
// is what stops us from gating a project with no users yet as if it were
// already in production — see docs/plan/STAGE1.md.

/**
 * @param {{live: boolean, realUsers?: boolean}} exposure
 * @param {{type: string}} finding
 * @returns {{action: "proceed-logged" | "blocked-pending-review", reason: string}}
 */
export function dialSeverity(exposure, finding) {
  // `realUsers` was documented here, carried in every environment's policy,
  // and never read: severity dialled on `live` alone. A configuration field
  // that changes nothing is worse than an absent one — the operator sets it,
  // believes it means something, and it silently does not. The existing test
  // only ever passed combinations where live and realUsers agreed, which is
  // why it survived.
  //
  // It participates now in the one direction that cannot be wrong: it can
  // make the gate stricter, never looser. `{live: false, realUsers: true}` is
  // a contradictory configuration, and the safe reading of a contradiction is
  // the strict one — naming real users must never buy a free pass.
  const atStake = Boolean(exposure.live) || Boolean(exposure.realUsers);

  if (!atStake) {
    return {
      action: "proceed-logged",
      reason: `${finding.type} flagged, but environment is not live — proceeding, logged for the record.`,
    };
  }
  const why = !exposure.live
    // The contradictory case gets its own wording rather than being described
    // as live, which it is not. Saying it plainly is how the operator learns
    // their policy says two different things.
    ? "an environment marked as serving real users but not marked live — " +
      "treating the stricter half as the truth"
    : exposure.realUsers
      ? "a live environment serving real users"
      : "a live environment";
  return {
    action: "blocked-pending-review",
    reason: `${finding.type} against ${why} — blocked pending the full review checklist.`,
  };
}
