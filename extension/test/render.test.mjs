/**
 * Actually rendering the panel.
 *
 * Every other panel test reads the source, which catches a control that was
 * deleted and cannot catch a control that is built but never reached. Four
 * rounds went by on "the cover letter does nothing" with me reading a
 * diagnostics dump that never contained the letter, then reading the source and
 * reasoning about it. Neither is looking.
 *
 * So this builds a DOM stub, loads the content script into it, renders the
 * panel and inspects what came out — the same discipline that finally sorted
 * out the fill engine.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** A DOM node with just enough surface for the panel to be built. */
function node(tag = "div") {
  const self = {
    tagName: String(tag).toUpperCase(),
    className: "",
    textContent: "",
    id: "",
    value: "",
    children: [],
    style: {},
    dataset: {},
    append(...kids) {
      for (const kid of kids) if (kid) self.children.push(kid);
    },
    appendChild(kid) {
      self.append(kid);
    },
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    scrollIntoView() {},
    focus() {},
    blur() {},
    click() {},
    dispatchEvent() {},
    set innerHTML(_) {},
    get innerText() {
      return self.textContent;
    },
  };
  return self;
}

/** Every node built during a render, so the result can be searched. */
function harness({ profile, letter = null, fill = {}, reply = null } = {}) {
  const built = [];
  const sent = [];
  const copied = [];
  const listeners = {};

  const document = {
    createElement(tag) {
      const made = node(tag);
      built.push(made);
      return made;
    },
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: node("body"),
    title: "Software Engineer, Data Platform at Vercel",
  };

  const window = {
    HIRECRAFT_VISA: { classifyVisa: () => null, visaLabel: () => ({}), pageText: () => "a job" },
    HIRECRAFT_SUBMISSION: { isConfirmationUrl: () => false, isConfirmationText: () => false },
    HIRECRAFT_POSTING: { companyFrom: () => "Vercel", roleFromTitle: () => "SWE", clean: (s) => s },
    HIRECRAFT_FILL: {
      BUILD: "test",
      inspectForm: () => [],
      choiceCandidates: () => [],
      unclassified: () => [],
      fillForm: async () => ({ filled: [], missing: [], skipped: [], required: [], trace: [] }),
      ...fill,
    },
    HIRECRAFT_ADAPTER: { overrides: {} },
    // The panel sorts rows into cards by what each question is about.
    HIRECRAFT_GROUPS: [
      { id: "personal", title: "Personal information" },
      { id: "education", title: "Education" },
      { id: "details", title: "Application details" },
    ],
    HIRECRAFT_GROUP_FOR: (label) => (/name|email|phone/i.test(label) ? "personal" : "details"),
    // Kept rather than dropped, so a test can fire one. A stub that swallows
    // every listener cannot exercise anything that reacts to the page.
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
  };

  const chrome = {
    runtime: {
      // A live runtime has an id; a severed one does not, which is how the
      // script tells a working page from one left behind by an extension
      // reload. A stub without it reports every page as disconnected.
      id: "hirecraft-test",
      sendMessage: (message, cb) => {
        sent.push(message);
        cb?.(reply?.(message) ?? { ok: true, data: {} });
      },
      lastError: null,
    },
    storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
  };

  const globals = {
    window,
    document,
    chrome,
    location: { href: "https://job-boards.greenhouse.io/vercel/jobs/1", hostname: "job-boards.greenhouse.io", pathname: "/vercel/jobs/1", origin: "https://job-boards.greenhouse.io" },
    history: { pushState() {}, replaceState() {} },
    navigator: { clipboard: { writeText: async (text) => void copied.push(text) } },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => fn(),
    setTimeout,
    Event: class { constructor(type) { this.type = type; } },
    HTMLFormElement: class {},
    console: { debug() {}, log() {}, warn() {}, error() {} },
  };

  // The script exports nothing, so the test asks it to.
  const source =
    readFileSync(join(here, "..", "content.js"), "utf8") +
    "\n;window.__panel = { renderPanel, state, runCoverLetter, guarded, noteError, fillOnce, watchForStepChange };";
  new Function(...Object.keys(globals), source)(...Object.values(globals));

  Object.assign(window.__panel.state, { profile, letter });
  return {
    window, built, sent, copied, listeners,
    location: globals.location,
    render: () => window.__panel.renderPanel(),
  };
}

const PROFILE = {
  resumes: [{ id: "u1", name: "MHR_AIML", is_default: true }],
  local_resumes: [{ id: "l1", name: "MHR_Vercel", folder: "Vercel" }],
};

const find = (built, text) => built.find((n) => n.textContent === text);

test("the cover-letter checkbox is built", () => {
  const { built, render } = harness({ profile: PROFILE });
  render();
  assert.ok(find(built, "Also draft a cover letter"), "the label should be on the panel");
  assert.ok(
    built.some((n) => n.tagName === "INPUT" && n.type === "checkbox"),
    "and an actual checkbox beside it"
  );
});

test("ticking it records the choice without spending anything", () => {
  // The over-correction it replaced: the tick itself made the call, so simply
  // choosing the option cost money before Fill had been pressed.
  const { window, built, render, sent } = harness({ profile: PROFILE });
  render();
  const box = built.find((n) => n.tagName === "INPUT" && n.type === "checkbox");
  assert.ok(box?.onchange, "the checkbox needs a handler");

  const before = sent.length;
  box.onchange({ target: { checked: true } });

  assert.equal(window.__panel.state.wantCoverLetter, true, "the choice is recorded");
  assert.equal(
    sent.filter((m) => m.type === "coverLetter").length,
    0,
    "and nothing was drafted yet"
  );
  assert.ok(sent.length >= before);
});

test("a drafted letter renders with its feedback box and attach button", () => {
  const { built, render } = harness({
    profile: PROFILE,
    letter: {
      paragraphs: ["First paragraph.", "Second paragraph."],
      greeting: "Dear Vercel,",
      signature: "Mohammad Hasnain Raza",
      tells: [],
      uniformity: 0.1,
      pdf: "data:application/pdf;base64,AAAA",
      company: "Vercel",
    },
  });
  render();
  assert.ok(find(built, "Rewrite with this"), "somewhere to act on a note");
  assert.ok(find(built, "Attach to form"), "and attaching stays a separate click");
  assert.ok(find(built, "Download PDF"));
  assert.ok(
    built.some((n) => n.tagName === "TEXTAREA"),
    "with a box to write the note in"
  );
});

test("the panel still builds with no résumés at all", () => {
  // A new account, before anything is uploaded.
  const { render } = harness({ profile: { resumes: [], local_resumes: [] } });
  assert.doesNotThrow(render);
});

test("a failed draft is remembered, not just flashed", () => {
  // "Nothing happened" is the least diagnosable report there is, and a status
  // line is gone by the time anyone asks.
  const source = readFileSync(join(here, "..", "content.js"), "utf8");
  assert.match(source, /state\.letterError = reply\.error/, "the reason is kept");
  assert.match(source, /coverLetter: \{/, "and travels with the diagnostics");
  assert.match(source, /build: PANEL_BUILD/, "alongside which build produced them");
});

test("a failing action costs one action, not the session", async () => {
  // The stuck panel. Each action set `busy`, which disables every control, and
  // cleared it on the paths that reached the end — so a throw in between left
  // everything greyed with nothing to say. The engine reaches into pages nobody
  // has seen, so a throw is the ordinary way an unfamiliar form goes wrong.
  const { window } = harness({ profile: PROFILE });
  const { guarded, state } = window.__panel;

  await guarded("Fill", async () => {
    throw new Error("this page is unlike the others");
  });

  assert.equal(state.busy, false, "the panel has to come back");
  assert.match(state.status, /Fill failed/, "and say what happened");
  assert.match(state.status, /unlike the others/);
});

test("an action already running is not started twice", async () => {
  const { window } = harness({ profile: PROFILE });
  const { guarded, state } = window.__panel;

  let runs = 0;
  const slow = () => new Promise((resolve) => setTimeout(() => { runs += 1; resolve(); }, 30));
  const first = guarded("Fill", slow);
  await guarded("Fill", slow);   // while the first is still going
  await first;

  assert.equal(runs, 1, "a second press while busy does nothing");
  assert.equal(state.busy, false);
});

test("a failure can be copied, not only read", async () => {
  // The diagnostics used to hang off a report, so the run that failed outright
  // produced nothing to paste — and the only account of it left anywhere was an
  // entry in Chrome's error log, by then pointing at a line that had moved.
  const { window, built, copied, render } = harness({ profile: PROFILE });
  const { guarded } = window.__panel;

  await guarded("Fill", async () => {
    throw new Error("this page is unlike the others");
  });
  render();

  const diag = built.find((n) => n.textContent === "Copy diagnostics");
  assert.ok(diag, "with no report at all, there is still something to copy");
  await diag.onclick();

  const dump = JSON.parse(copied.at(-1));
  assert.equal(dump.errors.length, 1);
  assert.equal(dump.errors[0].message, "this page is unlike the others");
  assert.equal(dump.errors[0].where, "Fill");
  assert.ok(dump.build, "stamped with the panel that produced it");
  assert.equal(dump.engine, "test", "and with the engine, which ships separately");
});

test("one broken section does not cost the whole dump", async () => {
  // Building the dump is the one thing that has to work: it is how a page
  // nobody has seen gets diagnosed. A section that threw took the rest with it,
  // and pressing the button then looked like pressing nothing.
  const { window, built, copied, render } = harness({
    profile: PROFILE,
    fill: {
      inspectForm() {
        throw new Error("this form cannot be read");
      },
    },
  });
  Object.assign(window.__panel.state, {
    report: { filled: [], missing: [], skipped: [], required: [], trace: [] },
  });
  render();

  const diag = built.find((n) => n.textContent === "Copy diagnostics");
  await diag.onclick();

  const dump = JSON.parse(copied.at(-1));
  assert.match(dump.inspect.failed, /cannot be read/, "the broken section says so");
  assert.deepEqual(dump.choices, [], "and the others still came through");
  assert.deepEqual(dump.widgets, []);
  assert.ok(
    dump.errors.some((e) => e.where === "diagnostics: inspect"),
    "with the failure recorded rather than swallowed"
  );
});

test("a Career Profile edit reaches a page that is already open", async () => {
  // The panel read the profile on its first Fill and kept it for as long as the
  // tab stayed open. So the sequence anyone would actually perform — Fill, read
  // "no street address stored — add one in Career Profile", go and add one, come
  // back, Fill — gave the same message back, because the answer had been added
  // to a copy this page would never see again. A feature working correctly and
  // looking broken, which is worse than one that is broken.
  let stored = "";
  const { window, sent } = harness({
    profile: { resumes: [], local_resumes: [] },
    reply: (message) =>
      message.type === "profile"
        ? { ok: true, data: { resumes: [], local_resumes: [], address_line1: stored } }
        : { ok: true, data: {} },
  });

  await window.__panel.fillOnce();
  assert.equal(window.__panel.state.profile.address_line1, "");

  // The user goes and fills it in, then comes back to the same tab.
  stored = "3601 Trousdale Pkwy";
  await window.__panel.fillOnce();

  assert.equal(
    window.__panel.state.profile.address_line1,
    "3601 Trousdale Pkwy",
    "the second press must see what was added between them"
  );
  assert.equal(sent.filter((m) => m.type === "profile").length, 2, "asked once per press");
});

test("a profile that cannot be fetched falls back to the one we had", async () => {
  // Re-fetching on every press must not make a working panel depend on the API
  // being reachable at that instant.
  let up = true;
  const { window } = harness({
    profile: null,
    reply: (message) =>
      message.type !== "profile"
        ? { ok: true, data: {} }
        : up
          ? { ok: true, data: { resumes: [], local_resumes: [], phone: "555-0100" } }
          : { ok: false, error: "HireCraft is not running." },
  });

  await window.__panel.fillOnce();
  up = false;
  await window.__panel.fillOnce();

  assert.equal(window.__panel.state.profile.phone, "555-0100", "the last good copy stands");
  assert.doesNotMatch(window.__panel.state.status ?? "", /not running/);
});

/** A report big enough to need grouping, the way a real form produces one. */
const REPORT = {
  filled: [
    { label: "Full name", value: "Mohammad Hasnain Raza" },
    { label: "Email", value: "razam@usc.edu" },
    { label: "Phone", value: "(213) 994-5086" },
    { label: "School", value: "University of Southern California" },
    { label: "Degree", value: "Master's Degree" },
    { label: "Work authorization", value: "Yes" },
  ],
  missing: [{ label: "Why Applied Intuition?", why: "an essay question — yours to write" }],
  skipped: [],
  required: ["Why Applied Intuition?"],
  trace: [],
};

test("answers are grouped into cards rather than listed flat", () => {
  // Twenty-four rows of equal weight is a list nobody reads: the eye has no way
  // in, and the handful that need attention sit among two dozen that do not.
  const { window, built, render } = harness({ profile: PROFILE });
  Object.assign(window.__panel.state, { report: REPORT });
  render();

  assert.ok(find(built, "Personal information"), "a card per kind of question");
  assert.ok(find(built, "Application details"));
  // The first group is open, so its rows are on screen…
  assert.ok(find(built, "Full name"));
  // …and a shut one contributes a header without its rows.
  assert.equal(find(built, "Work authorization"), undefined, "a shut group shows no rows");
});

test("a group opens and shuts, and the choice sticks", () => {
  const { window, built, render } = harness({ profile: PROFILE });
  Object.assign(window.__panel.state, { report: REPORT });
  render();

  const head = built.find((n) => n.className === "hc-sec-head" && n.onclick);
  assert.ok(head, "each group's header is the control");
  head.onclick();
  assert.equal(
    window.__panel.state.sections.personal,
    false,
    "shutting the first group is remembered, not re-defaulted on the next render"
  );
});

test("what needs attention comes first inside its card", () => {
  // A group shows six rows before offering the rest. Burying the one unanswered
  // question below that cut would hide it behind a card marked as needing
  // attention — the exact thing the marking is for.
  const { window, built, render } = harness({ profile: PROFILE });
  const many = {
    ...REPORT,
    filled: Array.from({ length: 9 }, (_, i) => ({ label: `Detail ${i}`, value: `v${i}` })),
    missing: [{ label: "Detail X", why: "nothing stored for this" }],
  };
  Object.assign(window.__panel.state, { report: many, sections: {} });
  render();

  assert.ok(find(built, "nothing stored for this"), "the unanswered one is on screen");
  assert.ok(find(built, "View all 10 fields"), "with the rest behind a control");
});

test("readiness counts what was filled against what was asked", () => {
  const { window, built, render } = harness({ profile: PROFILE });
  Object.assign(window.__panel.state, { report: REPORT });
  render();

  // Six filled, one required question still open — so seven things the form
  // wants, six done. "6 of 6" beside "1 required" said full and not-done at
  // once, which is the shape the ring used to have.
  assert.ok(find(built, "Almost there"), "the headline says where this stands");
  assert.ok(find(built, "6 filled"), "what went in");
  assert.ok(find(built, "1 still required"), "and what will bounce the form");
  assert.ok(find(built, "of 7"), "the ring counts the outstanding question into its total");
  assert.ok(find(built, "Needs your input"), "with the questions themselves in their own card");
});

test("before a fill there is nothing to be ready about", () => {
  // The panel opens onto this, and a readiness ring reading "0 of 0" would be
  // an answer to a question nobody has asked yet.
  const { built, render } = harness({ profile: PROFILE });
  render();
  assert.equal(find(built, "Application readiness"), undefined);
  assert.ok(find(built, "Fill this form"), "just the thing to press");
});

test("moving to the next step clears the last one's report", () => {
  // An application is six pages on Workday and the panel outlives all of them.
  // The report from the step before stayed on screen saying thirty-eight fields
  // were filled — none of them on the page being looked at. A report describing
  // a form the reader is not in front of answers the question they came to ask
  // with yesterday's answer.
  const { window, listeners, location } = harness({ profile: PROFILE });
  const { state, watchForStepChange } = window.__panel;
  Object.assign(state, {
    report: REPORT,
    status: "Filled 6 fields",
    letter: { paragraphs: ["kept"] },
    resumeId: "u1",
  });
  watchForStepChange();

  location.href = "https://x.myworkdayjobs.com/apply/4";
  for (const fn of listeners.popstate ?? []) fn();

  assert.equal(state.report, null, "the last step's report goes");
  assert.equal(state.status, "");
  // These are about this application, not this page.
  assert.ok(state.letter, "a drafted letter survives the step change");
  assert.equal(state.resumeId, "u1", "and so does the résumé you picked");
});

test("nothing in the scrolling body is allowed to shrink", () => {
  // A column flex container hands its children flex-shrink: 1, so once the
  // content was taller than the panel they compressed instead of scrolling —
  // and overflow-y: auto does not stop it, because shrinking happens first.
  // The cards holding something of a fixed size survived; the ones made only of
  // text rows collapsed to their own borders, so a report of seven filled
  // fields showed as two thin lines on the page.
  //
  // A screenshot at 1400px looked perfect and one at 900px found it at once,
  // which is the whole argument for taking the screenshot at a real size.
  const css = readFileSync(join(here, "..", "content.css"), "utf8");
  assert.match(css, /\.hc-body > \* \{ flex: 0 0 auto; \}/);
});

test("a long label wraps rather than widening the panel", () => {
  // A skipped question carries the question itself as its label — "Have you
  // previously worked for NVIDIA as an employee or contractor?" — and the label
  // was flex: 0 0 auto. A label that can neither shrink nor wrap makes its row
  // as wide as its text, the row makes the card, and the card made the whole
  // 348px panel scroll sideways.
  const css = readFileSync(join(here, "..", "content.css"), "utf8");
  assert.match(css, /\.hc-row \{[^}]*flex-wrap: wrap;/s, "the row wraps");
  assert.match(css, /\.hc-label \{[^}]*flex: 0 1 auto;/s, "and the label may shrink");
  assert.match(css, /\.hc-label \{[^}]*overflow-wrap: anywhere;/s);
  assert.match(css, /\.hc-body \{[^}]*overflow-x: hidden;/s, "sideways is never the answer here");
});

test("a page cut off from the extension says so, instead of throwing", async () => {
  // Reloading an extension leaves every content script already in a page
  // running, but severs it: chrome.runtime goes undefined, or survives with no
  // id and throws on use. The script cannot reconnect — only a page reload gets
  // a fresh one — so it surfaced as "Cannot read properties of undefined
  // (reading 'sendMessage')", which names the line and not the problem.
  //
  // It is the ordinary consequence of installing an update, which is why it
  // came up on nearly every page this was tested on.
  const { window, built, render } = harness({ profile: PROFILE });
  // What Chrome leaves behind: the object survives, the id does not.
  delete window.__panel.chrome;
  Object.assign(window.__panel.state, { disconnected: true });
  render();

  assert.ok(find(built, "Disconnected from HireCraft"), "the panel names it");
  const again = find(built, "Reload this page");
  assert.ok(again?.onclick, "and offers the one thing that fixes it");
});

test("the message names the fix rather than the line", () => {
  const source = readFileSync(join(here, "..", "content.js"), "utf8");
  assert.match(source, /HireCraft was updated — reload this page to reconnect\./);
  // Both shapes of the severance: the throw, and the lastError.
  assert.match(source, /context invalidated\|receiving end does not exist/);
  assert.match(source, /function disconnected\(\)/);
});
