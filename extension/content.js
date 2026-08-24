/**
 * The on-page HireCraft panel: fill the form, say what happened, record it.
 *
 * Only ever fills. It never clicks submit and never touches a CAPTCHA — Lever's
 * apply form carries an hCaptcha, and more to the point an application cannot be
 * un-sent, so the last action stays a deliberate human one.
 */

const PANEL_ID = "hirecraft-panel";

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
  const hasFile = document.querySelector('input[type="file"]');
  const textInputs = document.querySelectorAll(
    'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
  );
  return Boolean(hasFile) || textInputs.length >= 3;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function render(panel, state) {
  panel.replaceChildren();

  const header = el("div", "hc-head");
  header.append(el("span", "hc-mark", "HireCraft"));
  const close = el("button", "hc-x", "✕");
  close.title = "Hide";
  close.onclick = () => panel.remove();
  header.append(close);
  panel.append(header);

  if (state.status) panel.append(el("div", "hc-status", state.status));

  if (state.report) {
    const { filled, missing, skipped } = state.report;
    const summary = el(
      "div",
      "hc-summary",
      `Filled ${filled.length} field${filled.length === 1 ? "" : "s"}` +
        (missing.length ? ` · ${missing.length} left for you` : "")
    );
    panel.append(summary);

    const list = el("div", "hc-list");
    for (const item of filled) {
      const row = el("div", "hc-row hc-ok");
      row.append(el("span", "hc-dot"), el("span", "hc-label", item.label));
      row.append(el("span", "hc-val", String(item.value).slice(0, 34)));
      list.append(row);
    }
    for (const item of missing) {
      const row = el("div", "hc-row hc-miss");
      row.append(el("span", "hc-dot"), el("span", "hc-label", item.label));
      row.append(el("span", "hc-val", item.why));
      list.append(row);
    }
    for (const item of skipped) {
      const row = el("div", "hc-row hc-skip");
      row.append(el("span", "hc-dot"), el("span", "hc-label", item.label));
      row.append(el("span", "hc-val", item.why));
      list.append(row);
    }
    panel.append(list);
    panel.append(
      el("div", "hc-note", "Nothing has been submitted. Check the form, then submit it yourself.")
    );
  }

  const actions = el("div", "hc-actions");
  const fill = el("button", "hc-btn hc-primary", state.busy ? "Filling…" : "Fill this form");
  fill.disabled = Boolean(state.busy);
  fill.onclick = () => runFill(panel, state);
  actions.append(fill);

  const track = el("button", "hc-btn", state.tracked ? "Tracked ✓" : "Track application");
  track.disabled = Boolean(state.busy || state.tracked);
  track.onclick = () => runTrack(panel, state);
  actions.append(track);
  panel.append(actions);
}

async function runFill(panel, state) {
  render(panel, { ...state, busy: true, status: "Reading your HireCraft profile…" });

  const profileReply = await ask({ type: "profile" });
  if (!profileReply.ok) {
    render(panel, { ...state, busy: false, status: profileReply.error });
    return;
  }
  const profile = profileReply.data;

  let resumeFile = null;
  const preferred = profile.resumes?.find((r) => r.is_default) || profile.resumes?.[0];
  if (preferred) {
    render(panel, { ...state, busy: true, status: `Fetching ${preferred.name}…` });
    const pdf = await ask({ type: "resume", resumeId: preferred.id });
    if (pdf.ok) {
      resumeFile = window.HIRECRAFT_FILL.fileFromDataUrl(
        pdf.data.dataUrl,
        `${preferred.name.replace(/\s+/g, "_")}.pdf`
      );
    }
  }

  const report = window.HIRECRAFT_FILL.fillForm(profile, {
    resumeFile,
    overrides: window.HIRECRAFT_ADAPTER.overrides,
  });
  render(panel, { ...state, busy: false, status: "", report, profile, resumeId: preferred?.id });
}

async function runTrack(panel, state) {
  render(panel, { ...state, busy: true, status: "Recording this application…" });
  const reply = await ask({
    type: "track",
    url: location.href,
    resumeId: state.resumeId || null,
  });
  render(panel, {
    ...state,
    busy: false,
    tracked: reply.ok,
    status: reply.ok ? "Saved to your HireCraft tracker." : reply.error,
  });
}

function mount() {
  if (document.getElementById(PANEL_ID)) return;
  if (!looksLikeApplicationForm()) return;

  const panel = el("div", "hc-panel");
  panel.id = PANEL_ID;
  document.body.append(panel);
  render(panel, { busy: false, status: "" });
}

// Two of the three ATSs render their form after load, so waiting for the DOM is
// not enough — watch until a form appears, then stop watching.
if (looksLikeApplicationForm()) {
  mount();
} else {
  const observer = new MutationObserver(() => {
    if (looksLikeApplicationForm()) {
      observer.disconnect();
      mount();
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // Give up after a while rather than observing the page for its whole life.
  setTimeout(() => observer.disconnect(), 20000);
}
