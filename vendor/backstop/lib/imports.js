// Static import extraction. This is the second structural source of
// dependency edges (DECISIONS.md D14): file overlap catches "B changed A's
// file", imports catch "B's file needs A's file" — the commoner and, for
// undo, the more dangerous relationship, because nothing in the diff reveals
// it. Still mechanical: the code is parsed, the agent is not asked.

import path from "node:path";

const SOURCE_EXTENSIONS = [".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts"];

// `import x from "y"` / `import "y"` / `export * from "y"` / `require("y")` /
// `import("y")`. Deliberately regex-based rather than a full parse: it needs
// to run over every changed file of every commit, and a parser dependency
// costs the tool its zero-dependency footprint. Run against comment-stripped
// source (see stripComments) — the remaining over-broad match costs a
// spurious edge, which errs toward over-reverting.
const SPECIFIER_PATTERNS = [
  /\bimport\s+(?:[\w*{}\n\r\t， ,$]+\s+from\s+)?["']([^"']+)["']/g,
  /\bexport\s+(?:[\w*{}\n\r\t, $]+\s+)?from\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

export function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.includes(path.extname(filePath));
}

/**
 * Remove comments before looking for imports. A left-behind
 * `// import './old-thing.js'` would otherwise make one task depend on
 * another forever, and a cascade revert would take unrelated work down with
 * it — over-reverting is the safe direction, but precision is the whole
 * product, so the cheap deterministic win is worth taking.
 *
 * Quote state is tracked so a `//` inside a string (`"https://…"`) is not
 * mistaken for a comment. What this deliberately does NOT do is strip string
 * literals: import specifiers live inside strings, so an import written
 * inside some *other* string is still a false positive. That residual is
 * rarer, needs a real parser to fix, and errs toward over-reverting.
 */
export function stripComments(source) {
  let out = "";
  let inLine = false;
  let inBlock = false;
  let quote = null;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      } else if (c === "\n") {
        out += c; // keep line numbers honest for anything downstream
      }
      continue;
    }
    if (quote) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Raw specifiers, relative ones only — packages and builtins carry no lineage. */
export function parseSpecifiers(source) {
  const found = new Set();
  const code = stripComments(source);
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith(".")) found.add(specifier);
    }
  }
  return [...found];
}

/**
 * Resolve a relative specifier against the importing file, to a path that
 * could plausibly exist in the repo. Returns every candidate rather than
 * guessing one, because the ledger knows which paths are real and this
 * module does not.
 */
export function resolveCandidates(fromFile, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (base.startsWith("..")) return []; // outside the repo — not our lineage
  const candidates = [base];
  if (!path.extname(base)) {
    for (const ext of SOURCE_EXTENSIONS) candidates.push(`${base}${ext}`);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(path.posix.join(base, `index${ext}`));
  } else if (SOURCE_EXTENSIONS.includes(path.extname(base))) {
    // TypeScript sources are imported with a .js specifier; try the siblings.
    const stem = base.slice(0, -path.extname(base).length);
    for (const ext of SOURCE_EXTENSIONS) candidates.push(`${stem}${ext}`);
  }
  return [...new Set(candidates)];
}

/** Every repo path `fromFile` might be importing, given its source text. */
export function importedPaths(fromFile, source) {
  const out = new Set();
  for (const specifier of parseSpecifiers(source)) {
    for (const candidate of resolveCandidates(fromFile, specifier)) out.add(candidate);
  }
  return [...out];
}
