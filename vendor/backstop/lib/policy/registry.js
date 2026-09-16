// Pluggable policy (STAGE2.md item 3). The gate's checklist is fixed — those
// are the constitutional steps — but *what* the scope, budget and quality
// steps actually measure is per-project policy, registered by name and turned
// on in .backstop/policy.json. This is the same shape as the stack adapters:
// a small core, thin named plugins, nothing special-cased into the gate.
//
// Two kinds:
//   check — a pass/fail judgement about a change      → { ok, detail }
//   meter — a number measured about a change          → { value, unit }
// A meter's limit lives in policy, never in the meter: "10k of tokens is
// fine, $100 is not" is the project owner's call, not the tool's.

const checks = new Map();
const meters = new Map();

export function registerCheck(name, run) {
  checks.set(name, { name, run });
}

export function registerMeter(name, { unit, measure }) {
  meters.set(name, { name, unit, measure });
}

export function getCheck(name) {
  return checks.get(name) ?? null;
}

export function getMeter(name) {
  return meters.get(name) ?? null;
}

export function registeredNames() {
  return { checks: [...checks.keys()], meters: [...meters.keys()] };
}

/**
 * Run every check the project enabled. An unknown or throwing check FAILS —
 * it never silently passes, because "the check could not run" is the state
 * this whole project exists to stop being treated as "the check passed".
 */
export function runEnabledChecks(config = {}, context) {
  const results = [];
  for (const [name, settings] of Object.entries(config)) {
    if (settings?.enabled === false) continue;
    const check = getCheck(name);
    if (!check) {
      results.push({ name, ok: false, detail: `unknown check "${name}" — enabled in policy but not registered` });
      continue;
    }
    try {
      const { ok, detail } = check.run(context, settings ?? {});
      results.push({ name, ok, detail });
    } catch (err) {
      results.push({ name, ok: false, detail: `check threw: ${err.message}` });
    }
  }
  return results;
}

/**
 * Measure every configured meter against its limit. A meter with no reading
 * for this change passes (nothing was spent); a meter that throws fails.
 */
export function runMeters(config = {}, context) {
  const results = [];
  for (const [name, settings] of Object.entries(config)) {
    const meter = getMeter(name);
    if (!meter) {
      results.push({ name, ok: false, detail: `unknown meter "${name}" — configured in policy but not registered` });
      continue;
    }
    try {
      const value = meter.measure(context, settings ?? {});
      const limit = settings?.limit;
      const hasLimit = settings != null && "limit" in settings;
      // A limit that is present but not a usable number is a misconfiguration,
      // and it blocks. Without this it "worked" by accident: `limit: "abc"`
      // failed only because every NaN comparison is false, and `limit: null`
      // read as no-limit-at-all — a typo in policy.json quietly disabling an
      // enforced ceiling is precisely the failure this project exists to stop.
      // A limit left out entirely still means measure-but-do-not-enforce.
      if (hasLimit && !Number.isFinite(limit)) {
        results.push({
          name,
          ok: false,
          detail: `meter "${name}" has limit ${JSON.stringify(limit)}, which is not a number — fix policy.json`,
        });
        continue;
      }
      if (value == null) {
        results.push({ name, ok: true, detail: `no ${name} reading for this change` });
      } else if (!hasLimit) {
        results.push({ name, ok: true, detail: `${value} ${meter.unit} measured, no limit configured` });
      } else {
        results.push({
          name,
          ok: value <= limit,
          detail: `${value} ${meter.unit} against limit ${limit}`,
        });
      }
    } catch (err) {
      results.push({ name, ok: false, detail: `meter threw: ${err.message}` });
    }
  }
  return results;
}
