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
  wantCoverLetter: false,
  letter: null,
};

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

function renderPanel() {
  const panel = el("div", "hc-panel");

  const header = el("div", "hc-head");
  const brand = el("span", "hc-brand");
  const mark = el("span", "hc-head-mark");
  mark.innerHTML = LOGO_SVG;
  brand.append(mark, el("span", "hc-brand-text", "HireCraft"));
  header.append(brand);

  const collapse = el("button", "hc-x", "—");
  collapse.title = "Collapse";
  collapse.setAttribute("aria-label", "Collapse HireCraft");
  collapse.onclick = () => {
    state.open = false;
    render();
  };
  header.append(collapse);
  panel.append(header);

  // The visa verdict, read from the posting on this page. Shown before anything
  // else because it decides whether filling the form is worth doing at all.
  if (state.visa) {
    const { text, tone, blocks } = window.HIRECRAFT_VISA.visaLabel(state.visa.verdict);
    const box = el("div", `hc-visa hc-visa-${tone}`);
    box.append(el("div", "hc-visa-head", text));
    if (state.visa.evidence) {
      box.append(el("div", "hc-visa-why", `…${state.visa.evidence.slice(0, 190)}…`));
    } else if (!blocks) {
      box.append(el("div", "hc-visa-why", "Worth confirming with the recruiter."));
    }
    panel.append(box);
  }

  if (state.status) panel.append(el("div", "hc-status", state.status));

  if (state.report) {
    const { filled, missing, skipped } = state.report;
    panel.append(
      el(
        "div",
        "hc-summary",
        `Filled ${filled.length} field${filled.length === 1 ? "" : "s"}` +
          (missing.length ? ` · ${missing.length} left for you` : "")
      )
    );

    const list = el("div", "hc-list");
    // Long values wrap rather than being cut. Truncating at 36 characters made
    // a correctly-filled LinkedIn URL read as though it had lost its last
    // character, which is a report that creates the bug it is meant to rule out.
    const row = (cls, label, value, extra) => {
      const r = el("div", `hc-row ${cls}`);
      r.append(el("span", "hc-dot"), el("span", "hc-label", label));
      r.append(el("span", "hc-val", String(value)));
      if (extra) r.append(el("div", "hc-row-extra", extra));
      return r;
    };
    for (const item of filled) {
      list.append(row("hc-ok", item.label, item.value, item.note));
    }
    for (const item of missing) {
      // When a dropdown had no answer for us, show what it did offer — that is
      // the difference between "this failed" and knowing what to pick by hand.
      const offered = item.offered?.length ? `offers: ${item.offered.join(" · ")}` : null;
      list.append(row("hc-miss", item.label, item.why, offered));
    }
    for (const item of skipped) list.append(row("hc-skip", item.label, item.why));
    panel.append(list);

    // Required questions the form still has no answer for. Worth its own block
    // rather than another row in the list: a filled-in form that will bounce on
    // submit is the failure mode this panel exists to prevent, and it is the one
    // thing here you have to act on before submitting.
    const gaps = state.report.required ?? [];
    if (gaps.length) {
      const warn = el("div", "hc-required");
      warn.append(
        el("div", "hc-required-head", `${gaps.length} required question${gaps.length === 1 ? "" : "s"} still empty`)
      );
      for (const label of gaps) warn.append(el("div", "hc-required-item", label));
      panel.append(warn);
    }

    // Everything the fill actually did, as text you can paste. The panel's
    // summary says a field failed; this says which option list it read, where
    // that list came from, and what was on it — which is the difference between
    // reporting a bug and diagnosing one.
    const diag = el("button", "hc-btn hc-small", "Copy diagnostics");
    diag.onclick = async () => {
      const dump = {
        url: location.href,
        filled: state.report.filled,
        missing: state.report.missing,
        skipped: state.report.skipped,
        required: state.report.required,
        trace: state.report.trace,
        inspect: window.HIRECRAFT_FILL.inspectForm(),
        // Choice-shaped questions, which the scan above cannot represent.
        // Included so a form that asks yes/no with buttons rather than a
        // dropdown shows its real structure instead of vanishing.
        choices: window.HIRECRAFT_FILL.choiceCandidates(),
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
    panel.append(diag);

    panel.append(
      el("div", "hc-note", "Nothing has been submitted. Check the form, then submit it yourself.")
    );
  }

  // Choose the résumé before filling rather than after. Attaching the default
  // and letting the user notice afterwards means re-doing the upload, and on
  // some forms it means starting the application again.
  if (state.profile?.resumes?.length) {
    const row = el("label", "hc-field");
    row.append(el("span", "hc-field-label", "Résumé"));
    const select = el("select", "hc-select");
    for (const r of state.profile.resumes) {
      const option = el("option", null, r.name + (r.is_default ? " (default)" : ""));
      option.value = r.id;
      if (r.id === state.resumeId) option.selected = true;
      select.append(option);
    }
    select.onchange = (e) => {
      state.resumeId = e.target.value;
    };
    select.disabled = state.busy;
    row.append(select);
    panel.append(row);

    const check = el("label", "hc-check");
    const box = el("input");
    box.type = "checkbox";
    box.checked = state.wantCoverLetter;
    box.disabled = state.busy;
    box.onchange = (e) => {
      state.wantCoverLetter = e.target.checked;
      render();
    };
    check.append(box, el("span", null, "Also draft a cover letter"));
    panel.append(check);
    if (state.wantCoverLetter) {
      panel.append(
        el("div", "hc-hint", "Uses AI credit — a few cents. Written from this posting and the résumé above.")
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
    panel.append(box);
  }

  const actions = el("div", "hc-actions");
  const fill = el("button", "hc-btn hc-primary", state.busy ? "Filling…" : "Fill this form");
  fill.disabled = state.busy;
  fill.onclick = runFill;
  actions.append(fill);

  const STAGE_LABEL = { draft: "Tracked ✓", applied: "Applied ✓" };
  const track = el("button", "hc-btn", STAGE_LABEL[state.stage] || "Track application");
  track.disabled = state.busy || state.stage === "applied";
  track.onclick = () => runTrack("draft");
  actions.append(track);
  panel.append(actions);

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
  const preferred =
    reply.data.resumes?.find((r) => r.is_default) || reply.data.resumes?.[0];
  state.resumeId = state.resumeId || preferred?.id || null;
  render();
}

async function runFill() {
  state.busy = true;
  state.status = "Reading your HireCraft profile…";
  render();

  if (!state.profile) {
    const reply = await ask({ type: "profile" });
    if (!reply.ok) {
      Object.assign(state, { busy: false, status: reply.error });
      render();
      return;
    }
    state.profile = reply.data;
  }
  const profile = state.profile;

  // Whichever résumé the user picked, not whichever happens to be default.
  const chosen =
    profile.resumes?.find((r) => r.id === state.resumeId) ||
    profile.resumes?.find((r) => r.is_default) ||
    profile.resumes?.[0];
  state.resumeId = chosen?.id || null;

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
    onProgress: ({ el: field, label }) => {
      setStatus(`Filled ${label}`);
      highlight(field);
    },
  });

  // Back to where the form starts, so the first thing seen after a fill is the
  // top of what was filled rather than wherever the last field happened to be.
  const first = document.querySelector("form") || document.body;
  first.scrollIntoView({ behavior: "smooth", block: "start" });

  Object.assign(state, { busy: false, status: "", report });
  render();

  if (state.wantCoverLetter && !state.letter) await runCoverLetter();
}

async function runCoverLetter() {
  state.busy = true;
  setStatus("Writing a cover letter from this posting…");
  const reply = await ask({
    type: "coverLetter",
    jobText: window.HIRECRAFT_VISA.pageText(),
    company: guessCompany(),
    role: document.title.split(/[|\-–]/)[0].trim().slice(0, 120),
    resumeId: state.resumeId,
  });
  state.busy = false;
  if (!reply.ok) {
    setStatus(reply.error);
    return;
  }
  state.letter = { ...reply.data, company: guessCompany() };
  setStatus(`Drafted · $${(reply.data.cost_usd || 0).toFixed(3)}`);
  render();
}

/** The employer's name, as well as the page will tell us. */
function guessCompany() {
  const meta = document.querySelector('meta[property="og:site_name"]')?.content;
  if (meta) return meta.slice(0, 120);
  const host = location.hostname.replace(/^www\./, "").split(".")[0];
  // ATS hosts name the ATS, not the employer; the path's first segment does.
  if (/greenhouse|lever|ashbyhq|myworkdayjobs|smartrecruiters/.test(location.hostname)) {
    const segment = location.pathname.split("/").filter(Boolean)[0] || "";
    return segment.replace(/[-_]/g, " ").slice(0, 120);
  }
  return host;
}

async function runTrack(stage = "draft") {
  state.busy = true;
  setStatus(stage === "applied" ? "Recording that you applied…" : "Adding to your tracker…");
  const reply = await ask({
    type: "track",
    url: location.href,
    resumeId: state.resumeId,
    status: stage,
  });
  Object.assign(state, {
    busy: false,
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
  // Only after the page has been judged an application form, so a "thank you"
  // in a careers-page footer cannot be read as a submission.
  watchForSubmission();
}

if (looksLikeApplicationForm()) {
  mount();
} else {
  // Two of the three ATSs render their form after load, so waiting for the DOM
  // is not enough. The check is debounced: a React app mutates constantly
  // during hydration, and running a querySelectorAll on every mutation is a
  // measurable cost on the page we are a guest on.
  let pending = 0;
  const observer = new MutationObserver(() => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      if (looksLikeApplicationForm()) {
        observer.disconnect();
        mount();
      }
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 20000);
}
