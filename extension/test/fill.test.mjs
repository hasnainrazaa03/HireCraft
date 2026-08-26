/**
 * Actually run the fill engine.
 *
 * The other suites exercise the patterns; this one executes the code path a
 * click takes. That distinction cost a real bug: a helper was deleted by an
 * edit to the comment block above it, `node --check` passed because the syntax
 * was still valid, every pattern test passed because none of them ran the
 * loop — and the extension threw "pause is not defined" on the first field it
 * tried to fill, on a real application form.
 *
 * The DOM here is a stub rather than jsdom, to keep the suite dependency-free.
 * It implements only what the engine touches, which is itself a useful
 * constraint: anything the engine starts relying on has to be added here
 * deliberately.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", ...p), "utf8");

/** A form control, with just enough surface for the engine. */
function makeControl({ label, type = "text", tag = "input", options = null }) {
  const events = [];
  const el = {
    tagName: tag.toUpperCase(),
    id: "",
    value: "",
    disabled: false,
    readOnly: false,
    options,
    events,
    getAttribute: (name) =>
      name === "type" ? type : name === "aria-label" ? label : null,
    getBoundingClientRect: () => ({ width: 200, height: 32 }),
    closest: () => null,
    dispatchEvent: (e) => events.push(e.type),
  };
  return el;
}

function install(controls) {
  const window = {};
  const document = {
    querySelectorAll: (sel) =>
      sel.includes("file") ? [] : controls,
    querySelector: () => null,
    getElementById: () => null,
  };

  // The engine narrows on these to pick a value setter, and reads `.options`
  // for a select. Plain objects are enough as long as instanceof is false.
  const globals = {
    window,
    document,
    CSS: { escape: (s) => s },
    Event: class { constructor(type) { this.type = type; } },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  const names = Object.keys(globals);
  const values = Object.values(globals);

  for (const file of ["autofill/fields.js", "autofill/fill.js"]) {
    new Function(...names, read(file))(...values);
  }
  return window;
}

const PROFILE = {
  legal_first_name: "Mohammad Hasnain",
  legal_last_name: "Raza",
  preferred_name: "Hasnain",
  email: "razam@usc.edu",
  phone: "(213) 994-5086",
  location: "Los Angeles, CA",
  country: "United States",
  linkedin: "https://linkedin.com/in/hasnainraza03",
  authorized_to_work: true,
  requires_sponsorship: true,
  education: { school: "USC", degree: "M.S.", gpa: "3.67", start_year: "2025", end_year: "2027" },
};

test("a fill with progress reporting completes without throwing", async () => {
  // The exact shape that failed on Verkada: stepDelay non-zero and onProgress
  // set, so the loop reaches the await that referenced the missing helper.
  const controls = [
    makeControl({ label: "First Name" }),
    makeControl({ label: "Last Name" }),
    makeControl({ label: "Email", type: "email" }),
  ];
  const window = install(controls);

  const seen = [];
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, {
    onProgress: ({ label }) => seen.push(label),
    stepDelay: 1,
  });

  assert.deepEqual(
    report.filled.map((f) => f.label),
    ["First name", "Last name", "Email"]
  );
  assert.deepEqual(seen, ["First name", "Last name", "Email"]);
  assert.equal(report.missing.length, 0);
});

test("values are set and announced to the page", async () => {
  const first = makeControl({ label: "First Name" });
  const window = install([first]);
  await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.equal(first.value, "Mohammad Hasnain");
  // React listens for `input`; `change` covers plain listeners and validation.
  assert.deepEqual(first.events, ["input", "change"]);
});

test("a field already carrying a value is left alone", async () => {
  const typed = makeControl({ label: "Email", type: "email" });
  typed.value = "someone.else@example.com";
  const window = install([typed]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.equal(typed.value, "someone.else@example.com");
  assert.equal(report.filled.length, 0);
});

test("a skipped question reports why it was skipped", async () => {
  const window = install([
    makeControl({ label: "Gender" }),
    makeControl({ label: "Are you willing to relocate?" }),
  ]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.equal(report.filled.length, 0);
  assert.equal(report.skipped.length, 2);
  const reasons = report.skipped.map((s) => s.why);
  assert.ok(reasons.every(Boolean), "every skip must carry a reason");
  assert.notEqual(reasons[0], reasons[1], "different skips mean different things");
});

test("nothing stored is reported rather than left silent", async () => {
  const window = install([makeControl({ label: "GitHub" })]);
  const report = await window.HIRECRAFT_FILL.fillForm({}, { stepDelay: 0 });

  assert.equal(report.filled.length, 0);
  assert.equal(report.missing[0].label, "GitHub");
});

test("inspectForm reports every control with its resolved label", () => {
  const window = install([
    makeControl({ label: "First Name" }),
    makeControl({ label: "Location (City)" }),
  ]);
  const rows = window.HIRECRAFT_FILL.inspectForm();
  assert.deepEqual(rows.map((r) => r.normalised), ["first name", "location city"]);
});
