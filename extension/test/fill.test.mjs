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
    querySelectorAll: (sel) =>
      sel.includes("file") ? [] : sel.includes("listbox") ? [] : controls,
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
    KeyboardEvent: class { constructor(type) { this.type = type; } },
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
    querySelector: () => neighboursValue,
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
    KeyboardEvent: class { constructor(type) { this.type = type; } },
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
    KeyboardEvent: class { constructor(type) { this.type = type; } },
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
    KeyboardEvent: class { constructor(type) { this.type = type; } },
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
    KeyboardEvent: class { constructor(type) { this.type = type; } },
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
