// The two built-in plugins. Deliberately one of each shape, because those are
// the two shapes the registry has to support: a mechanical check over changed
// file contents, and a meter reading a number reported about the change.

import { registerCheck, registerMeter } from "./registry.js";

// A mechanical content check — no agent judgement, no LLM, just a scan.
registerCheck("no-console-log", (context, settings) => {
  const extensions = settings.extensions ?? [".js", ".mjs", ".jsx", ".ts", ".tsx"];
  const offenders = [];
  for (const file of context.files) {
    if (!extensions.some((ext) => file.endsWith(ext))) continue;
    const source = context.readFile(file);
    if (source == null) continue;
    source.split("\n").forEach((line, i) => {
      if (/\bconsole\.log\s*\(/.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  }
  return offenders.length === 0
    ? { ok: true, detail: "no console.log in changed files" }
    : { ok: false, detail: `console.log at ${offenders.slice(0, 5).join(", ")}${offenders.length > 5 ? ` (+${offenders.length - 5} more)` : ""}` };
});

// A meter: the number comes from outside (reported at promote time), the
// limit comes from policy, and the registry compares them. The meter itself
// holds no opinion about how much is too much.
registerMeter("spend", {
  unit: "usd",
  measure: (context) => context.spent ?? null,
});

registerMeter("changed-files", {
  unit: "files",
  measure: (context) => context.files.length,
});
