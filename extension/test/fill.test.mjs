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
    labelText: label,
    id: "",
    value: "",
    disabled: false,
    readOnly: false,
    options,
    events,
    getAttribute: (name) =>
      name === "type" ? type : name === "aria-label" ? label : null,
    hasAttribute(name) { return this.getAttribute(name) != null; },
    getBoundingClientRect: () => ({ width: 200, height: 32 }),
    closest: () => null,
    dispatchEvent: (e) => events.push(e.type),
  };
  return el;
}

/**
 * A React-style combobox: a text input plus a popup list.
 *
 * This is the shape that broke on the real form. `el.value = x` on one of these
 * succeeds at the DOM level and commits nothing, so the stub deliberately does
 * NOT let a written value stand — only clicking a row sets it, exactly as the
 * component does.
 */
function makeCombobox({ label, options }) {
  const el = makeControl({ label });
  // Chain to the base rather than replacing it: dropping aria-label here left
  // the control with no resolvable label at all, so it was never a candidate.
  const base = el.getAttribute;
  el.getAttribute = (name) =>
    name === "role" ? "combobox" : name === "aria-controls" ? `${label}-list` : base(name);
  el.hasAttribute = (name) => el.getAttribute(name) != null;
  el.committed = null;
  el.typed = "";
  Object.defineProperty(el, "value", {
    get() { return el.committed ?? el.typed; },
    set(v) { el.typed = v; },        // typing never commits
  });
  el.focus = () => {};
  el.nodes = options.map((text) => ({
    textContent: text,
    getBoundingClientRect: () => ({ width: 200, height: 24 }),
    querySelectorAll: () => [],
    getAttribute: () => "option",
    dispatchEvent: () => {},
    click: () => { el.committed = text; },   // only a click commits
  }));
  el.listbox = {
    getBoundingClientRect: () => ({ width: 200, height: 200 }),
    querySelectorAll: (sel) => (sel.includes("option") ? el.nodes : []),
  };
  return el;
}

function install(controls) {
  const window = {};
  const boxes = Object.fromEntries(
    controls.filter((c) => c.listbox).map((c) => [`${c.getAttribute("aria-label") ?? ""}-list`, c])
  );
  const document = {
    // Selector-aware, or a pass looking for checkboxes is handed the text
    // boxes and drives them as though they were. The real DOM would never do
    // that, and a stub that does hides bugs and invents others.
    querySelectorAll: (sel) =>
      /file|listbox|radio|checkbox|button|\[role/.test(sel) ? [] : controls,
    querySelector: () => null,
    getElementById: (id) => {
      const owner = controls.find((c) => c.listbox && `${c.labelText}-list` === id);
      return owner ? owner.listbox : null;
    },
  };

  // The engine narrows on these to pick a value setter, and reads `.options`
  // for a select. Plain objects are enough as long as instanceof is false.
  const globals = {
    window,
    document,
    CSS: { escape: (s) => s },
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    // Carries its init dict, because the engine reads event.key — a stub that
    // drops it reports "no keystrokes" for code that sent seven.
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  const names = Object.keys(globals);
  const values = Object.values(globals);

  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
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
    // Each field is announced twice: once as it is attempted, once when it
    // lands. Only the landings are compared here.
    onProgress: ({ label, attempting }) => {
      if (!attempting) seen.push(label);
    },
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
    makeControl({ label: "Pronouns" }),
    makeControl({ label: "Do you currently live in the Bay Area?" }),
  ]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.equal(report.filled.length, 0);
  assert.equal(report.skipped.length, 2);
  const reasons = report.skipped.map((s) => s.why);
  assert.ok(reasons.every(Boolean), "every skip must carry a reason");
  assert.notEqual(reasons[0], reasons[1], "different skips mean different things");
});

test("an EEOC question with no stored answer says where to set it", async () => {
  // Previously these were skipped as "yours to answer" and that was the end of
  // it. They are answerable now, so an unanswered one is a gap to point at
  // rather than a question to walk past.
  const window = install([makeControl({ label: "Gender" })]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.equal(report.skipped.length, 0);
  assert.equal(report.missing[0].label, "Gender");
  assert.match(report.missing[0].why, /Career Profile/);
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

test("a combobox is chosen from its options, not typed into", async () => {
  // The Verkada failure, reproduced. A React combobox accepts a written value
  // at the DOM level and commits nothing, so the old code reported "Degree:
  // M.S. in Computer Science" for a box that was still empty.
  const degree = makeCombobox({
    label: "Degree",
    options: ["High School", "Bachelor's Degree", "Master's Degree", "Doctorate"],
  });
  const window = install([degree]);
  const report = await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, education: { degree: "M.S. in Computer Science" } },
    { stepDelay: 0 }
  );

  assert.equal(degree.committed, "Master's Degree", "an option must be clicked");
  assert.deepEqual(report.filled, [{ label: "Degree", value: "Master's Degree", note: undefined }]);
});

test("a value no option can express is reported, and nothing is typed", async () => {
  // 2027 against 2023-2026 / 2020-2023 / Before 2020. There is no right answer
  // here, and inventing one puts a false statement on a required question.
  const year = makeCombobox({
    label: "What year did you graduate?",
    options: ["2023-2026", "2020-2023", "Before 2020"],
  });
  const window = install([year]);
  const report = await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, education: { end_year: "2027" } },
    { stepDelay: 0 }
  );

  assert.equal(report.filled.length, 0);
  assert.equal(year.committed, null, "nothing may be committed");
  assert.equal(year.value, "", "and no probe text may be left behind");
  assert.match(report.missing[0].why, /2027/);
  assert.ok(report.missing[0].offered?.length, "the user is shown what was on offer");
});

test("a numeric answer lands in the band the form offers", async () => {
  const gpa = makeCombobox({
    label: "What is your major GPA?",
    options: ["3.6 - 4.0", "3.1 - 3.5", "3.0 or under"],
  });
  const window = install([gpa]);
  await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, education: { gpa: "3.67" } },
    { stepDelay: 0 }
  );
  assert.equal(gpa.committed, "3.6 - 4.0");
});

test("stored self-identification answers fill their questions", async () => {
  const gender = makeCombobox({
    label: "Gender",
    options: ["Decline To Self Identify", "Female", "Male"],
  });
  const veteran = makeCombobox({
    label: "Veteran Status",
    options: [
      "I don't wish to answer",
      "I identify as one or more of the classifications of a protected veteran",
      "I am not a protected veteran",
    ],
  });
  const window = install([gender, veteran]);
  await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, self_identification: { gender: "male", veteran_status: "not_protected" } },
    { stepDelay: 0 }
  );

  assert.equal(gender.committed, "Male");
  assert.equal(veteran.committed, "I am not a protected veteran");
});

test("a field that discards what it was given is not reported as filled", async () => {
  // The bug this whole pass is about, at its simplest: the old code returned
  // success for every non-<select> without ever reading the value back.
  const stubborn = makeControl({ label: "First Name" });
  Object.defineProperty(stubborn, "value", { get: () => "", set: () => {} });
  const window = install([stubborn]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.equal(report.filled.length, 0);
  assert.match(report.missing[0].why, /discarded/);
});

test("a dropdown that ignores the click is reported, not counted as filled", async () => {
  // The failure behind a real report that said "Requires sponsorship: Yes"
  // filled, and four lines below listed the same question as required and
  // empty. Clicking an option is not the same as the component accepting it,
  // and only reading the value back afterwards can tell the two apart.
  const stubborn = makeCombobox({ label: "Do you require sponsorship?", options: ["Yes", "No"] });
  for (const node of stubborn.nodes) node.click = () => {}; // swallows the click
  const window = install([stubborn]);

  const report = await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, requires_sponsorship: true },
    { stepDelay: 0 }
  );

  assert.equal(report.filled.length, 0, "nothing was committed, so nothing is filled");
  assert.match(report.missing[0].why, /didn't take it/);
  assert.equal(stubborn.value, "", "and no probe text is left sitting in the box");
});

test("a dropdown that marks the row instead of the input still counts", async () => {
  // Some libraries leave the input blank and set aria-selected on the option.
  const marking = makeCombobox({ label: "Do you require sponsorship?", options: ["Yes", "No"] });
  for (const node of marking.nodes) {
    let selected = false;
    node.click = () => { selected = true; };
    node.getAttribute = (name) => (name === "aria-selected" ? String(selected) : "option");
  }
  const window = install([marking]);
  const report = await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, requires_sponsorship: true },
    { stepDelay: 0 }
  );
  assert.deepEqual(report.filled.map((f) => f.value), ["Yes"]);
});

test("a location field backed by coordinates picks a suggestion", async () => {
  // Greenhouse's Location is required and carries hidden latitude/longitude
  // inputs that only fill when a suggestion is chosen. Typing the city leaves
  // both empty, so the form refuses to submit — at the very end, after
  // everything else looked done.
  const place = makeCombobox({
    label: "Location",
    options: ["Los Angeles, CA, USA", "Los Angeles County, CA, USA"],
  });
  // The hidden coordinate inputs that make this a place field.
  const parent = {
    querySelector: (sel) => (sel.includes("lat") ? { name: "latitude" } : null),
    parentElement: null,
  };
  place.parentElement = parent;

  const window = install([place]);
  assert.equal(window.HIRECRAFT_FILL.needsPlacePick(place), true);

  await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });
  assert.equal(place.committed, "Los Angeles, CA, USA", "the suggestion must be clicked");
});

test("an ordinary location box is still just typed into", async () => {
  const plain = makeControl({ label: "Location" });
  const window = install([plain]);
  assert.equal(window.HIRECRAFT_FILL.needsPlacePick(plain), false);
  await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });
  assert.equal(plain.value, "Los Angeles, CA");
});

test("one field never reads the dropdown belonging to another", async () => {
  // A real failure on a Point72 form: the Degree menu was still open when the
  // work-authorisation question was reached, and the panel offered "Associate's
  // Degree · Bachelor's Degree · Doctor of Medicine (M.D.) …" as the answers to
  // "are you authorized to work in the US". Nothing matched "Yes", so nothing
  // was clicked — but only by luck. A list of yes/no-ish options would have
  // been chosen from.
  const degree = makeCombobox({
    label: "Degree",
    options: ["Bachelor's Degree", "Master's Degree", "Doctorate"],
  });
  const auth = makeCombobox({
    label: "Are you legally authorized to work in the United States?",
    options: ["Yes", "No"],
  });
  const window = install([degree, auth]);

  // Degree's menu is left open and reachable document-wide, as it was there.
  degree.getAttribute = ((base) => (name) =>
    name === "aria-expanded" ? "true" : base(name))(degree.getAttribute);

  await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, education: { degree: "M.S." }, authorized_to_work: true },
    { stepDelay: 0 }
  );

  assert.equal(degree.committed, "Master's Degree");
  assert.equal(auth.committed, "Yes", "the work question must read its own list");
  assert.ok(
    !["Bachelor's Degree", "Master's Degree", "Doctorate"].includes(auth.committed),
    "a degree must never be committed into a work-authorisation question"
  );
});

// --- which list belongs to which control ------------------------------------
//
// Three separate wrong answers have come from reading the wrong option list: a
// degree menu answering a work-authorisation question, and a phone dial-code
// list offered to both Location and School. These test the guards directly.

const rect = (w, h) => () => ({ width: w, height: h });

function listNode(labels, { visible = true } = {}) {
  const rows = labels.map((text) => ({
    textContent: text,
    getBoundingClientRect: rect(200, visible ? 24 : 0),
    getAttribute: () => "option",
  }));
  return {
    getBoundingClientRect: rect(200, visible ? 200 : 0),
    querySelectorAll: (sel) => (sel.includes("option") ? rows : []),
  };
}

test("a hidden option list is not a list", async () => {
  // A closed dropdown usually keeps its rows in the DOM. Counting those made a
  // shut phone-country list look open, and Location was offered dialling codes.
  const window = install([]);
  const { optionNodes } = window.HIRECRAFT_FILL;

  assert.equal(optionNodes(listNode(["United States +1", "Albania +355"])).length, 2);
  assert.equal(optionNodes(listNode(["United States +1"], { visible: false })).length, 0);
  assert.equal(optionNodes(null).length, 0);
});

test("a control that says it is closed offers no list", async () => {
  const window = install([]);
  const { listboxFor } = window.HIRECRAFT_FILL;

  const shut = {
    getAttribute: (n) => (n === "aria-expanded" ? "false" : null),
    parentElement: null,
  };
  assert.equal(listboxFor(shut), null, "believe a control that reports itself closed");
});

test("the search for a list stops before the next field", async () => {
  const window = install([]);
  const { listboxFor } = window.HIRECRAFT_FILL;

  // The neighbour's list, sitting in a shared ancestor. Reaching it is what
  // handed a location box a list of countries.
  const neighboursList = listNode(["United States +1", "Afghanistan +93"]);
  const otherField = { getBoundingClientRect: rect(200, 32) };
  const mine = { getBoundingClientRect: rect(200, 32) };

  const shared = {
    querySelectorAll: (sel) =>
      sel.includes("input") ? [mine, otherField] : [],
    querySelector: () => neighboursList,
    parentElement: null,
  };
  const ownContainer = {
    querySelectorAll: (sel) => (sel.includes("input") ? [mine] : []),
    querySelector: () => null,          // no list of its own yet
    parentElement: shared,
  };
  mine.parentElement = ownContainer;
  mine.getAttribute = () => null;

  assert.equal(
    listboxFor(mine),
    null,
    "the neighbour's list must be out of reach once a second control appears"
  );
});

test("an empty text box beside a filled dropdown is still filled", async () => {
  // Point72 puts the phone input next to a country picker and the end-year
  // input next to a month picker. Reading a plain input's ancestors found the
  // neighbouring widget's displayed value, judged the box already answered, and
  // passed over it — without recording that anywhere in the report.
  const phone = makeControl({ label: "Phone", type: "tel" });
  const neighboursValue = { className: "select__single-value", textContent: "United States +1" };
  phone.parentElement = {
    // Selector-aware, because a stub that answers every query with the same
    // node is not a DOM — it is a yes-man. This one said yes to a search for a
    // Workday pill and reported the phone box as already answered, which is a
    // failure invented by the harness rather than found in the code.
    querySelector: (sel) => (String(sel).includes("single-value") ? neighboursValue : null),
    querySelectorAll: () => [],
    parentElement: null,
  };

  const window = install([phone]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.equal(phone.value, "(213) 994-5086", "a plain input keeps its own value");
  assert.deepEqual(report.filled.map((f) => f.label), ["Phone"]);
});

test("a field left alone says so, rather than vanishing", async () => {
  const typed = makeControl({ label: "Email", type: "email" });
  typed.value = "someone.else@example.com";
  const window = install([typed]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.equal(report.filled.length, 0);
  const row = report.trace.find((e) => e.outcome === "left alone");
  assert.ok(row, "every control considered must appear in the trace");
  assert.match(row.why, /already holds/);
});

test("HireCraft's own panel is not part of the employer's form", async () => {
  // The panel carries a résumé picker, and it was turning up in the form scan.
  // Harmless only because no field pattern happened to match its label — a
  // filler that can reach its own interface is one edit from answering an
  // employer's question with its own dropdown.
  const ours = makeControl({ label: "Résumé MHR_AIML (default) MHR_SWE" });
  ours.closest = (sel) => (sel.includes("hirecraft-root") ? {} : null);
  const theirs = makeControl({ label: "First Name" });

  const window = install([ours, theirs]);
  const rows = window.HIRECRAFT_FILL.inspectForm();

  assert.deepEqual(rows.map((r) => r.label), ["First Name"]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });
  assert.equal(ours.value, "", "our own control must never be written to");
  assert.deepEqual(report.filled.map((f) => f.label), ["First name"]);
});

test("a menu that refuses to close is reported, not assumed shut", async () => {
  // The Point72 country picker stayed open through Escape, an outside click
  // and a blur, and sat over the field below it. Every version of the close
  // before this one reported success by saying nothing.
  const stubborn = makeCombobox({ label: "Country", options: ["United States +1"] });
  let expanded = "true";
  const base = stubborn.getAttribute;
  stubborn.getAttribute = (name) => (name === "aria-expanded" ? expanded : base(name));

  const window = install([stubborn]);
  const report = await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, country: "United States" },
    { stepDelay: 0 }
  );

  const row = report.trace.find((e) => e.field === "country");
  assert.equal(row.outcome, "filled");
  assert.equal(row.leftOpen, true, "a stuck menu must be recorded");

  // And one that does close is recorded as closed.
  expanded = "false";
  const ok = makeCombobox({ label: "Country", options: ["United States +1"] });
  const w2 = install([ok]);
  const r2 = await w2.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, country: "United States" },
    { stepDelay: 0 }
  );
  assert.equal(r2.trace.find((e) => e.field === "country").leftOpen, false);
});

// --- questions asked as a set of choices ------------------------------------

function makeRadioGroup({ question, name, options }) {
  const els = options.map((text) => {
    const label = { innerText: text, getBoundingClientRect: rect(120, 24) };
    const el = {
      tagName: "INPUT",
      checked: false,
      disabled: false,
      value: text,
      getAttribute: (n) => (n === "type" ? "radio" : n === "name" ? name : null),
      hasAttribute() { return false; },
      getBoundingClientRect: rect(0, 0),      // styled radios are usually hidden
      dispatchEvent: () => {},
      closest: (sel) => (sel.includes("label") ? label : null),
      click: () => { for (const other of els) other.checked = other.el === el; },
    };
    label.el = el;
    el.el = el;
    return el;
  });
  // Clicking a label selects that radio and clears the others.
  for (const el of els) {
    const label = el.closest("label");
    label.click = () => { for (const other of els) other.checked = other === el; };
  }
  const wrapper = {
    querySelector: (sel) => (sel.includes("legend") ? { innerText: question } : null),
    querySelectorAll: () => [],
    getAttribute: () => null,
    parentElement: null,
  };
  for (const el of els) el.parentElement = wrapper;
  return { els, question };
}

function installRadios(group) {
  const window = {};
  const document = {
    querySelectorAll: (sel) => (sel.includes('type="radio"') ? group.els : []),
    querySelector: () => null,
    getElementById: () => null,
  };
  const globals = {
    window, document,
    CSS: { escape: (s) => s },
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    // Carries its init dict, because the engine reads event.key — a stub that
    // drops it reports "no keystrokes" for code that sent seven.
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    HTMLInputElement: class {},
    HTMLTextAreaElement: class {},
    HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
    new Function(...Object.keys(globals), read(file))(...Object.values(globals));
  }
  return window;
}

test("a yes/no question asked as radios is answered", async () => {
  // Ashby asks about sponsorship this way. The main scan cannot see it — radios
  // are excluded there because everything else assumes a text value — so the
  // question was not filled, not reported, and not even listed by Inspect.
  const group = makeRadioGroup({
    question: "Will you need sponsorship to work in the U.S. now or anytime in the future?",
    name: "sponsorship",
    options: ["Yes", "No"],
  });
  const window = installRadios(group);

  const report = await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, requires_sponsorship: true },
    { stepDelay: 0 }
  );

  assert.equal(group.els[0].checked, true, "Yes must be selected");
  assert.equal(group.els[1].checked, false);
  assert.deepEqual(report.filled.map((f) => f.label), ["Requires sponsorship"]);
});

test("the question is read from the group, not from one of its answers", async () => {
  // Walking outward for a label finds the option text first unless the options
  // are excluded — and then "Yes" becomes the question.
  const group = makeRadioGroup({
    question: "Are you open to being in-office 5 days a week in Sunnyvale?",
    name: "onsite",
    options: ["Yes", "No"],
  });
  const window = installRadios(group);
  const found = window.HIRECRAFT_FILL.radioGroups();

  assert.equal(found.length, 1);
  assert.match(found[0].question, /in-office 5 days/);
  assert.deepEqual(found[0].options.map((o) => o.text), ["Yes", "No"]);
});

test("a group already answered is left alone", async () => {
  const group = makeRadioGroup({
    question: "Will you need sponsorship to work in the U.S.?",
    name: "sponsorship",
    options: ["Yes", "No"],
  });
  group.els[1].checked = true;                    // the user picked No
  const window = installRadios(group);
  const report = await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, requires_sponsorship: true },
    { stepDelay: 0 }
  );

  assert.equal(group.els[1].checked, true, "their answer must survive");
  assert.equal(group.els[0].checked, false);
  assert.equal(report.filled.length, 0);
  assert.ok(report.trace.some((e) => e.outcome === "left alone"));
});

test("a radio with no label is still selectable through its row", async () => {
  // Ashby's markup: the input sits inside a span inside the option row, with no
  // <label> anywhere. Clicking the input hit nothing, so Gender and Race came
  // back "the option would not take" while Veteran Status — nested differently
  // — worked. Only the click failed; the match had been right all along.
  const group = makeRadioGroup({
    question: "Gender",
    name: "gender",
    options: ["Male", "Female", "Decline to self-identify"],
  });
  for (const el of group.els) {
    const row = { click: () => { for (const other of group.els) other.checked = other === el; } };
    el.closest = (sel) => (sel.includes("option") ? row : null);   // no label at all
    el.click = () => {};                                            // the input is inert
  }
  const window = installRadios(group);

  await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, self_identification: { gender: "male" } },
    { stepDelay: 0 }
  );
  assert.equal(group.els[0].checked, true, "the option row must be clicked");
});

test("an option's parts are not glued together", async () => {
  // Ashby renders a school as name, country and domain in separate elements.
  // textContent produced "University of Southern CaliforniaUnited Statesusc.edu",
  // which is what the report showed back.
  const window = install([]);
  const { optionNodes } = window.HIRECRAFT_FILL;
  const box = {
    getBoundingClientRect: rect(200, 200),
    querySelectorAll: (sel) =>
      sel.includes("option")
        ? [{
            innerText: "University of Southern California\nUnited States\nusc.edu",
            textContent: "University of Southern CaliforniaUnited Statesusc.edu",
            getBoundingClientRect: rect(200, 40),
            getAttribute: () => "option",
          }]
        : [],
  };
  const rows = optionNodes(box);
  assert.equal(rows.length, 1);
});

test("a value the page puts back is reported as failed, not as filled", async () => {
  // The failure this whole pass is about. A controlled component accepts a
  // write, re-renders from its own unchanged state, and restores the field —
  // and a check made immediately after writing reads the gap in between. An
  // Ashby form reported Veteran Status answered while nothing was selected on
  // the page.
  const reverting = makeControl({ label: "First Name" });
  let written = "";
  Object.defineProperty(reverting, "value", {
    get: () => written,
    set: (v) => {
      written = v;
      // The page restores it a moment later, as React does on re-render.
      setTimeout(() => { written = ""; }, 60);
    },
  });

  const window = install([reverting]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.equal(report.filled.length, 0, "nothing survived, so nothing is filled");
  assert.match(report.missing[0].why, /put it back/);
  assert.ok(report.trace.some((e) => e.outcome === "reverted"));
});

test("a value that sticks is still reported as filled", async () => {
  // The re-check must not throw away correct work.
  const steady = makeControl({ label: "First Name" });
  const window = install([steady]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.deepEqual(report.filled.map((f) => f.value), ["Mohammad Hasnain"]);
  assert.equal(report.missing.length, 0);
  assert.ok(!("holds" in report.filled[0]), "the internal re-check must not leak into the report");
});

test("a yes/no asked with buttons is answered", async () => {
  // Ashby asks about sponsorship, being in the office, and immigration status
  // as two boxes reading Yes and No — neither inputs nor radios, so they
  // appeared nowhere at all: not filled, not reported, not even scanned.
  const make = (text) => {
    const el = {
      innerText: text,
      className: "_option_",
      getAttribute: (n) => (n === "role" ? "button" : null),
      matches: (sel) => sel.includes("button"),
      getBoundingClientRect: rect(80, 36),
      dispatchEvent: () => {},
      querySelectorAll: () => [],
      querySelector: () => null,
      click() { this.className = "_option_ selected"; },
    };
    return el;
  };
  const yes = make("Yes");
  const no = make("No");
  const wrapper = {
    children: [yes, no],
    querySelector: (sel) => (sel.includes("legend") ? { innerText: "Will you need sponsorship to work in the U.S.?" } : null),
    querySelectorAll: () => [],
    getAttribute: () => null,
    parentElement: null,
  };
  yes.parentElement = wrapper;
  no.parentElement = wrapper;

  const window = {};
  const document = {
    querySelectorAll: (sel) =>
      sel.includes("button") ? [yes, no] : sel.includes("radio") ? [] : [],
    querySelector: () => null,
    getElementById: () => null,
  };
  const globals = {
    window, document,
    CSS: { escape: (s) => s },
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    // Carries its init dict, because the engine reads event.key — a stub that
    // drops it reports "no keystrokes" for code that sent seven.
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
    new Function(...Object.keys(globals), read(file))(...Object.values(globals));
  }

  const report = await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, requires_sponsorship: true },
    { stepDelay: 0 }
  );

  assert.match(yes.className, /selected/, "Yes must be chosen");
  assert.ok(!/selected/.test(no.className));
  assert.deepEqual(report.filled.map((f) => f.label), ["Requires sponsorship"]);
});

test("the filler never presses submit, whatever a label matches", async () => {
  // The widget scan is deliberately wide, and the promise it must not break is
  // that nothing is ever submitted. Two guards: a submit-shaped control cannot
  // match a field, and it is refused by name regardless.
  const submit = makeControl({ label: "Email" });     // a label that WOULD match
  submit.innerText = "Submit";
  submit.tagName = "BUTTON";
  let pressed = false;
  submit.click = () => { pressed = true; };
  submit.closest = () => null;

  const window = install([submit]);
  await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.equal(pressed, false, "a control reading Submit is never clicked");
  assert.equal(submit.value, "", "and never written to");
});

test("a second education block is filled from the next degree", async () => {
  // A form offering "+ Add Education" is asking for the rest of them, and the
  // résumé has a bachelor's under the master's.
  const first = makeControl({ label: "School" });
  first.value = "University of Southern California";   // block one, already done
  const second = makeControl({ label: "School" });

  let added = false;
  const addButton = {
    innerText: "+ Add Education",
    tagName: "BUTTON",
    getAttribute: () => null,
    getBoundingClientRect: rect(160, 40),
    dispatchEvent: () => {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    click: () => { added = true; },
  };

  let controls = [first];
  const window = {};
  const document = {
    querySelectorAll: (sel) => {
      if (sel.includes("file") || sel.includes("radio") || sel.includes("checkbox")) return [];
      if (sel.includes("button")) return [addButton];
      return added ? [first, second] : controls;
    },
    querySelector: () => null,
    getElementById: () => null,
  };
  const globals = {
    window, document, CSS: { escape: (s) => s },
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    // Carries its init dict, because the engine reads event.key — a stub that
    // drops it reports "no keystrokes" for code that sent seven.
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
    new Function(...Object.keys(globals), read(file))(...Object.values(globals));
  }

  await window.HIRECRAFT_FILL.fillForm(
    {
      ...PROFILE,
      education: { school: "University of Southern California" },
      education_all: [
        { school: "University of Southern California" },
        { school: "RV College of Engineering" },
      ],
    },
    { stepDelay: 0 }
  );

  assert.equal(added, true, "the add button must be pressed");
  assert.equal(second.value, "RV College of Engineering", "block two takes the next degree");
  assert.equal(first.value, "University of Southern California", "block one is untouched");
});

test("a button is clicked once, not twice", async () => {
  // clickLike dispatched a click event AND called click(). Harmless on an
  // input; on "+ Add Education" it fired the handler twice and produced two
  // identical bachelor's entries on a form that needed one.
  let presses = 0;
  const button = {
    innerText: "+ Add Education",
    tagName: "BUTTON",
    getAttribute: () => null,
    getBoundingClientRect: rect(160, 40),
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    dispatchEvent: (e) => { if (e.type === "click") presses += 1; },
    click: () => { presses += 1; },
  };

  const window = install([]);
  window.HIRECRAFT_FILL.clickLike(button);
  assert.equal(presses, 1, "exactly one press reaches the handler");
});

test("a second education block is not added when the form already has one", async () => {
  // Two school boxes means the block exists; adding another duplicates a degree,
  // and a duplicated degree is the user's mess to clean up.
  const first = makeControl({ label: "School" });
  first.value = "University of Southern California";
  const second = makeControl({ label: "School" });
  second.value = "RV College of Engineering";

  let pressed = false;
  const addButton = {
    innerText: "+ Add Education", tagName: "BUTTON",
    getAttribute: () => null, getBoundingClientRect: rect(160, 40),
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: () => {}, click: () => { pressed = true; },
  };
  const window = {};
  const document = {
    querySelectorAll: (sel) =>
      sel.includes("button") ? [addButton]
      : sel.includes("file") || sel.includes("radio") || sel.includes("checkbox") ? []
      : [first, second],
    querySelector: () => null,
    getElementById: () => null,
  };
  const globals = {
    window, document, CSS: { escape: (s) => s },
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    // Carries its init dict, because the engine reads event.key — a stub that
    // drops it reports "no keystrokes" for code that sent seven.
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
    new Function(...Object.keys(globals), read(file))(...Object.values(globals));
  }

  const report = await window.HIRECRAFT_FILL.fillForm(
    {
      ...PROFILE,
      education: { school: "University of Southern California" },
      education_all: [{ school: "University of Southern California" }, { school: "RV College of Engineering" }],
    },
    { stepDelay: 0 }
  );
  assert.equal(pressed, false, "the add button must not be pressed again");
  assert.ok(report.trace.some((e) => e.label === "Add education" && e.outcome === "left alone"));
});

test("a select is named by its wrapper and its first option", async () => {
  // Ashby's four date pickers are plain <select>s with no id, no name and no
  // label. A select has no placeholder attribute either — its prompt is the
  // first option — so every attempt to name one came back empty and the scan
  // dropped it. The words are in the wrapper's id or nowhere.
  const month = {
    tagName: "SELECT",
    id: "", value: "", disabled: false, readOnly: false, events: [],
    options: [{ text: "Month...", value: "" }, { text: "August", value: "8" }],
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: rect(140, 40),
    closest: () => null,
    dispatchEvent: () => {},
  };
  const wrapper = {
    id: "_systemfield_education_history-startDate",
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.includes("input") ? [month, {}] : []),
    getAttribute: () => null,
    parentElement: null,
  };
  month.parentElement = wrapper;

  const window = install([month]);
  const label = window.HIRECRAFT_FILL.labelFor(month);
  assert.match(label, /startDate/, "the wrapper's id names the pair");
  assert.match(label, /Month/, "the first option names this half of it");
  assert.match(
    window.HIRECRAFT_FILL.normalise(label),
    /start date month/,
    "and together they read as the question the catalogue is waiting for"
  );
});

test("a value the form defaults while we fill is not mistaken for an answer", async () => {
  // Picking a start month made Ashby default the year beside it to the current
  // year, and "leave it alone if it already has something" read that back as
  // the user's own entry — so 2025 was never written and the form said 2026.
  const month = makeControl({ label: "Start date month" });
  const year = makeControl({ label: "Start date year" });
  // Filling the month sets the year, exactly as the form does.
  const base = Object.getOwnPropertyDescriptor(month, "value");
  Object.defineProperty(month, "value", {
    get: () => base?.get?.() ?? month._v ?? "",
    set: (v) => { month._v = v; if (v) year._v = "2026"; },
  });
  Object.defineProperty(year, "value", {
    get: () => year._v ?? "",
    set: (v) => { year._v = v; },
  });

  const window = install([month, year]);
  await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, education: { start_month: "August", start_year: "2025" } },
    { stepDelay: 0 }
  );

  assert.equal(month.value, "August");
  assert.equal(year.value, "2025", "the stored year must win over the form's default");
});

test("what the user typed before the fill is still left alone", async () => {
  // The rule the snapshot exists to keep.
  const typed = makeControl({ label: "Email", type: "email" });
  typed.value = "someone.else@example.com";
  const window = install([typed]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });
  assert.equal(typed.value, "someone.else@example.com");
  assert.ok(report.trace.some((e) => e.outcome === "left alone"));
});

test("a select is filled by matching its option text, not by writing it", async () => {
  // The second-education pass had its own branch with no case for a <select>,
  // so it wrote "July" into a control whose option value is "7". The month was
  // discarded; the year beside it worked only because its option value happens
  // to equal its text, which made the failure look arbitrary.
  const month = {
    tagName: "SELECT", id: "", value: "", disabled: false, readOnly: false,
    options: [
      { text: "Month...", value: "" },
      { text: "July", value: "7" },
      { text: "August", value: "8" },
    ],
    getAttribute: (n) => (n === "aria-label" ? "End date month" : null),
    hasAttribute: () => false,
    getBoundingClientRect: rect(140, 40),
    closest: () => null,
    dispatchEvent: () => {},
  };
  const window = install([month]);
  // The engine writes through the native setter, which the stub records as
  // a plain assignment.
  await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, education: { end_month: "July" } },
    { stepDelay: 0 }
  );
  assert.equal(month.value, "7", "the option's value, not its text");
});

test("holding *something* is not holding the value we put there", async () => {
  // An end-month box left reading August was reported as filled with July,
  // because the check only asked whether the box held anything at all.
  const month = {
    tagName: "SELECT", id: "", disabled: false, readOnly: false,
    selectedIndex: 2,                       // stuck on August, whatever we set
    options: [
      { text: "Month...", value: "" },
      { text: "July", value: "7" },
      { text: "August", value: "8" },
    ],
    value: "8",
    getAttribute: (n) => (n === "aria-label" ? "End date month" : null),
    hasAttribute: () => false,
    getBoundingClientRect: rect(140, 40),
    closest: () => null,
    dispatchEvent: () => {},
  };
  const window = install([month]);
  const report = await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, education: { end_month: "July" } },
    { stepDelay: 0 }
  );

  assert.equal(report.filled.length, 0, "August is not July");
  assert.ok(
    report.missing.some((m) => /put it back/.test(m.why)) ||
      report.trace.some((e) => e.outcome !== "filled"),
    "and the report must say so"
  );
});

test("a reformatted value still counts as held", async () => {
  // The rule the check above must not break: a phone mask is the field
  // agreeing with us, not refusing.
  const phone = makeControl({ label: "Phone", type: "tel" });
  let stored = "";
  Object.defineProperty(phone, "value", {
    get: () => stored,
    set: (v) => { stored = String(v).replace(/\D/g, ""); },   // strips formatting
  });
  const window = install([phone]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });
  assert.equal(report.filled.length, 1, "the field kept the number, its own way");
  assert.equal(report.missing.length, 0);
});

test("a password field is never even looked at", async () => {
  // Workday puts a sign-in ahead of its form, so the filler now runs on pages
  // that have one. Nothing here holds a credential to type into it, but a scan
  // that can reach a password field is one bad label match from writing to it.
  const password = makeControl({ label: "Email", type: "password" });
  const window = install([password]);

  const rows = window.HIRECRAFT_FILL.inspectForm();
  assert.equal(rows.length, 0, "not even listed");
  await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });
  assert.equal(password.value, "", "and never written to");
});

test("a country picker for a dialling code is not the country question", async () => {
  // The neighbour test looks for a telephone input, and Workday's phone number
  // box is type="text" — so the label has to be read too, or a box wanting
  // "+1" is sent "United States".
  const code = makeControl({ label: "Country Phone Code" });
  const window = install([code]);
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });

  assert.equal(code.value, "", "the dialling-code box is left alone");
  assert.equal(report.filled.length, 0);
});

test("a real country question still fills", async () => {
  const country = makeControl({ label: "Country" });
  const window = install([country]);
  await window.HIRECRAFT_FILL.fillForm(PROFILE, { stepDelay: 0 });
  assert.equal(country.value, "United States");
});

test("a fill that cannot finish stops and says so", async () => {
  // Every wait in the engine is bounded and none of them were bounded
  // together: four dropdowns that never resolve cost twenty-six seconds, and a
  // page with more than four could keep the panel on "Filling…" for minutes.
  // That is indistinguishable from a hang, and was reported as one.
  const slow = ["First Name", "Last Name", "Email", "Phone"].map((label) =>
    makeCombobox({ label, options: [] })
  );
  const window = install(slow);

  const started = Date.now();
  const report = await window.HIRECRAFT_FILL.fillForm(PROFILE, {
    stepDelay: 0,
    budgetMs: 400,
  });
  const took = Date.now() - started;

  assert.ok(took < 6000, `should give up quickly, took ${took}ms`);
  assert.ok(
    report.missing.some((m) => /ran out of time/.test(m.why)),
    "and the report should say what was left"
  );
});

test("progress is reported before a field, not only after", async () => {
  // So a slow control does not leave the panel showing the field before it.
  const first = makeControl({ label: "First Name" });
  const window = install([first]);

  const seen = [];
  await window.HIRECRAFT_FILL.fillForm(PROFILE, {
    stepDelay: 0,
    onProgress: ({ label, attempting }) => seen.push(`${attempting ? "…" : "✓"}${label}`),
  });
  assert.deepEqual(seen, ["…First name", "✓First name"]);
});

/**
 * Workday, which builds every dropdown as a <button>.
 *
 * Not a variation on the shape the other boards use — a different shape. There
 * is nothing to type into on the element itself, its `value` is a key out of
 * someone's database, and its prompt is the words "Select One" with no ellipsis
 * to mark them as a prompt. Each of those was an assumption made here, and the
 * first one threw.
 */
function installWorkday({ text = "Select One", value = "" } = {}) {
  const window = {};
  const search = {
    tagName: "INPUT", id: "", value: "", disabled: false, readOnly: false,
    getAttribute: (n) => (n === "type" ? "text" : null),
    hasAttribute: () => false,
    getBoundingClientRect: rect(200, 30),
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: () => {}, focus() {},
  };
  const button = {
    tagName: "BUTTON", id: "address--countryRegion", innerText: text, value,
    disabled: false, readOnly: false,
    getAttribute: (n) => (n === "aria-haspopup" ? "listbox" : n === "name" ? "countryRegion" : null),
    hasAttribute: (n) => n === "aria-haspopup",
    getBoundingClientRect: rect(200, 40),
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: () => {}, focus() {}, click() {},
  };
  // The wrapper Workday puts them both in — which is the only thing relating
  // the search box to the button that opens it.
  const wrapper = {
    tagName: "DIV", id: "", getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: (sel) => (/input|textarea/.test(sel) ? [search] : []),
    parentElement: null, closest: () => null,
  };
  button.parentElement = wrapper;
  search.parentElement = wrapper;

  const globals = {
    window,
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null },
    CSS: { escape: (s) => s },
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    // Carries its init dict, because the engine reads event.key — a stub that
    // drops it reports "no keystrokes" for code that sent seven.
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
    new Function(...Object.keys(globals), read(file))(...Object.values(globals));
  }
  return { window, button, search };
}

test("writing to something that is not a form control is refused, not attempted", () => {
  // The real one, from Applied Materials' My Information page: setValue fell
  // through to HTMLInputElement's value setter for anything that was not a
  // textarea or a select, and calling a native setter on a <button> throws
  // "Illegal invocation". It took the State field down, and before each control
  // had its own catch it would have taken every field after it too.
  const { window, button } = installWorkday();
  const { setValue } = window.HIRECRAFT_FILL;

  assert.doesNotThrow(() => setValue(button, "CA"));
  assert.equal(setValue(button, "CA"), false, "and says it did nothing");
  assert.equal(button.value, "", "leaving the button alone");
});

test("typing goes to the search box beside the button, not to the button", () => {
  const { window, button, search } = installWorkday();
  assert.equal(window.HIRECRAFT_FILL.searchBoxFor(button), search);
});

test("a wrapper holding two fields is not guessed between", () => {
  // The mistake this file has made three times: reaching past a field's own
  // boundary and driving the one next door.
  const { window, button } = installWorkday();
  const second = { ...button, tagName: "INPUT", getAttribute: () => "text" };
  button.parentElement.querySelectorAll = () => [
    { ...second, getBoundingClientRect: rect(200, 30) },
    { ...second, getBoundingClientRect: rect(200, 30) },
  ];
  assert.equal(window.HIRECRAFT_FILL.searchBoxFor(button), null);
});

test("a prompt is not an answer, and a database key is not one either", () => {
  // Both from the same page. "Select One" read as a filled field, so State
  // would never have been touched; Country read as holding
  // "bc33aa3152ec42d4995f4791a106ed09", which went into the report exactly like
  // that — right that the field was answered, but for no reason anyone could
  // check.
  const prompt = installWorkday({ text: "Select One" });
  assert.equal(prompt.window.HIRECRAFT_FILL.displayedValue(prompt.button), "");

  const answered = installWorkday({
    text: "United States of America",
    value: "bc33aa3152ec42d4995f4791a106ed09",
  });
  assert.equal(
    answered.window.HIRECRAFT_FILL.displayedValue(answered.button),
    "United States of America"
  );
});

test("a list that never named itself is still found after typing", async () => {
  // Workday does not link its popup to the button that opens it, so the list can
  // only be recognised as the one that appeared when we acted. The poll after
  // typing looked at aria-controls alone: the rows arrived and went unseen, and
  // a list standing open on screen was reported as one that never opened.
  //
  // It also exercises the whole Workday dropdown in one go — a <button> to
  // open, a separate box to type in, "Select One" as the empty state, and the
  // chosen value arriving as the button's own text.
  let open = false;
  const wrapper = {
    tagName: "DIV", id: "", className: "", getAttribute: () => null,
    parentElement: null, closest: () => null, dispatchEvent: () => {}, click() {},
  };
  const search = {
    tagName: "INPUT", id: "", className: "", value: "",
    disabled: false, readOnly: false, parentElement: wrapper,
    getAttribute: (n) => (n === "type" ? "text" : null),
    hasAttribute: () => false, getBoundingClientRect: rect(200, 30),
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: () => {}, focus() {},
  };
  const button = {
    tagName: "BUTTON", id: "address--countryRegion", className: "",
    innerText: "Select One", value: "", disabled: false, readOnly: false,
    parentElement: wrapper,
    getAttribute: (n) =>
      n === "aria-haspopup" ? "listbox"
      : n === "aria-expanded" ? String(open)
      : n === "aria-label" ? "State"
      : null,
    hasAttribute: (n) => ["aria-haspopup", "aria-expanded"].includes(n),
    getBoundingClientRect: rect(200, 40),
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: () => {}, focus() {},
    click() { open = true; },
  };
  wrapper.querySelector = (sel) => (/input|select|textarea/.test(sel) ? search : null);
  wrapper.querySelectorAll = (sel) => (/input|textarea/.test(sel) ? [search] : []);

  const option = (text) => ({
    tagName: "DIV", id: "", className: "", innerText: text, textContent: text,
    getAttribute: (n) => (n === "role" ? "option" : null),
    getBoundingClientRect: rect(180, 28),
    scrollIntoView() {}, dispatchEvent: () => {},
    click() { button.innerText = text; open = false; },
  });
  const rows = [option("California"), option("Kansas")];
  const listbox = {
    tagName: "UL", id: "", className: "", parentElement: null,
    getAttribute: (n) => (n === "role" ? "listbox" : null),
    querySelectorAll: (sel) => (sel.includes("option") ? rows : []),
  };
  for (const row of rows) row.parentElement = listbox;

  // The list renders nothing until the search box has something in it, which is
  // the whole reason the probe loop exists.
  const filtered = () => (search.value ? [listbox] : []);
  const window = {};
  const document = {
    querySelectorAll: (sel) => {
      if (sel === '[role="listbox"]') return filtered();
      if (sel === '[role="option"]') return search.value ? rows : [];
      if (sel.includes("aria-haspopup")) return [button];
      return [];
    },
    querySelector: () => null,
    getElementById: () => null,
    body: { dispatchEvent: () => {} },
  };
  const globals = {
    window, document, CSS: { escape: (s) => s },
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    // Carries its init dict, because the engine reads event.key — a stub that
    // drops it reports "no keystrokes" for code that sent seven.
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
    new Function(...Object.keys(globals), read(file))(...Object.values(globals));
  }

  const report = await window.HIRECRAFT_FILL.fillForm(
    { ...PROFILE, state: "CA" },
    { stepDelay: 0 }
  );

  assert.equal(button.innerText, "California", "the button shows what was chosen");
  assert.deepEqual(report.filled.map((f) => f.label), ["State"]);
  const row = report.trace.find((e) => e.field === "state");
  assert.equal(row.outcome, "filled");
  assert.equal(row.listbox.from, "appeared-on-open", "found by appearing, not by name");
  assert.notEqual(row.listbox.typedInto, "the control itself", "typed beside the button");
});

/**
 * Workday's résumé upload: one hidden input behind a "Select Files" button.
 *
 * The input has no id, no name and no label, and the words "Resume/CV" sit
 * further up the page than the section walk reaches — so the single most
 * valuable field on the form came back as "couldn't tell which upload box" on a
 * page that offers exactly one.
 */
function installUploads(boxes) {
  const window = {};
  const inputs = boxes.map(({ sectionText, files = [] }) => {
    const section = {
      tagName: "DIV", id: "", className: "", textContent: sectionText,
      getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
      parentElement: null,
    };
    const input = {
      tagName: "INPUT", id: "", className: "", value: "", files,
      disabled: false, readOnly: false, parentElement: section,
      getAttribute: (n) => (n === "type" ? "file" : null),
      hasAttribute: () => false,
      getBoundingClientRect: rect(0, 0),   // hidden behind the button
      closest: (sel) => (/form|section|div/.test(sel) ? section : null),
      querySelector: () => null, querySelectorAll: () => [],
      dispatchEvent: () => {},
    };
    section.querySelector = () => input;
    return input;
  });

  const globals = {
    window,
    document: {
      querySelectorAll: (sel) => (sel.includes("file") ? inputs : []),
      querySelector: () => null,
      getElementById: () => null,
    },
    CSS: { escape: (s) => s },
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    // Carries its init dict, because the engine reads event.key — a stub that
    // drops it reports "no keystrokes" for code that sent seven.
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
    new Function(...Object.keys(globals), read(file))(...Object.values(globals));
  }
  return { window, inputs };
}

const forResume = (window) =>
  window.HIRECRAFT_FILL.findUploadInput(
    window.HIRECRAFT_RESUME_FILE,
    window.HIRECRAFT_NOT_RESUME,
    { soleIsThis: true }
  );

test("the only upload box on the page takes the résumé", () => {
  // Workday's My Experience step. Nothing within reach of the input names it.
  const { window, inputs } = installUploads([
    { sectionText: "Upload a file (5MB max) Select files Drop files here" },
  ]);
  assert.equal(forResume(window), inputs[0]);
});

test("a lone box that says it is for something else is still refused", () => {
  for (const text of ["Cover Letter Select files", "Graduate Transcript Select files"]) {
    const { window } = installUploads([{ sectionText: text }]);
    assert.equal(forResume(window), null, `"${text}" must not take a résumé`);
  }
});

test("a lone box that already holds a file is left alone", () => {
  // Including a file the user chose by hand before pressing Fill.
  const { window } = installUploads([
    { sectionText: "Upload a file (5MB max)", files: [{ name: "theirs.pdf" }] },
  ]);
  assert.equal(forResume(window), null);
});

test("two unnamed boxes stay ambiguous rather than becoming a guess", () => {
  // The whole reason the section walk exists: a form with four uploads, where
  // the résumé landing in the transcript box looks filled and is wrong.
  const { window } = installUploads([
    { sectionText: "Select files" },
    { sectionText: "Select files" },
  ]);
  assert.equal(forResume(window), null);
});

test("a cover letter never takes a lone unnamed box", () => {
  // The asymmetry is deliberate. A single upload box on an application form is
  // a résumé box; it is not a cover-letter box, and guessing it into one would
  // attach the wrong document under the right name.
  const { window } = installUploads([{ sectionText: "Upload a file (5MB max)" }]);
  assert.equal(
    window.HIRECRAFT_FILL.findUploadInput(
      window.HIRECRAFT_COVER_FILE,
      window.HIRECRAFT_NOT_COVER
    ),
    null
  );
});

/**
 * Workday's My Experience step: three "Add" buttons that all say "Add".
 *
 * Same automation id, same class, no distinguishing mark on any of them. The
 * only thing that says which is which is the heading above it — Work Experience
 * / Add / Education / Add / Skills — which is exactly what a person reads.
 */
function installSections(order) {
  const window = {};
  const nodes = order.map(({ tag, text }) => ({
    tagName: tag.toUpperCase(),
    id: "", className: "", innerText: text, textContent: text,
    getAttribute: () => null,
    hasAttribute: () => false,
    getBoundingClientRect: rect(120, 40),
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: () => {}, click() {}, parentElement: null,
  }));
  const globals = {
    window,
    document: {
      // Document order, which is the whole basis of the rule.
      querySelectorAll: (sel) => (/h1|heading|button/.test(sel) ? nodes : []),
      querySelector: () => null,
      getElementById: () => null,
    },
    CSS: { escape: (s) => s },
    Event: class { constructor(type) { this.type = type; } },
    MouseEvent: class { constructor(type) { this.type = type; } },
    // Carries its init dict, because the engine reads event.key — a stub that
    // drops it reports "no keystrokes" for code that sent seven.
    KeyboardEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
    new Function(...Object.keys(globals), read(file))(...Object.values(globals));
  }
  return { window, nodes };
}

const WORKDAY_SECTIONS = [
  { tag: "h4", text: "Work Experience" },
  { tag: "button", text: "Add" },
  { tag: "h4", text: "Education" },
  { tag: "button", text: "Add" },
  { tag: "h4", text: "Skills" },
];

test("an Add button belongs to the heading above it", () => {
  const { window, nodes } = installSections(WORKDAY_SECTIONS);
  const { sectionAddButton } = window.HIRECRAFT_FILL;

  assert.equal(sectionAddButton(/\bwork\s*experience\b/), nodes[1], "the first Add is the job one");
  assert.equal(sectionAddButton(/\b(education|school|degree)\b/), nodes[3], "the second is education");
});

test("a section with no Add button of its own does not borrow one", () => {
  // Skills is last and has no Add. Reaching back for Education's would open an
  // education block while filling skills, which is worse than doing nothing.
  const { window } = installSections(WORKDAY_SECTIONS);
  assert.equal(window.HIRECRAFT_FILL.sectionAddButton(/\bskills\b/), null);
});

test("a button that says Add Another Education names itself", () => {
  // Greenhouse and Ashby put the words on the button, with no heading to read.
  const { window, nodes } = installSections([
    { tag: "button", text: "+ Add Another Education" },
  ]);
  assert.equal(window.HIRECRAFT_FILL.addEducationButton(), nodes[0]);
});

test("Submit is never an Add button, whatever heading precedes it", () => {
  const { window } = installSections([
    { tag: "h4", text: "Education" },
    { tag: "button", text: "Save and Continue" },
  ]);
  assert.equal(window.HIRECRAFT_FILL.sectionAddButton(/\beducation\b/), null);
});

test("a file the page has accepted is not a required box left empty", () => {
  // Workday uploads immediately and clears the input so you can add another,
  // then says "MHR_AIML.pdf successfully uploaded" and shows a Delete button.
  // The résumé was attached, accepted, and still reported as missing.
  const { window, inputs } = installUploads([
    { sectionText: "Resume/CV MHR_AIML.pdf Delete MHR_AIML.pdf Successfully uploaded" },
  ]);
  assert.equal(window.HIRECRAFT_FILL.attachedNearby(inputs[0]), true);

  const empty = installUploads([{ sectionText: "Resume/CV Select files Drop files here" }]);
  assert.equal(empty.window.HIRECRAFT_FILL.attachedNearby(empty.inputs[0]), false);
});

test("a widget wrapped around a plain box is driven as a plain box", () => {
  // Workday's date fields are a div per segment with the real input inside it.
  // searchBoxFor started at the parent, which holds the month box *and* the
  // year box, so two candidates came back, the ambiguity rule refused both, and
  // all four dates on a work-experience block reported "nothing to type into".
  const month = {
    tagName: "INPUT", id: "workExperience-8--startDate-dateSectionMonth-input",
    className: "", value: "", disabled: false, readOnly: false,
    getAttribute: (n) => (n === "aria-label" ? "Month" : null),
    hasAttribute: () => false, getBoundingClientRect: rect(40, 30),
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: () => {}, focus() {},
  };
  const year = { ...month, id: "workExperience-8--startDate-dateSectionYear-input" };
  const monthWrapper = {
    tagName: "DIV", id: "workExperience-8--startDate-dateSectionMonth", className: "",
    getAttribute: (n) => (n === "aria-haspopup" ? "listbox" : null),
    hasAttribute: (n) => n === "aria-haspopup",
    getBoundingClientRect: rect(60, 34),
    querySelector: () => month,
    querySelectorAll: (sel) => (/input|textarea/.test(sel) ? [month] : []),
    closest: () => null, dispatchEvent: () => {}, focus() {},
  };
  // The parent holds both segments — the shape that defeated the old walk.
  const group = {
    tagName: "DIV", id: "workExperience-8--startDate", className: "",
    textContent: "From* MM / YYYY",
    getAttribute: () => null,
    querySelector: () => month,
    querySelectorAll: (sel) => (/input|textarea/.test(sel) ? [month, year] : []),
    parentElement: null, closest: () => null,
  };
  monthWrapper.parentElement = group;
  month.parentElement = monthWrapper;

  const { window } = installWorkday();
  assert.equal(
    window.HIRECRAFT_FILL.searchBoxFor(monthWrapper),
    month,
    "the box inside the widget, not the pair beside it"
  );
});

test("a month goes in as digits where the box asks for digits", () => {
  // A dropdown of month names wants "May". A segmented date field wants "05"
  // and says so — "MM / YYYY" beside it. Sending the name types nothing at all:
  // the field rejects what it cannot parse, so the failure arrives as an empty
  // date rather than as an error.
  const { window } = installWorkday();
  const { setValue } = window.HIRECRAFT_FILL;
  assert.ok(setValue);

  const box = (attrs, parentText) => {
    const parent = {
      tagName: "DIV", textContent: parentText, getAttribute: () => null,
      querySelector: () => null, querySelectorAll: () => [], parentElement: null,
    };
    return {
      tagName: "INPUT", id: "", className: "", value: "",
      getAttribute: (n) => attrs[n] ?? null,
      hasAttribute: (n) => attrs[n] != null,
      getBoundingClientRect: rect(40, 30),
      parentElement: parent, closest: () => null,
      querySelector: () => null, querySelectorAll: () => [], dispatchEvent: () => {},
    };
  };

  const digits = window.HIRECRAFT_FILL.wantsDigits;
  assert.equal(digits(box({ placeholder: "MM" }, "")), true);
  assert.equal(digits(box({ maxlength: "2" }, "")), true);
  assert.equal(digits(box({}, "From* current value is MM/YYYY MM / YYYY")), true);
  // A month dropdown says nothing of the kind, and must keep the name.
  assert.equal(digits(box({ "aria-label": "Graduation month" }, "Graduation Month")), false);

  assert.equal(window.HIRECRAFT_FILL.asDigits("May"), "05");
  assert.equal(window.HIRECRAFT_FILL.asDigits("December"), "12");
  assert.equal(window.HIRECRAFT_FILL.asDigits("Sept"), "09");
  // Anything that is not a month is left exactly as it was.
  assert.equal(window.HIRECRAFT_FILL.asDigits("2026"), "2026");
});

test("a dropdown's own prompt is not part of the question it asks", () => {
  // Workday builds an accessible name out of the question and its current
  // state: "Degree Select One Required". The question is "Degree", and the
  // catalogue asks for exactly that — so Degree matched nothing and stayed
  // empty on both education blocks, on a form that marks it required.
  const { window } = installWorkday();
  const { withoutPrompt, normalise } = window.HIRECRAFT_FILL;
  const FIELDS = window.HIRECRAFT_FIELDS;

  // Normalised first, then de-prompted — the order the scan uses, and it
  // matters: the prompt is only at the end once "Required" has been taken off.
  const keyFor = (label) => {
    const norm = withoutPrompt(normalise(label));
    return FIELDS.find((f) => f.match.some((re) => re.test(norm)))?.key;
  };
  assert.equal(keyFor("Degree Select One Required"), "degree");
  assert.equal(keyFor("Degree Select One"), "degree");
  assert.equal(keyFor("State Select One"), "state");
  // A question that merely contains the word is left alone.
  assert.equal(withoutPrompt("Select your highest degree"), "Select your highest degree");
  assert.equal(withoutPrompt("Degree"), "Degree");
});

test("adding a second block does not rewrite the first", () => {
  // The one that put a wrong answer on a real application. Adding the second
  // degree made Workday re-render the first, so its School box came back as a
  // *different node*, matched nothing in the before-set, counted as new, and was
  // written over: the finished form said RV College where it should have said
  // USC. Both blocks then named the same school — not an empty field anyone
  // would notice, but a wrong answer that reads as a filled one.
  const { window } = installWorkday();
  const { oneEach, normalise, withoutPrompt } = window.HIRECRAFT_FILL;

  const seen = (label) => withoutPrompt(normalise(label));
  const own = oneEach(
    [
      { el: "education-6--schoolName", label: seen("School or University*") },
      { el: "education-7--schoolName", label: seen("School or University*") },
      { el: "education-7--fieldOfStudy", label: seen("Field of Study") },
      { el: "education-7--degree", label: seen("Degree Select One Required") },
    ],
    window.HIRECRAFT_FIELDS
  );

  assert.equal(own.size, 3, "three questions, not four controls");
  assert.equal(
    own.get("school").el,
    "education-7--schoolName",
    "the new block's box, not the re-rendered old one"
  );
  assert.equal(own.get("field_of_study").el, "education-7--fieldOfStudy");
  assert.equal(own.get("degree").el, "education-7--degree", "and Degree is reachable at all now");
});

test("a job block's questions are read from the job list, not the main one", () => {
  const { window } = installWorkday();
  const { oneEach, normalise, withoutPrompt } = window.HIRECRAFT_FILL;
  const seen = (label) => withoutPrompt(normalise(label));

  const rows = [
    { el: "jobTitle", label: seen("Job Title*") },
    { el: "companyName", label: seen("Company*") },
    { el: "location", label: seen("Location") },
  ];
  const asJob = oneEach(rows, window.HIRECRAFT_EXPERIENCE_FIELDS);
  assert.deepEqual([...asJob.keys()].sort(), ["employer", "job_location", "job_title"]);

  // The same three rows through the main catalogue answer almost nothing —
  // which is the point of keeping the two lists apart.
  const asForm = oneEach(rows, window.HIRECRAFT_FIELDS);
  assert.deepEqual([...asForm.keys()], ["location"]);
});

test("once a section holds a block, its Add Another is still found", () => {
  // The heading rule works while the heading is still in front of the button.
  // Once a section holds a block the button moves inside it and reads "Add
  // Another" — so the second and third jobs on a résumé were never added, and
  // the report said nothing at all, because returning false is silent.
  //
  // The block names its own section: its text starts "Work Experience 1 Delete
  // Job Title…". So the fallback is the nearest ancestor that says which
  // section this is.
  const window = {};
  const mk = (tag, text, extra = {}) => ({
    tagName: tag.toUpperCase(), id: "", className: "", innerText: text, textContent: text,
    getAttribute: () => null, hasAttribute: () => false,
    getBoundingClientRect: rect(120, 40), closest: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: () => {}, click() {}, parentElement: null, ...extra,
  });

  // One block per section, each with its own Add Another inside it — and the
  // page heading is now "My Experience", which names neither section.
  const jobAdd = mk("button", "Add Another");
  const eduAdd = mk("button", "Add Another");
  const jobBlock = mk("div", "Work Experience 1 Delete Job Title* Company* Location");
  const eduBlock = mk("div", "Education 1 Delete School or University* Degree*");
  const step = mk("div", "My Experience Work Experience 1 ... Education 1 ...");
  jobAdd.parentElement = jobBlock;
  eduAdd.parentElement = eduBlock;
  jobBlock.parentElement = step;
  eduBlock.parentElement = step;

  const nodes = [mk("h3", "My Experience"), jobAdd, eduAdd];
  const globals = {
    window,
    document: {
      querySelectorAll: (sel) => (/h1|heading|button/.test(sel) ? nodes : []),
      querySelector: () => null, getElementById: () => null,
    },
    CSS: { escape: (x) => x },
    Event: class { constructor(t) { this.type = t; } },
    MouseEvent: class { constructor(t) { this.type = t; } },
    KeyboardEvent: class { constructor(t, init) { this.type = t; Object.assign(this, init); } },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
    new Function(...Object.keys(globals), read(file))(...Object.values(globals));
  }
  const { sectionAddButton } = window.HIRECRAFT_FILL;

  assert.equal(sectionAddButton(/\bwork\s*experience\b/), jobAdd, "the job section's own button");
  assert.equal(sectionAddButton(/\b(education|school|degree)\b/), eduAdd, "and education's own");
  // Nearest, not any: the container holding the whole step names both sections,
  // and reaching that far would offer Education's button for a job.
  assert.equal(sectionAddButton(/\bcertifications?\b/), null, "a section with no button gets none");
});

test("a search box is typed into, not assigned to", () => {
  // setValue puts the whole string in at once, which is right for a box that
  // holds an answer and wrong for one that runs a search. A field that builds
  // its query from keystrokes sees one synthetic keydown carrying the last
  // letter of the word and searches for that.
  const keys = [];
  const values = [];
  const box = {
    tagName: "INPUT", id: "", className: "", value: "",
    getAttribute: () => null, hasAttribute: () => false,
    getBoundingClientRect: rect(200, 30), closest: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: (e) => {
      if (e.type === "keydown") keys.push(e.key);
      if (e.type === "input") values.push(box.value);
    },
    focus() {},
  };
  const { window } = installWorkday();
  return window.HIRECRAFT_FILL.typeText(box, "PyTorch").then(() => {
    assert.equal(keys.join(""), "PyTorch", "one keystroke per character");
    assert.deepEqual(
      values.slice(-3),
      ["PyTor", "PyTorc", "PyTorch"],
      "and the value grows under them, for a field that reads the value instead"
    );
  });
});

test("the icon beside a box counts as a way to open it", () => {
  // Workday's skills field opens from its promptIcon and not from the input:
  // clicking the box did nothing, and twenty skills in a row reported a
  // dropdown that never opened while no menu existed anywhere on the page.
  const icon = {
    tagName: "SPAN", className: "menu-icon css-gvnnq4", id: "",
    getAttribute: () => null, getBoundingClientRect: rect(16, 16),
    querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: () => {}, click() {},
  };
  const shell = {
    tagName: "DIV", className: "", id: "", getAttribute: () => null,
    querySelector: (sel) => (/menu-icon|promptIcon|indicator/.test(sel) ? icon : null),
    querySelectorAll: () => [], parentElement: null,
  };
  const input = {
    tagName: "INPUT", id: "skills--skills", className: "", value: "",
    getAttribute: () => null, hasAttribute: () => false,
    getBoundingClientRect: rect(300, 34), closest: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: () => {}, focus() {}, parentElement: shell,
  };
  const { window } = installWorkday();
  assert.equal(window.HIRECRAFT_FILL.nearbyPromptIcon(input), icon);
  // An icon that is not on screen is not an affordance.
  icon.getBoundingClientRect = rect(0, 0);
  assert.equal(window.HIRECRAFT_FILL.nearbyPromptIcon(input), null);
});

test("a multi-select is filled without being shut between values", async () => {
  // The first version drove each skill through the single-value path: open,
  // type, pick, close — twenty times. That teardown is twenty presses of
  // Escape, twenty clicks on the control, twenty clicks on the page body and
  // twenty blurs, each landing on a field about to be typed into again.
  const escapes = [];
  const pills = [];
  const window = {};

  const row = (text) => ({
    tagName: "DIV", id: "", className: "", innerText: text, textContent: text,
    getAttribute: (n) => (n === "role" ? "option" : null),
    getBoundingClientRect: rect(180, 26),
    scrollIntoView() {}, dispatchEvent: () => {},
    click() { pills.push({ id: "", textContent: text }); box.value = ""; },
    parentElement: null,
  });
  const rows = [row("Python"), row("PyTorch"), row("Java")];

  const listbox = {
    tagName: "UL", id: "", className: "", parentElement: null,
    getAttribute: (n) => (n === "role" ? "listbox" : null),
    // Filtered by what has been typed, the way a search-backed list behaves.
    querySelectorAll: (sel) =>
      sel.includes("option")
        ? rows.filter((r) => r.innerText.toLowerCase().startsWith(box.value.toLowerCase()) && box.value)
        : [],
  };
  for (const r of rows) r.parentElement = listbox;

  const shell = {
    tagName: "DIV", id: "", className: "", getAttribute: () => null,
    querySelector: (sel) => (/pill|selectedItem|multi-value/.test(sel) ? (pills[0] ?? null) : null),
    querySelectorAll: (sel) => (/pill|selectedItem|multi-value/.test(sel) ? pills : []),
    parentElement: null,
  };
  const box = {
    tagName: "INPUT", id: "skills--skills", className: "", value: "",
    disabled: false, readOnly: false, parentElement: shell,
    getAttribute: (n) => (n === "aria-label" ? "Type to Add Skills" : null),
    hasAttribute: () => false, getBoundingClientRect: rect(300, 34),
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    // Escape is the first thing closeListbox tries, so counting it counts the
    // teardowns — blurs would not, since closing stops at whatever works.
    dispatchEvent: (e) => { if (e.key === "Escape" && e.type === "keydown") escapes.push(1); },
    focus() {}, blur() {},
  };

  const globals = {
    window,
    document: {
      querySelectorAll: (sel) => {
        if (sel === '[role="listbox"]') return [listbox];
        if (sel.includes("promptOption") || sel === '[role="option"]') return rows;
        if (/input|select|textarea/.test(sel)) return [box];
        return [];
      },
      querySelector: () => null, getElementById: () => null, body: { dispatchEvent: () => {} },
    },
    CSS: { escape: (x) => x },
    Event: class { constructor(t) { this.type = t; } },
    MouseEvent: class { constructor(t) { this.type = t; } },
    KeyboardEvent: class { constructor(t, init) { this.type = t; Object.assign(this, init); } },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
    new Function(...Object.keys(globals), read(file))(...Object.values(globals));
  }

  const trace = [];
  const filled = [];
  await window.HIRECRAFT_FILL.fillSkills(["Python", "PyTorch", "Rust"], { trace, filled });

  const row_ = trace.find((t) => t.field === "skills");
  assert.equal(row_.outcome, "filled");
  assert.match(row_.got, /Python/);
  assert.match(row_.got, /PyTorch/);
  // Rust is not on this employer's list, which is a fact about the employer
  // rather than a failure — and the step says so instead of the whole run
  // reporting one guess for the lot.
  assert.ok(row_.steps.some((s) => s.typed === "Rust" && /not on the list|no suggestions/.test(s.why)));
  assert.equal(escapes.length, 1, "put away once at the end, not after every value");
});

test("a date segment is typed into, because it disbelieves what it is handed", async () => {
  // The report said filled and the box showed 05/2026, and Workday said "The
  // field From is required and must have a value" underneath it. The text was
  // in the DOM and the widget's own model had never heard of it: it builds that
  // model from keystrokes, and a value written straight in arrives without any.
  //
  // Nothing snapped back, which is what said this was not the usual
  // controlled-component problem. A React input rejecting a write puts its old
  // value back; this one kept the text and disbelieved it.
  const keys = [];
  let blurred = false;
  const seg = {
    tagName: "INPUT", id: "workExperience-8--startDate-dateSectionMonth-input",
    className: "", value: "", disabled: false, readOnly: false,
    getAttribute: (n) => (n === "aria-label" ? "Month" : null),
    hasAttribute: () => false, getBoundingClientRect: rect(40, 30),
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: (e) => {
      if (e.type === "keydown") keys.push(e.key);
      if (e.type === "blur") blurred = true;
    },
    focus() {}, blur() {},
  };
  seg.parentElement = {
    tagName: "DIV", className: "", id: "", textContent: "From* MM / YYYY",
    getAttribute: () => null, querySelector: () => null, querySelectorAll: () => [],
    parentElement: null,
  };

  const { window } = installWorkday();
  const typed = await window.HIRECRAFT_FILL.setAndVerify(seg, "05", { type: true });

  assert.equal(typed.ok, true);
  assert.equal(seg.value, "05");
  assert.deepEqual(keys, ["0", "5"], "one keystroke per character");
  assert.equal(blurred, true, "and left, which is when such a widget commits");

  // The ordinary path stays a straight assignment — a six-hundred-character
  // role description typed one key at a time would take thirteen seconds.
  keys.length = 0;
  const plain = { ...seg, value: "" };
  await window.HIRECRAFT_FILL.setAndVerify(plain, "Sunbase Data");
  assert.deepEqual(keys, [], "nothing is typed when nothing asked for typing");
});

/**
 * Workday's Application Questions: three dropdowns in one wrapper, each named
 * only by its own state.
 */
function installQuestions() {
  const window = {};
  const label = (text) => ({
    tagName: "LABEL", id: "", className: "", innerText: text, textContent: text,
    getAttribute: () => null, querySelectorAll: () => [], contains: () => false,
    getBoundingClientRect: rect(300, 20),
  });
  const button = (text) => ({
    tagName: "BUTTON", id: "", className: "", innerText: "Select One", value: "",
    disabled: false, readOnly: false,
    getAttribute: (n) => (n === "aria-label" ? text : n === "aria-haspopup" ? "listbox" : null),
    hasAttribute: (n) => ["aria-label", "aria-haspopup"].includes(n),
    getBoundingClientRect: rect(300, 34),
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    dispatchEvent: () => {}, focus() {},
  });

  const labels = [
    label("Are you legally authorized to work in the United States?*"),
    label("Will you now or in the future, require sponsorship for employment status?*"),
    label("Solely for the purpose of determining if an export control license is needed, please indicate if you are currently a citizen of any of the following countries: Iran, Syria, N. Korea, Cuba, China or Russia.*"),
  ];
  const buttons = [button("Select One Required"), button("Select One Required"), button("Select One Required")];

  // One wrapper over all six, which is the shape that defeated the old rule.
  const wrap = {
    tagName: "DIV", id: "", className: "", getAttribute: () => null,
    querySelector: () => labels[0],
    querySelectorAll: (sel) => (/label|legend|question/.test(sel) ? labels : []),
    parentElement: null, contains: () => true,
  };
  const order = [labels[0], buttons[0], labels[1], buttons[1], labels[2], buttons[2]];
  for (const node of order) node.parentElement = wrap;
  // Document order, as compareDocumentPosition reports it: bit 2 means the
  // other node comes before this one.
  for (const node of order) {
    node.compareDocumentPosition = (other) => (order.indexOf(other) < order.indexOf(node) ? 2 : 4);
  }

  const globals = {
    window,
    document: {
      querySelectorAll: () => [],
      querySelector: () => null,
      getElementById: () => null,
    },
    CSS: { escape: (x) => x },
    Event: class { constructor(t) { this.type = t; } },
    MouseEvent: class { constructor(t) { this.type = t; } },
    KeyboardEvent: class { constructor(t, init) { this.type = t; Object.assign(this, init); } },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {}, HTMLSelectElement: class {},
    DataTransfer: class { constructor() { this.items = { add() {} }; this.files = []; } },
    setTimeout,
  };
  for (const file of ["autofill/options.js", "autofill/fields.js", "autofill/fill.js"]) {
    new Function(...Object.keys(globals), read(file))(...Object.values(globals));
  }
  return { window, buttons, labels };
}

test("a dropdown named only by its own state is named by its question instead", () => {
  // Workday gives these `aria-label="Select One Required"`. Taking that and
  // stopping left every question on the page called "Select One", which reduces
  // to nothing — so the scan dropped all three for having no label at all.
  //
  // On the education blocks the same attribute reads "Degree Select One
  // Required" and is exactly right, which is why this went unnoticed: the
  // attribute is sometimes the question and sometimes only the state.
  const { window, buttons } = installQuestions();
  const { labelFor } = window.HIRECRAFT_FILL;

  assert.match(labelFor(buttons[0]), /legally authorized/);
  assert.match(labelFor(buttons[1]), /require sponsorship/);
  assert.match(labelFor(buttons[2]), /export control/);
});

test("three questions in one wrapper get three different labels", () => {
  // Taking the first label in the container is only right when the container
  // holds one field. All three were named "Are you legally authorized…", the
  // first claimed that answer, and the other two were dropped as already
  // claimed — so two required questions were silently left blank.
  const { window, buttons } = installQuestions();
  const { labelFor, normalise, withoutPrompt } = window.HIRECRAFT_FILL;
  const FIELDS = window.HIRECRAFT_FIELDS;
  const SKIP = window.HIRECRAFT_SKIP;

  const keys = buttons.map((b) => {
    const label = withoutPrompt(normalise(labelFor(b)));
    if (SKIP.find((g) => g.match.some((re) => re.test(label)))) return "(skipped)";
    return FIELDS.find((f) => f.match.some((re) => re.test(label)))?.key;
  });
  assert.deepEqual(keys, ["authorized_to_work", "requires_sponsorship", "(skipped)"]);
});
