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
function harness({ profile, letter = null } = {}) {
  const built = [];
  const sent = [];

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
    HIRECRAFT_FILL: { inspectForm: () => [], choiceCandidates: () => [], unclassified: () => [] },
    addEventListener() {},
  };

  const chrome = {
    runtime: {
      sendMessage: (message, cb) => {
        sent.push(message);
        cb?.({ ok: true, data: {} });
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
    navigator: { clipboard: { writeText: async () => {} } },
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
    "\n;window.__panel = { renderPanel, state, runCoverLetter, guarded };";
  new Function(...Object.keys(globals), source)(...Object.values(globals));

  Object.assign(window.__panel.state, { profile, letter });
  return { window, built, sent, render: () => window.__panel.renderPanel() };
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
