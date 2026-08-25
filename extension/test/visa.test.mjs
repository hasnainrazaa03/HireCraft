/**
 * The extension's visa classifier must agree with the backend's.
 *
 * It is a port of backend/app/services/sponsorship.py, kept because the
 * extension runs on postings that are not in the feed and so have no row to
 * look up. A port that silently drifts is worse than no port — the reader would
 * get one answer in the app and a different one on the page — so both are
 * driven from the same corpus — backend/tests/visa_cases.json — which the
 * backend's own suite reads too.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const window = {};
new Function("window", "document", readFileSync(join(here, "..", "autofill", "visa.js"), "utf8"))(
  window,
  { querySelector: () => null, body: { innerText: "" } }
);
const { classifyVisa, visaLabel, VISA } = window.HIRECRAFT_VISA;
// The canonical corpus lives with the backend test that owns the behaviour;
// reading it from here is what keeps the two implementations honest.
const CASES = JSON.parse(
  readFileSync(join(here, "..", "..", "backend", "tests", "visa_cases.json"), "utf8")
);

test("agrees with the backend on every shared case", () => {
  const wrong = [];
  for (const [text, expected] of CASES) {
    const got = classifyVisa(text).verdict;
    if (got !== expected) wrong.push(`${expected} → ${got}: ${text.slice(0, 70)}`);
  }
  assert.deepEqual(wrong, [], `\n  ${wrong.join("\n  ")}`);
});

test("the evidence names the sentence that decided it", () => {
  const { evidence } = classifyVisa("Great mission. We are unable to provide visa sponsorship for this role.");
  assert.ok(evidence.toLowerCase().includes("sponsorship"));
  assert.equal(classifyVisa("").evidence, "");
});

test("only a real verdict blocks", () => {
  assert.equal(visaLabel(VISA.UNSTATED).blocks, false);
  assert.equal(visaLabel(VISA.SPONSORS).blocks, false);
  for (const v of [VISA.NONE, VISA.CITIZENSHIP, VISA.CLEARANCE]) {
    assert.equal(visaLabel(v).blocks, true);
  }
});
