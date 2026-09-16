// Generates a self-contained graph-view HTML file with the status data
// embedded. Embedding (rather than fetching) is deliberate: the result
// opens anywhere with no server and no CORS fight, and the data it shows
// is exactly the JSON it was generated from — verifiable by parsing it
// straight back out.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "template.html");
const PLACEHOLDER = /\/\*__BACKSTOP_STATUS_JSON__\*\/[\s\S]*?\/\*__END__\*\//;

export function renderGraphHtml(status) {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  // `</script` inside a JSON string would end the script block early;
  // escape the slash so embedded data can never break out of it.
  const json = JSON.stringify(status).replace(/<\//g, "<\\/");
  return template.replace(PLACEHOLDER, `/*__BACKSTOP_STATUS_JSON__*/${json}/*__END__*/`);
}

/** Read the embedded status back out of a generated file — used to verify the round trip. */
export function extractEmbeddedStatus(html) {
  const match = html.match(PLACEHOLDER);
  if (!match) return null;
  const inner = match[0]
    .replace(/^\/\*__BACKSTOP_STATUS_JSON__\*\//, "")
    .replace(/\/\*__END__\*\/$/, "")
    .replace(/<\\\//g, "</");
  return JSON.parse(inner);
}
