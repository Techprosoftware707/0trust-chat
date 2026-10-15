/**
 * Runs every call test file in turn (each is a separate process with its own browsers) and
 * prints a summary. Options are passed through: --base, --server-ip, --no-netns, --only.
 *
 *   sudo node tests/calls/run.mjs [--base lumen.test] [--server-ip 10.200.0.1] [--no-netns]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const files = ["permissions", "calls", "security", "network"];
const results = [];
for (const f of files) {
  console.log(`\n===== ${f}.test.mjs =====`);
  const r = spawnSync(process.execPath, [path.join(HERE, `${f}.test.mjs`), ...process.argv.slice(2)], { stdio: "inherit" });
  results.push({ f, status: r.status });
}
console.log("\n===== summary =====");
for (const { f } of results) {
  const out = path.join(HERE, "../../docs/test-results", `calls-${f === "calls" ? "core" : f}.txt`);
  const last = fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim().split("\n").find((l) => /: \d+ passed, \d+ failed/.test(l)) : null;
  console.log(last ?? `${f}: no result file`);
}
process.exitCode = results.some((r) => r.status) ? 1 : 0;
