/**
 * State the panel reads but nothing writes.
 *
 * A control can be deleted without leaving a trace. Rewriting the résumé picker
 * took the "Also draft a cover letter" checkbox with it — the flag stayed in
 * `state`, the fill still checked it, and nothing on screen could ever set it.
 * Every test passed, because none of them render the panel.
 *
 * So this reads the source instead. Crude, and it catches exactly that: a
 * setting that can be read but never chosen is a feature that has quietly
 * stopped existing.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "content.js"), "utf8");

/** The keys declared on the state object. */
function declaredKeys() {
  const block = /const state = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(block, "the panel's state object should be findable");
  return [...block[1].matchAll(/^\s{2}([a-zA-Z_$][\w$]*):/gm)].map((m) => m[1]);
}

const body = source.replace(/const state = \{[\s\S]*?\n\};/, "");
const writes = new Set([...body.matchAll(/\bstate\.([\w$]+)\s*=(?!=)/g)].map((m) => m[1]));
// Shorthand counts. `Object.assign(state, { busy: false, report })` sets report
// just as surely as `report: report` would, and reading only the `name:` form
// reported a live setting as orphaned — a false alarm from the very guard
// meant to catch a real one.
const assigned = new Set(
  [...body.matchAll(/Object\.assign\(state,\s*\{([\s\S]*?)\}\)/g)].flatMap((m) =>
    m[1]
      .split(",")
      .map((piece) => /^\s*([\w$]+)/.exec(piece)?.[1])
      .filter(Boolean)
  )
);
const reads = new Set([...body.matchAll(/\bstate\.([\w$]+)\b/g)].map((m) => m[1]));

test("every setting the panel reads can also be set", () => {
  const orphans = declaredKeys().filter(
    (key) => reads.has(key) && !writes.has(key) && !assigned.has(key)
  );
  assert.deepEqual(
    orphans,
    [],
    `these are read but nothing writes them, so no control can change them: ${orphans.join(", ")}`
  );
});

test("the cover-letter option is on screen, not only in state", () => {
  // Named specifically, since this is the one that went missing and the one
  // that costs money when it is on.
  assert.match(source, /Also draft a cover letter/, "the checkbox's label");
  assert.match(
    source,
    /state\.wantCoverLetter\s*=\s*e\.target\.checked/,
    "and something that actually sets it"
  );
  assert.match(source, /Uses AI credit/, "with the cost said out loud before it is spent");
});

test("the résumé picker offers both sources", () => {
  // The other half of the same rewrite.
  assert.match(source, /local_resumes/, "the folder on disk");
  assert.match(source, /In HireCraft/, "and the ones uploaded here");
});
