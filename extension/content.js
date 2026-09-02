/**
 * The on-page HireCraft launcher: a logo that opens the fill panel.
 *
 * Sits collapsed as the app's own mark until you want it, because an
 * application form is long and a panel parked over it is in the way for the
 * ninety per cent of the time you are reading rather than filling.
 *
 * Only ever fills. It never clicks submit and never touches a CAPTCHA — Lever's
 * apply form carries an hCaptcha, and more to the point an application cannot be
 * un-sent, so the last action stays a deliberate human one.
 */

const ROOT_ID = "hirecraft-root";

/**
 * Which build of this script is running in the page.
 *
 * A content script keeps running in already-open tabs after the extension is
 * reloaded, so "I changed it and it still misbehaves" and "the page is running
 * last week's copy" look identical from here. Four rounds went by on that
 * ambiguity. This ends it: a diagnostics dump either carries this string or it
 * came from a stale script.
 */
const PANEL_BUILD = "2026-09-02.cards-stop-collapsing";

/** The app's own logo, inline so it stays crisp at any size. */
const LOGO_SVG = `
<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <defs>
    <linearGradient id="hc-g" x1="6" y1="6" x2="40" y2="42" gradientUnits="userSpaceOnUse">
      <stop stop-color="#7C4DFF"/><stop offset="1" stop-color="#4CC9F0"/>
    </linearGradient>
  </defs>
  <rect x="9" y="6.5" width="7.6" height="35" rx="3.8" fill="url(#hc-g)"/>
  <path d="M12.8 25.5 C 12.8 19.5, 18.2 16.6, 23.8 16.6 C 30.2 16.6, 33.4 21, 33.4 27 L 33.4 37.7"
        stroke="url(#hc-g)" stroke-width="7.6" stroke-linecap="round" fill="none"/>
  <path d="M37.5 7 C 37.9 10.3 39.2 11.6 42.5 12 C 39.2 12.4 37.9 13.7 37.5 17 C 37.1 13.7 35.8 12.4 32.5 12 C 35.8 11.6 37.1 10.3 37.5 7 Z"
        fill="#B98CFF"/>
</svg>`;

const state = {
  open: false,
  /** {verdict, evidence} from reading this page's posting text. */
  visa: null,
  busy: false,
  status: "",
  report: null,
  /** The tracker stage this application is at, as far as we know. */
  stage: null,
  profile: null,
  /** Which résumé to attach — chosen before filling, not assumed. */
  resumeId: null,
  /** What the picked résumé is called, for a file that has no row here. */
  resumeName: null,
  wantCoverLetter: false,
  letter: null,
  /** What to change about the draft, before asking for it again. */
  letterFeedback: "",
  /** Why the last draft failed, if it did. */
  letterError: null,
  /** Whatever has gone wrong, kept where a diagnostics dump can reach it. */
  errors: [],
  /**
   * Which groups of answers are open, by id.
   *
   * Empty means "the defaults": the first group with anything in it. An entry
   * only appears here once somebody has opened or shut something themselves,
   * so a choice made on one form survives the re-render after the next field
   * is filled.
   */
  sections: {},
};

/**
 * Keep what went wrong, rather than letting it fall into Chrome's error log.
 *
 * That log is the wrong place for these, and this session has now spent two
 * rounds proving it. It retains entries across reloads, so something fixed a
 * week ago still sits at the top of the list looking current. It identifies a
 * failure by a line number in a file that moves under it, so an entry can end
 * up pointing at what is now a closing brace — which nobody can diagnose,
 * including me. And it separates the failure from the run it belonged to.
 *
 * So they are kept here instead: the message, the function names rather than
 * the line, the build that produced them, and the page it happened on — and
 * they travel with the rest of the diagnostics.
 */
function noteError(where, error) {
  const entry = {
    where,
    build: PANEL_BUILD,
    message: error?.message || String(error),
    // Function names, not line numbers. A name still means something after the
    // next edit; a line number means something else entirely.
    at: String(error?.stack || "")
      .split("\n")
      .slice(1, 4)
      .map((line) => line.trim().replace(/^at\s+/, "").replace(/chrome-extension:\/\/[a-z]+\//, ""))
      .filter(Boolean)
      .join(" ← "),
    url: location.href,
  };
  state.errors = [...state.errors, entry].slice(-5);
  console.error("[HireCraft]", where, error);
  return entry;
}

/**
 * Errors that pass through no awaited call, and so reach no catch.
 *
 * `guarded` covers the panel's three buttons and nothing else — not a timer,
 * not an observer, not a promise nobody awaited, which between them are most
 * of what this script does while it waits for a form to appear. Those surfaced
 * only in Chrome's log, stripped of which action they belonged to.
 *
 * Only ours are recorded. Workday's own console is a busy place, and one of a
 * page's own bugs reported as HireCraft's would send the next round looking in
 * the wrong file entirely.
 */
function watchForErrors() {
  const ours = (text) => /chrome-extension:\/\//.test(String(text || ""));
  window.addEventListener("error", (event) => {
    if (ours(event?.error?.stack) || ours(event?.filename)) {
      noteError("something outside an action", event.error || event.message);
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (ours(event?.reason?.stack)) noteError("an unawaited call", event.reason);
  });
}

function ask(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (reply) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(reply || { ok: false, error: "No response from HireCraft." });
    });
  });
}

/** Does this page actually have an application form worth offering to fill? */
function looksLikeApplicationForm() {
  if (document.querySelector('input[type="file"]')) return true;
  return (
    document.querySelectorAll(
      'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
    ).length >= 3
  );
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// --- rendering ---------------------------------------------------------------

/**
 * The mark on each group's header.
 *
 * Line icons rather than emoji. An emoji is somebody else's artwork at
 * somebody else's colour: it arrives full-colour into a restrained palette, it
 * is drawn differently on every platform, and at 14px most of them are a blob.
 * These inherit the panel's own colour and sit at the weight everything else
 * here is drawn at.
 */
const SECTION_ICONS = {
  personal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/></svg>`,
  education: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 9 12 4.5 21.5 9 12 13.5 2.5 9Z"/><path d="M6.5 11v4.6c0 1.3 2.5 2.4 5.5 2.4s5.5-1.1 5.5-2.4V11"/></svg>`,
  experience: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="7.5" width="18" height="12" rx="2.2"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3 12.5h18"/></svg>`,
  details: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3.5h9L19 8v12.5H6z"/><path d="M14.5 3.7V8H19M9 12h6M9 15.5h4"/></svg>`,
};

/** One answered — or unanswered — question, as a row. */
function fieldRow(cls, mark, label, value, extra) {
  const r = el("div", `hc-row ${cls}`);
  r.append(el("span", "hc-dot", mark), el("span", "hc-label", label));
  r.append(el("span", "hc-val", String(value)));
  if (extra) r.append(el("div", "hc-row-extra", extra));
  return r;
}

/**
 * A group of rows behind a header that can stay shut.
 *
 * Only the first is open by default. Twenty-four rows of equal weight is a list
 * nobody reads: the eye has no way in, and the handful that need attention sit
 * among two dozen that do not. A shut header still carries its count and its
 * tick, which is the part most people want — the detail is there for the times
 * it is wrong.
 */
function renderSection(group, rows) {
  const open = state.sections[group.id] ?? group.first;
  const box = el("div", `hc-sec${open ? " hc-sec-open" : ""}`);

  const head = el("button", "hc-sec-head");
  head.setAttribute("aria-expanded", String(open));
  head.onclick = () => {
    state.sections = { ...state.sections, [group.id]: !open };
    render();
  };
  const mark = el("span", "hc-sec-mark");
  mark.innerHTML = SECTION_ICONS[group.id] || SECTION_ICONS.details;
  head.append(mark);
  head.append(el("span", "hc-sec-title", group.title));

  // One glyph, not two. A blank span where a tick would go left a hole in the
  // header of every group that had something outstanding — which is the group
  // you most want to read cleanly.
  const unfilled = rows.filter((r) => r.kind !== "ok").length;
  head.append(el("span", "hc-sec-count", `${rows.length}`));
  head.append(
    unfilled
      ? el("span", "hc-sec-warn", String(unfilled))
      : el("span", "hc-sec-tick", "✓")
  );
  head.append(el("span", "hc-sec-chev", "▾"));
  box.append(head);

  if (!open) return box;

  const body = el("div", "hc-sec-body");
  // Whatever needs attention first, then what is done. A group shows six rows
  // before offering the rest, and burying the one unanswered question below
  // that cut would hide it behind a card marked as needing attention.
  const rank = { miss: 0, skip: 1, ok: 2 };
  const ordered = [...rows].sort((a, b) => rank[a.kind] - rank[b.kind]);
  // A long group shows a few and offers the rest, so one card cannot become
  // the flat list this exists to replace.
  const shown = state.sections[`${group.id}:all`] ? ordered : ordered.slice(0, 6);
  for (const r of shown) body.append(fieldRow(r.cls, r.mark, r.label, r.value, r.extra));
  if (ordered.length > shown.length) {
    const more = el("button", "hc-more", `View all ${rows.length} fields`);
    more.onclick = () => {
      state.sections = { ...state.sections, [`${group.id}:all`]: true };
      render();
    };
    body.append(more);
  }
  box.append(body);
  return box;
}

function renderPanel() {
  const panel = el("div", "hc-panel");

  const header = el("div", "hc-head");
  const brand = el("span", "hc-brand");
  const mark = el("span", "hc-head-mark");
  mark.innerHTML = LOGO_SVG;
  brand.append(mark, el("span", "hc-brand-text", "HireCraft"));
  header.append(brand);

  const tools = el("span", "hc-head-tools");
  const collapse = el("button", "hc-x", "—");
  collapse.title = "Collapse";
  collapse.setAttribute("aria-label", "Collapse HireCraft");
  collapse.onclick = () => {
    state.open = false;
    render();
  };
  tools.append(collapse);
  header.append(tools);
  panel.append(header);

  // The scrolling middle. The action area below it never scrolls away, because
  // a long report is exactly when the button is most wanted and hardest to
  // reach.
  const body = el("div", "hc-body");
  panel.append(body);

  // Built now, attached last. The résumé picker and the buttons belong to the
  // area that never scrolls, and they are written further down the file next to
  // the state they read.
  const foot = el("div", "hc-foot");

  // How much of this form is answered, before any of the detail. This is the
  // question someone opens the panel to ask, and it used to be a sentence in
  // the same weight as everything under it.
  if (state.report) {
    const { filled, missing } = state.report;
    const gaps = state.report.required ?? [];
    // What is still owed, counted once. A question can be both a field we could
    // not fill and a required box the form will bounce on, and counting it
    // twice would make the ring lie in the other direction.
    const owed = new Set([...missing.map((m) => m.label), ...gaps]);
    const done = filled.length;
    // The denominator is everything the form needs, not everything we managed.
    // "7 of 7" in amber beside "2 required" said two contradictory things at
    // once: full, and not done. Counting the outstanding questions into the
    // total makes the ring agree with its own colour.
    const total = done + owed.size;

    const ring = el("div", "hc-ring");
    const sweep = total ? Math.round((done / total) * 360) : 0;
    const colour = owed.size ? "#fbbf24" : "#4ade80";
    ring.style.background = `conic-gradient(${colour} ${sweep}deg, rgba(255,255,255,0.07) ${sweep}deg)`;

    const inner = el("div", "hc-ring-in");
    inner.append(el("div", "hc-ring-n", String(done)));
    inner.append(el("div", "hc-ring-of", total ? `of ${total}` : "fields"));
    ring.append(inner);

    const readyBody = el("div", "hc-ready-body");
    readyBody.append(
      el("div", "hc-ready-title", owed.size ? "Almost there" : "Ready to submit")
    );
    // The chips say what the ring cannot: which half is which. Neither repeats
    // the ring's own numbers, which is what made the old pair read as noise.
    const chips = el("div", "hc-chips");
    chips.append(el("span", "hc-chip hc-chip-good", `${done} filled`));
    if (gaps.length) {
      chips.append(
        el("span", "hc-chip hc-chip-warn", `${gaps.length} still required`)
      );
    }
    const others = owed.size - gaps.length;
    if (others > 0) {
      chips.append(el("span", "hc-chip hc-chip-warn", `${others} left for you`));
    }
    readyBody.append(chips);

    const ready = el("div", "hc-ready");
    ready.append(ring, readyBody);
    body.append(ready);
  }

  // The visa verdict, read from the posting on this page. Near the top because
  // it decides whether filling the form is worth doing at all.
  if (state.visa) {
    const { text, tone, blocks } = window.HIRECRAFT_VISA.visaLabel(state.visa.verdict);
    const box = el("div", `hc-visa hc-visa-${tone}`);
    box.append(el("span", "hc-visa-icon", tone === "ok" ? "✓" : tone === "bad" ? "✕" : "!"));
    const text_ = el("div", "hc-visa-text");
    text_.append(el("div", "hc-visa-head", text));
    if (state.visa.evidence) {
      text_.append(el("div", "hc-visa-why", `…${state.visa.evidence.slice(0, 190)}…`));
    } else if (!blocks) {
      text_.append(el("div", "hc-visa-why", "Worth confirming with the recruiter."));
    }
    box.append(text_);
    body.append(box);
  }

  if (state.status) body.append(el("div", "hc-status", state.status));

  if (state.report) {
    const { filled, missing, skipped } = state.report;
    // Sorted into cards by what each question is about, so the panel shows the
    // shape of the answer before any of the detail.
    const groupOf = window.HIRECRAFT_GROUP_FOR;
    const rows = new Map();
    const put = (label, row) => {
      const id = groupOf(label);
      if (!rows.has(id)) rows.set(id, []);
      rows.get(id).push(row);
    };
    for (const item of filled) {
      put(item.label, {
        kind: "ok", cls: "hc-ok", mark: "✓",
        label: item.label, value: item.value, extra: item.note,
      });
    }
    for (const item of missing) {
      // When a dropdown had no answer for us, show what it did offer — that is
      // the difference between "this failed" and knowing what to pick by hand.
      put(item.label, {
        kind: "miss", cls: "hc-miss", mark: "!",
        label: item.label, value: item.why,
        extra: item.offered?.length ? `offers: ${item.offered.join(" · ")}` : null,
      });
    }
    for (const item of skipped) {
      put(item.label, {
        kind: "skip", cls: "hc-skip", mark: "–",
        label: item.label, value: item.why,
      });
    }

    let first = true;
    for (const group of window.HIRECRAFT_GROUPS) {
      const mine = rows.get(group.id);
      if (!mine?.length) continue;
      body.append(renderSection({ ...group, first }, mine));
      first = false;
    }

    // Required questions the form still has no answer for. Its own card rather
    // than another row in a list: a filled-in form that will bounce on submit is
    // the failure this panel exists to prevent, and it is the one thing here you
    // have to act on before submitting.
    const gaps = state.report.required ?? [];
    if (gaps.length) {
      const needs = el("div", "hc-needs");
      needs.append(el("div", "hc-needs-head", "Needs your input"));
      const list = el("ul", "hc-needs-list");
      for (const label of gaps.slice(0, 6)) list.append(el("li", "hc-needs-item", label));
      needs.append(list);

      // Takes you to the question rather than describing it. The questions are
      // on the employer's page, not in this panel, so the useful action is to
      // put the first one in front of you.
      const go = el("button", "hc-btn hc-small", "Show me on the form");
      go.onclick = () => {
        const target = window.HIRECRAFT_FILL.gapDetails().find((gap) => gap.el)?.el;
        if (!target) {
          go.textContent = "Can't find it — scroll the form";
          return;
        }
        highlight(target);
      };
      const act = el("div", "hc-needs-act");
      act.append(go);
      needs.append(act);
      body.append(needs);
    }

    const note = el("div", "hc-note");
    note.append(el("span", "hc-visa-icon", "✓"));
    const noteText = el("div", "hc-visa-text");
    noteText.append(el("div", "hc-note-head", "Fields filled"));
    noteText.append(
      el("div", "hc-note-sub", "Nothing has been submitted. Check the form, then submit it yourself.")
    );
    note.append(noteText);
    body.append(note);
  }

  // What went wrong, on the panel rather than only in a log. An error from a
  // timer or an observer reaches no catch here and so never touched the status
  // line — the panel went on looking perfectly well while something had
  // failed, which is the least useful state it could be in.
  if (state.errors.length) {
    const box = el("div", "hc-required");
    const n = state.errors.length;
    box.append(el("div", "hc-required-head", `${n} error${n === 1 ? "" : "s"} — copy the diagnostics`));
    for (const entry of state.errors.slice(-3)) {
      box.append(el("div", "hc-required-item", `${entry.where}: ${entry.message}`));
    }
    body.append(box);
  }

  // Everything the fill actually did, as text you can paste. The panel's
  // summary says a field failed; this says which option list it read, where
  // that list came from, and what was on it — which is the difference between
  // reporting a bug and diagnosing one.
  //
  // Offered after a failure as well as after a fill. It used to appear only
  // beside a report, so the run that produced no report — the run there is most
  // to explain — was also the run with nothing to copy, and the only account of
  // it left anywhere was an entry in Chrome's error log.
  if (state.report || state.errors.length) {
    const diag = el("button", "hc-btn hc-small", "Copy diagnostics");
    diag.onclick = async () => {
      // Each section behind its own catch. Building the dump has to be the one
      // thing here that cannot fail, because it is how a page nobody has seen
      // gets diagnosed — and a single section throwing took the whole dump with
      // it, which from outside is a button that does nothing.
      const section = (name, read) => {
        try {
          return read();
        } catch (error) {
          return { failed: noteError(`diagnostics: ${name}`, error).message };
        }
      };
      const report = state.report || {};
      const dump = {
        url: location.href,
        // Both halves. They ship together and a tab keeps whichever pair it
        // opened with, so "which build was this" needs two answers, not one.
        build: PANEL_BUILD,
        engine: window.HIRECRAFT_FILL?.BUILD || "(engine did not load)",
        filled: report.filled ?? null,
        missing: report.missing ?? null,
        skipped: report.skipped ?? null,
        required: report.required ?? null,
        trace: report.trace ?? null,
        inspect: section("inspect", () => window.HIRECRAFT_FILL.inspectForm()),
        // Choice-shaped questions, which the scan above cannot represent.
        // Included so a form that asks yes/no with buttons rather than a
        // dropdown shows its real structure instead of vanishing.
        choices: section("choices", () => window.HIRECRAFT_FILL.choiceCandidates()),
        // Anything interactive the scan could not classify, so a control that
        // fits none of the shapes above still shows itself rather than
        // vanishing — which is how the date pickers hid for three runs.
        widgets: section("widgets", () => window.HIRECRAFT_FILL.unclassified()),
        // Anything that threw, with the run it belonged to, so a failure is
        // reported here rather than found later in Chrome's log with its
        // message gone and its line number pointing somewhere else.
        //
        // Read after the sections above, not before: a section that fails adds
        // to this list, and taking the list first left the dump saying nothing
        // had gone wrong on the very run that proved otherwise.
        errors: state.errors,
        // What the cover letter did, which no previous dump could say — four
        // rounds of "it didn't work" were read against a report with no room
        // for the answer.
        coverLetter: {
          wanted: state.wantCoverLetter,
          drafted: Boolean(state.letter),
          paragraphs: state.letter?.paragraphs?.length ?? 0,
          error: state.letterError,
        },
      };
      try {
        await navigator.clipboard.writeText(JSON.stringify(dump, null, 2));
        diag.textContent = "Copied — paste it to HireCraft";
      } catch {
        // Clipboard is blocked on some pages; the console always works.
        console.log("[HireCraft] diagnostics", dump);
        diag.textContent = "Logged to console (⌥⌘J)";
      }
    };
    body.append(diag);
  }

  // Choose the résumé before filling rather than after. Attaching the default
  // and letting the user notice afterwards means re-doing the upload, and on
  // some forms it means starting the application again.
  // One picker over both sources: the résumés uploaded here, and the PDFs in
  // the folder on disk. A tailored résumé for this very company is often
  // already in that folder, and making someone upload it again to attach it
  // would be the app declining to use what it can already see.
  const uploaded = state.profile?.resumes || [];
  const onDisk = state.profile?.local_resumes || [];
  if (uploaded.length || onDisk.length) {
    const row = el("label", "hc-field");
    row.append(el("span", "hc-field-label", "Résumé"));
    const select = el("select", "hc-select");

    const add = (parent, value, label, selected) => {
      const option = el("option", null, label);
      option.value = value;
      if (selected) option.selected = true;
      parent.append(option);
    };

    if (uploaded.length) {
      const group = el("optgroup");
      group.label = "In HireCraft";
      for (const r of uploaded) {
        add(group, r.id, r.name + (r.is_default ? " (default)" : ""), r.id === state.resumeId);
      }
      select.append(group);
    }

    // Grouped by folder, so "Vercel" sits under Vercel rather than in a list
    // of near-identical filenames.
    const byFolder = new Map();
    for (const r of onDisk) {
      if (!byFolder.has(r.folder)) byFolder.set(r.folder, []);
      byFolder.get(r.folder).push(r);
    }
    for (const [folder, items] of byFolder) {
      const group = el("optgroup");
      group.label = `On disk · ${folder}`;
      for (const r of items) add(group, `local:${r.id}`, r.name, `local:${r.id}` === state.resumeId);
      select.append(group);
    }

    select.onchange = (e) => {
      state.resumeId = e.target.value;
      state.resumeName = e.target.selectedOptions[0]?.textContent || "";
    };
    select.disabled = state.busy;
    row.append(select);
    foot.append(row);

    const check = el("label", "hc-check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = state.wantCoverLetter;
    box.disabled = state.busy;
    // A preference, not a trigger. Ticking it says what Fill should do, and Fill
    // is what does it — one button, one run, the form filled and the letter
    // drafted from the same posting and the same résumé. Making the tick itself
    // spend money was an over-correction for the earlier bug, where ticking it
    // after a fill did nothing at all.
    box.onchange = (e) => {
      state.wantCoverLetter = e.target.checked;
      render();
    };
    check.append(box, el("span", null, "Also draft a cover letter"));
    foot.append(check);
    if (state.wantCoverLetter) {
      foot.append(
        el("div", "hc-hint", "Drafted when you press Fill. Uses AI credit — a few cents. Written from this posting and the résumé above.")
      );
    }
  }


  if (state.letter) {
    const box = el("div", "hc-letter");
    box.append(el("div", "hc-letter-head", `Cover letter · ${state.letter.paragraphs.length} paragraphs`));
    box.append(el("div", "hc-letter-body", state.letter.paragraphs.join("\n\n")));
    // Style signals rather than a verdict: the reader decides, but they should
    // not have to judge machine-written phrasing cold.
    const tells = state.letter.tells?.length || 0;
    box.append(
      el(
        "div",
        "hc-letter-meta",
        tells
          ? `${tells} phrase${tells === 1 ? "" : "s"} that read as AI-written — worth an edit`
          : "No machine-writing tells found"
      )
    );
    if (state.letter.pdf) {
      const filename = `CoverLetter_${(state.letter.company || "letter").replace(/\W+/g, "_")}.pdf`;

      // Attaching is a separate, deliberate click rather than part of drafting.
      // The draft is the part worth reading before it goes anywhere, and a
      // letter that uploaded itself the moment it was written would be attached
      // to a real application before anyone had looked at it.
      const attach = el("button", "hc-btn hc-small hc-primary", "Attach to form");
      attach.onclick = () => {
        const target = window.HIRECRAFT_FILL.findUploadInput(
          window.HIRECRAFT_COVER_FILE,
          window.HIRECRAFT_NOT_COVER
        );
        if (!target) {
          attach.textContent = "No cover-letter box here";
          return;
        }
        try {
          window.HIRECRAFT_FILL.attachFile(
            target,
            window.HIRECRAFT_FILL.fileFromDataUrl(state.letter.pdf, filename)
          );
          highlight(target);
          attach.textContent = "Attached";
        } catch {
          attach.textContent = "The form refused it — download instead";
        }
      };
      box.append(attach);

      const save = el("button", "hc-btn hc-small", "Download PDF");
      save.onclick = () => {
        const link = document.createElement("a");
        link.href = state.letter.pdf;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
      };
      box.append(save);
    }

    // A draft is a starting point, not a verdict. Say what is wrong with it and
    // have it rewritten, as many times as it takes, before anything is attached.
    const notes = el("textarea", "hc-feedback");
    notes.placeholder =
      "What should change? e.g. lead with the equivariance work, cut the last paragraph, less formal";
    notes.value = state.letterFeedback || "";
    notes.rows = 3;
    notes.disabled = state.busy;
    notes.oninput = (e) => {
      state.letterFeedback = e.target.value;
    };
    box.append(notes);

    const rewrite = el("button", "hc-btn hc-small", state.busy ? "Rewriting…" : "Rewrite with this");
    rewrite.disabled = state.busy || !(state.letterFeedback || "").trim();
    rewrite.onclick = () => runCoverLetter({ feedback: state.letterFeedback });
    box.append(rewrite);

    const copy = el("button", "hc-btn hc-small", "Copy letter");
    copy.onclick = async () => {
      const full = [state.letter.greeting, ...state.letter.paragraphs, state.letter.signature]
        .filter(Boolean)
        .join("\n\n");
      try {
        await navigator.clipboard.writeText(full);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Select it and copy";
      }
    };
    box.append(copy);
    body.append(box);
  }

  const actions = el("div", "hc-actions");
  // Named for what it will do, so a ticked box does not look ignored after a
  // fill that happened before it was ticked.
  const fillLabel = state.busy
    ? "Filling…"
    : state.wantCoverLetter && !state.letter
      ? "Fill and draft letter"
      : "Fill this form";
  const fill = el("button", "hc-btn hc-primary", fillLabel);
  fill.disabled = state.busy;
  fill.onclick = runFill;
  actions.append(fill);

  const STAGE_LABEL = { draft: "Tracked ✓", applied: "Applied ✓" };
  const track = el("button", "hc-btn", STAGE_LABEL[state.stage] || "Track application");
  track.disabled = state.busy || state.stage === "applied";
  track.onclick = () => runTrack("draft");
  actions.append(track);
  foot.append(actions);
  panel.append(foot);

  return panel;
}

function renderLauncher() {
  const button = el("button", "hc-launcher");
  button.innerHTML = LOGO_SVG;
  button.title = "Fill this form with HireCraft";
  button.setAttribute("aria-label", "Open HireCraft");
  button.onclick = () => {
    state.open = true;
    render();
    loadProfile();
  };
  // A count of what was filled, so a collapsed launcher still reports.
  if (state.report?.filled?.length) {
    button.append(el("span", "hc-badge", String(state.report.filled.length)));
  }
  return button;
}

function render() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  root.replaceChildren(state.open ? renderPanel() : renderLauncher());
}

/**
 * Update just the status line.
 *
 * Filling reports after every field, and rebuilding the whole panel each time
 * would throw away and recreate a few dozen nodes per field for the sake of one
 * string — while the browser is already busy smooth-scrolling the page.
 */
function setStatus(text) {
  state.status = text;
  const root = document.getElementById(ROOT_ID);
  const line = root?.querySelector(".hc-status");
  if (line) line.textContent = text;
  else render();
}

// --- actions -----------------------------------------------------------------

/**
 * Bring a field into view and mark it as it is filled.
 *
 * `scrollIntoView` is skipped when the field is already comfortably on screen:
 * scrolling to something the user is already looking at is motion for its own
 * sake, and on a long form it turns a fill into a jolting ride down the page.
 */
function highlight(node) {
  if (!node || !node.getBoundingClientRect) return;
  const box = node.getBoundingClientRect();
  const margin = Math.min(160, window.innerHeight * 0.2);
  if (box.top < margin || box.bottom > window.innerHeight - margin) {
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  node.classList.add("hc-filled-flash");
  setTimeout(() => node.classList.remove("hc-filled-flash"), 1200);
}

/** Fetch the profile once, so the résumé picker has something to show. */
async function loadProfile() {
  if (state.profile || state.busy) return;
  const reply = await ask({ type: "profile" });
  if (!reply.ok) {
    setStatus(reply.error);
    return;
  }
  state.profile = reply.data;
  const preferred = resolveResume(reply.data, state.resumeId);
  state.resumeId = preferred?.id || null;
  state.resumeName = preferred?.name || null;
  render();
}

/**
 * The résumé to send, across both sources.
 *
 * Written once because it was written twice and neither copy knew about the
 * folder on disk: a locally picked PDF was chosen in the dropdown and then
 * quietly replaced by the default upload on the way to the form.
 */
function resolveResume(profile, wanted) {
  const uploaded = (profile?.resumes || []).map((r) => ({
    id: r.id,
    name: r.name,
    isDefault: Boolean(r.is_default),
  }));
  const onDisk = (profile?.local_resumes || []).map((r) => ({
    id: `local:${r.id}`,
    name: `${r.name} (${r.folder})`,
    isDefault: false,
  }));
  const all = [...uploaded, ...onDisk];
  return (
    all.find((r) => r.id === wanted) ||
    all.find((r) => r.isDefault) ||
    all[0] ||
    null
  );
}

/**
 * Run one of the panel's actions, and always give the panel back.
 *
 * Each of these sets `busy`, which disables every control, and each cleared it
 * on the way out — on the paths that reached the way out. A throw anywhere in
 * between left it set, so the panel sat with everything greyed and nothing to
 * say, which is exactly what "the extension got stuck" looks like from outside.
 *
 * The engine reaches into pages nobody has seen, so a throw is not a remote
 * possibility; it is the ordinary way an unfamiliar form goes wrong. What
 * matters is that it costs one action rather than the session.
 */
async function guarded(what, run) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await run();
  } catch (error) {
    state.status = `${what} failed: ${noteError(what, error).message}`;
  } finally {
    state.busy = false;
    render();
  }
}

async function runFill() {
  return guarded("Fill", fillOnce);
}

async function fillOnce() {
  // Written before filling rather than after: a form that posts on the very
  // next click should still leave a trace of having been filled here.
  rememberFilling();
  state.status = "Reading your HireCraft profile…";
  render();

  // Fetched every time, not once per page.
  //
  // A content script outlives any number of edits made in another tab: the
  // panel read the profile on its first Fill and kept it for as long as the tab
  // stayed open. So the sequence anyone would actually perform — press Fill,
  // see "no street address stored — add one in Career Profile", go and add one,
  // come back, press Fill — returned the same message, because the answer it
  // asked for had been added to a copy this page would never see again.
  //
  // That is a feature working correctly and looking broken, which is worse than
  // one that is broken, and the fix costs a single request to a server running
  // on this machine.
  const fresh = await ask({ type: "profile" });
  if (fresh.ok) {
    state.profile = fresh.data;
  } else if (!state.profile) {
    state.status = fresh.error;
    return;
  }
  const profile = state.profile;

  // Whichever résumé the user picked, not whichever happens to be default —
  // and from either source.
  const chosen = resolveResume(profile, state.resumeId);
  state.resumeId = chosen?.id || null;
  state.resumeName = chosen?.name || null;

  let resumeFile = null;
  if (chosen) {
    setStatus(`Fetching ${chosen.name}…`);
    const pdf = await ask({ type: "resume", resumeId: chosen.id });
    if (pdf.ok) {
      resumeFile = window.HIRECRAFT_FILL.fileFromDataUrl(
        pdf.data.dataUrl,
        `${chosen.name.replace(/\s+/g, "_")}.pdf`
      );
    }
  }

  setStatus("Filling…");

  const report = await window.HIRECRAFT_FILL.fillForm(profile, {
    resumeFile,
    overrides: window.HIRECRAFT_ADAPTER.overrides,
    onProgress: ({ el: field, label, attempting }) => {
      setStatus(attempting ? `${label}…` : `Filled ${label}`);
      if (!attempting) highlight(field);
    },
  });

  // Back to where the form starts, so the first thing seen after a fill is the
  // top of what was filled rather than wherever the last field happened to be.
  const first = document.querySelector("form") || document.body;
  first.scrollIntoView({ behavior: "smooth", block: "start" });

  Object.assign(state, { status: "", report });
  render();

  if (state.wantCoverLetter && !state.letter) await draftLetter();
}

async function runCoverLetter(options = {}) {
  return guarded("Cover letter", () => draftLetter(options));
}

async function draftLetter({ feedback = "" } = {}) {
  // Both go together: the note says what to change, the draft says what to
  // change it from. Sending the note alone would start over and lose the
  // paragraphs that were already right.
  const revising = Boolean(feedback.trim() && state.letter?.paragraphs?.length);
  setStatus(revising ? "Rewriting with your note…" : "Writing a cover letter from this posting…");
  render();

  const { company, role } = postingIdentity();
  const reply = await ask({
    type: "coverLetter",
    jobText: window.HIRECRAFT_VISA.pageText(),
    company,
    role,
    resumeId: state.resumeId,
    feedback: revising ? feedback.trim() : null,
    previous: revising ? state.letter.paragraphs : null,
  });
  if (!reply.ok) {
    // Kept, not just flashed: a status line is gone by the time anyone asks
    // what happened, and "nothing happened" is the least diagnosable report
    // there is.
    state.letterError = reply.error;
    setStatus(reply.error);
    render();
    return;
  }
  state.letterError = null;
  state.letter = { ...reply.data, company };
  // The note was written before the letter existed; refresh it so a submission
  // that navigates away still carries what was drafted.
  rememberFilling();
  // Cleared so the box is empty for the next note rather than repeating the
  // last one, which would be applied twice.
  state.letterFeedback = "";
  setStatus(
    `${revising ? "Rewritten" : "Drafted"} · $${(reply.data.cost_usd || 0).toFixed(3)}`
  );
  render();
}

/**
 * The JobPosting structured data a board publishes for search engines.
 *
 * The most reliable source of the employer's name by a distance: it is the page
 * stating who is hiring, rather than us inferring it from a URL.
 */
function jsonLdCompany() {
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(node.textContent || "{}");
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        const name = entry?.hiringOrganization?.name || entry?.["@graph"]
          ?.find?.((g) => g?.hiringOrganization)?.hiringOrganization?.name;
        if (name) return String(name);
      }
    } catch {
      // A board with malformed JSON-LD is not a reason to stop reading a page.
    }
  }
  return "";
}

/** What the page says about who is hiring and for what. */
function postingIdentity() {
  const segment = /greenhouse|lever|ashbyhq|myworkdayjobs|smartrecruiters|workable/.test(
    location.hostname
  )
    ? location.pathname.split("/").filter(Boolean)[0] || ""
    : "";
  return {
    company: window.HIRECRAFT_POSTING.companyFrom({
      jsonLd: jsonLdCompany(),
      siteName: document.querySelector('meta[property="og:site_name"]')?.content || "",
      title: document.title,
      pathSegment: segment,
      host: location.hostname,
    }),
    role: window.HIRECRAFT_POSTING.roleFromTitle(document.title),
  };
}

function guessCompany() {
  return postingIdentity().company;
}

async function runTrack(stage = "draft") {
  return guarded("Tracking", () => trackOnce(stage));
}

async function trackOnce(stage) {
  setStatus(stage === "applied" ? "Recording that you applied…" : "Adding to your tracker…");
  // The company and role go with it. Left to work them out from the URL alone,
  // the server had only the path's first segment to go on, and a tracker row
  // read "Applied" for Applied Intuition — a row you cannot find by searching
  // for the company you applied to.
  const { company, role } = postingIdentity();
  const reply = await ask({
    type: "track",
    url: location.href,
    resumeId: state.resumeId,
    resumeName: state.resumeName,
    status: stage,
    company,
    role,
    coverLetter: state.letter?.paragraphs || null,
    coverLetterUsage: state.letter?.usage || null,
  });
  Object.assign(state, {
    stage: reply.ok ? stage : state.stage,
    status: reply.ok
      ? stage === "applied"
        ? "Marked as applied in HireCraft."
        : "Saved to your HireCraft tracker."
      : reply.error,
  });
  render();
}

// --- mounting ----------------------------------------------------------------

/**
 * Notice when an application actually goes through, and record it as applied.
 *
 * Worth doing because the alternative is remembering: the moment you submit is
 * the moment you stop thinking about a job and start thinking about the next
 * one, and a tracker filled in from memory a week later is a tracker with holes
 * in it.
 *
 * Three signals, because no single one is reliable across these ATSs:
 *
 *   The form's own submit event. Fires on a classic post, misses a React form
 *   that submits over fetch and never leaves the page.
 *   Navigation to a confirmation URL, which most ATSs use.
 *   Confirmation text appearing in the page, which is what a single-page form
 *   does instead of navigating.
 *
 * Deliberately requires the page to have looked like an application form
 * beforehand, so a "thank you" in a careers-page footer is not mistaken for a
 * submission. It never fires twice, and the user can still record it by hand if
 * every signal misses.
 */
/**
 * Remembering that a form was filled here, so a confirmation page can be
 * recognised after the browser has navigated away from it.
 *
 * The in-page watcher below only helps while the page survives. A form that
 * posts and lands somewhere else takes the content script with it, and the
 * script that starts on the confirmation page finds no form — because the form
 * is gone, which is the point — and so refused to arm anything. That refusal
 * exists to stop a "thank you" in a careers-page footer counting as a
 * submission, and it is right to; the missing half was any memory of having
 * been here before.
 *
 * The note is what makes the difference. A confirmation only counts when this
 * browser filled a form on the same site within the last couple of hours.
 */
const PENDING_KEY = "hirecraft.pending";
const PENDING_FOR = 2 * 60 * 60 * 1000;

async function rememberFilling() {
  const { company, role } = postingIdentity();
  try {
    await chrome.storage.local.set({
      [PENDING_KEY]: {
        origin: location.origin,
        url: location.href,
        company,
        role,
        // Carried across the navigation, since the page that records the
        // submission is not the page that drafted the letter — and that is the
        // path that actually fires on a form which posts and lands elsewhere.
        coverLetter: state.letter?.paragraphs || null,
        coverLetterUsage: state.letter?.usage || null,
        resumeId: state.resumeId,
        resumeName: state.resumeName,
        at: Date.now(),
      },
    });
  } catch {
    // Storage can be unavailable; the in-page watcher still covers the common
    // case where the confirmation replaces the form without navigating.
  }
}

async function pendingFill() {
  try {
    const stored = (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY];
    if (!stored || stored.origin !== location.origin) return null;
    if (Date.now() - stored.at > PENDING_FOR) return null;
    return stored;
  } catch {
    return null;
  }
}

/**
 * Did we land on a confirmation for something filled a moment ago?
 *
 * Runs whether or not this page has a form, since a confirmation page does not.
 */
let confirmationChecked = false;

async function checkArrivedAtConfirmation() {
  // Once per page. Two concurrent runs would both read the pending note before
  // either cleared it, and both would report the same submission.
  if (confirmationChecked) return;
  confirmationChecked = true;

  const looksDone =
    window.HIRECRAFT_SUBMISSION.isConfirmationUrl(location.pathname) ||
    (window.HIRECRAFT_SUBMISSION.isConfirmationText(document.body?.innerText || "") &&
      !looksLikeApplicationForm());
  if (!looksDone) return;

  const pending = await pendingFill();
  if (!pending) return;

  await chrome.storage.local.remove(PENDING_KEY).catch(() => {});
  const reply = await ask({
    type: "track",
    url: pending.url,
    status: "applied",
    company: pending.company,
    role: pending.role,
    resumeId: pending.resumeId,
    resumeName: pending.resumeName,
    coverLetter: pending.coverLetter,
    coverLetterUsage: pending.coverLetterUsage,
  });
  console.debug("[HireCraft] recorded a submission on arrival:", reply.ok ? "ok" : reply.error);
}

function watchForSubmission() {
  let done = false;

  const record = (how) => {
    if (done || state.stage === "applied") return;
    done = true;
    // Open the panel: the user should see the claim being made about their
    // application, not find out later that something was recorded silently.
    state.open = true;
    setStatus("Looks like you submitted — recording it…");
    render();
    runTrack("applied");
    console.debug("[HireCraft] submission detected via", how);
  };

  // 1. A classic form post.
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target;
      if (form instanceof HTMLFormElement && form.querySelector('input[type="file"], input[type="email"]')) {
        // Let the submission proceed first; recording a submit that the page
        // then rejects for a missing field would be a lie.
        setTimeout(() => {
          if (window.HIRECRAFT_SUBMISSION.isConfirmationText(document.body.innerText)) {
            record("submit + confirmation");
          }
        }, 2500);
      }
    },
    true
  );

  // 2. A confirmation URL, including the SPA history changes that do not reload.
  let lastUrl = location.href;
  const checkUrl = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    if (window.HIRECRAFT_SUBMISSION.isConfirmationUrl(location.pathname)) record("confirmation url");
  };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      queueMicrotask(checkUrl);
      return result;
    };
  }
  window.addEventListener("popstate", checkUrl);
  if (window.HIRECRAFT_SUBMISSION.isConfirmationUrl(location.pathname)) record("confirmation url");

  // 3. Confirmation text appearing where a form used to be.
  let pending = 0;
  const observer = new MutationObserver(() => {
    if (done || pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      if (window.HIRECRAFT_SUBMISSION.isConfirmationText(document.body.innerText)) {
        observer.disconnect();
        record("confirmation text");
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
  // A form left open for an hour is not a submission; stop watching eventually.
  setTimeout(() => observer.disconnect(), 30 * 60 * 1000);
}

function mount() {
  if (document.getElementById(ROOT_ID)) return;
  if (!looksLikeApplicationForm()) return;
  try {
    state.visa = window.HIRECRAFT_VISA.classifyVisa();
  } catch {
    // A page we cannot read is not a reason to withhold the filler.
    state.visa = null;
  }
  const root = el("div", "hc-root");
  root.id = ROOT_ID;
  document.body.append(root);
  render();
  console.debug("[HireCraft] panel mounted", PANEL_BUILD, location.pathname);
  // Only after the page has been judged an application form, so a "thank you"
  // in a careers-page footer cannot be read as a submission.
  watchForSubmission();
  watchForStepChange();
}

/**
 * Notice when the application moves to a different step.
 *
 * An application is six pages on Workday and the panel outlives all of them:
 * the URL changes, the form underneath is replaced, and the report from the
 * step before stays on screen saying thirty-eight fields are filled. None of
 * them are — they were filled on a page that is no longer here — and a report
 * describing a form the reader is not looking at is worse than no report, since
 * it answers the question they came to ask with yesterday's answer.
 *
 * So a step change clears what was said about the last one. The résumé choice
 * and the cover letter stay: those are about this application, not this page.
 */
function watchForStepChange() {
  let last = location.href;
  const check = () => {
    if (location.href === last) return;
    last = location.href;
    if (!state.report && !state.status) return;
    Object.assign(state, { report: null, status: "", sections: {} });
    render();
    console.debug("[HireCraft] new step, report cleared", location.pathname);
  };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      queueMicrotask(check);
      return result;
    };
  }
  window.addEventListener("popstate", check);
  // Workday moves between steps without always touching history, so the DOM is
  // watched too — throttled, since a step change re-renders a great deal.
  let timer = 0;
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      check();
    }, 500);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

/**
 * Wait for a form to exist, for as long as the page does.
 *
 * The first version gave up after twenty seconds, which is fine for a board
 * that renders its form on load and useless for one that makes you sign in
 * first. On Workday the wait is a login, a redirect and several steps of a
 * wizard — minutes — and by the time the form appeared the watcher had been
 * disconnected for most of the session. The panel simply never showed up.
 *
 * So it waits indefinitely, and cheaply. A React app mutates constantly during
 * hydration, so the check is throttled to once a second rather than debounced
 * to the next frame: four querySelectorAll calls a second is nothing, and this
 * runs on a page we are a guest on.
 *
 * It also re-checks when the URL changes. A single-page app moves between steps
 * without reloading, so nothing would otherwise notice that a page with no form
 * has become one with a form.
 */
function watchForForm() {
  if (document.getElementById(ROOT_ID)) return;

  let last = 0;
  let timer = 0;
  const look = () => {
    if (document.getElementById(ROOT_ID)) return true;
    if (!looksLikeApplicationForm()) return false;
    mount();
    return true;
  };

  const throttled = () => {
    const now = Date.now();
    if (now - last < 1000) {
      if (!timer) timer = setTimeout(() => { timer = 0; throttled(); }, 1000);
      return;
    }
    last = now;
    if (look()) observer.disconnect();
  };

  const observer = new MutationObserver(throttled);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // A step change in a single-page app is a navigation with no reload.
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      queueMicrotask(throttled);
      return result;
    };
  }
  window.addEventListener("popstate", throttled);
  look();
}

// First of all, so that anything below failing is itself reported.
watchForErrors();
// Before anything else, and regardless of whether this page has a form: the
// page we were sent to after submitting will not have one.
checkArrivedAtConfirmation();
watchForForm();
