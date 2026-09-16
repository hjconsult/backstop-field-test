// A task declares its authorized scope as file globs at creation time —
// mandatory, not optional prose. This module diffs the actual changed
// files against that declaration and routes anything out-of-scope to
// independent review. It does not itself decide right or wrong about an
// out-of-scope change — see docs/plan/STAGE1.md.

/**
 * Git reports paths without a leading `./`, but people (and shell tab
 * completion) write them with one. An unnormalised `./src/**` matches nothing,
 * and a glob that matches nothing is not a loud failure here — it degrades to
 * "every file is out of scope", so the operator believes they declared a scope
 * while having effectively declared none.
 */
function normalizeGlob(glob) {
  return glob.replace(/^\.\//, "");
}

/** Convert one glob pattern to a RegExp. Supports `**`, `*`, and literals. */
function globToRegExp(pattern) {
  const glob = normalizeGlob(pattern);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      // swallow an immediately-following slash so `a/**/b` matches `a/b`
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAnyGlob(globs, filePath) {
  return globs.some((g) => globToRegExp(g).test(filePath));
}

// Constitutional-tier paths (DECISIONS.md D15): changing the policy file
// would downgrade every gate at once, so it is out of scope for every task
// no matter what that task declared, and always routes to review.
export const CONSTITUTIONAL_PATHS = [".backstop/policy.json"];

export function isConstitutional(filePath) {
  return CONSTITUTIONAL_PATHS.includes(filePath);
}

/**
 * Diff a task's declared scope globs against its actual changed files.
 * A task with no declared scope at all is never silently treated as
 * "everything in scope" — every changed file counts as out-of-scope,
 * because an undeclared scope carries no authorization to check against.
 */
export function checkScope(declaredGlobs, changedFiles) {
  const constitutional = changedFiles.filter(isConstitutional);
  const rest = changedFiles.filter((f) => !isConstitutional(f));

  if (!declaredGlobs || declaredGlobs.length === 0) {
    return { inScope: [], outOfScope: [...changedFiles], constitutional };
  }
  const inScope = [];
  const outOfScope = [...constitutional];
  for (const file of rest) {
    (matchesAnyGlob(declaredGlobs, file) ? inScope : outOfScope).push(file);
  }

  // A declared glob that matched none of the changed files is either harmless
  // (that part of the scope simply wasn't touched) or a typo that quietly
  // authorised nothing. The gate cannot tell which, but the operator can — so
  // report it rather than leaving a misdeclaration to look like a scope
  // violation by the work.
  const unmatchedGlobs = declaredGlobs.filter((g) => !rest.some((f) => matchesAnyGlob([g], f)));

  return { inScope, outOfScope, constitutional, unmatchedGlobs };
}

/**
 * Route out-of-scope files to independent review. Never auto-approves,
 * never auto-rejects — routing only. The reviewer must not be the same
 * agent that authored the change (enforced by the caller, per CLAUDE.md's
 * constitutional rules on independent review).
 */
export function routeScopeViolation(outOfScope) {
  if (outOfScope.length === 0) {
    return { needsIndependentReview: false, files: [] };
  }
  return { needsIndependentReview: true, files: [...outOfScope] };
}
