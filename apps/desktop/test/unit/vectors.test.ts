/**
 * Shared test vectors (apps/shared/test-vectors): every case must pass in every app.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { routeDeepLink } from "../../src/core/deeplink.ts";
import { parseWellKnown } from "../../src/core/discovery.ts";
import { validateEndpointUrl } from "../../src/core/url.ts";

const VECTORS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../shared/test-vectors");

function load<T>(name: string): { description: string; cases: T[] } {
  return JSON.parse(readFileSync(path.join(VECTORS, name), "utf8"));
}

test("url-validation.json: validateEndpointUrl", () => {
  const v = load<{ input: string; debug: boolean; expect: string | null; why?: string }>("url-validation.json");
  assert.ok(v.cases.length >= 10);
  for (const c of v.cases) {
    assert.equal(validateEndpointUrl(c.input, { debug: c.debug }), c.expect, `${JSON.stringify(c.input)} debug=${c.debug} ${c.why ?? ""}`);
  }
});

test("wellknown.json: parseWellKnown", () => {
  const v = load<{ name: string; input: unknown; expect: unknown }>("wellknown.json");
  assert.ok(v.cases.length >= 5);
  for (const c of v.cases) {
    const got = parseWellKnown(c.input) as Record<string, unknown>;
    const want = c.expect as Record<string, unknown>;
    // Fields the app parses beyond the vector's contract (e.g. the newer optional
    // account_delete_url) must be null when the input doesn't have them; the rest must match exactly.
    if (got.lumen && want.lumen) {
      const lumen = { ...(got.lumen as Record<string, unknown>) };
      for (const k of Object.keys(lumen)) {
        if (!(k in (want.lumen as object))) {
          assert.equal(lumen[k], null, `${c.name}: extra field ${k}`);
          delete lumen[k];
        }
      }
      assert.deepEqual({ ...got, lumen }, want, c.name);
    } else assert.deepEqual(got, want, c.name);
  }
});

test("deeplinks.json: routeDeepLink", () => {
  const v = load<{ url: string; pending: string | null; expect: unknown; why?: string }>("deeplinks.json");
  assert.ok(v.cases.length >= 10);
  for (const c of v.cases) assert.deepEqual(routeDeepLink(c.url, c.pending), c.expect, `${c.url} pending=${c.pending} ${c.why ?? ""}`);
});
