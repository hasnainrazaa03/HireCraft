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
  busy: false,
  status: "",
  report: null,
  tracked: false,
  resumeId: null,
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
    const row = (cls, label, value) => {
      const r = el("div", `hc-row ${cls}`);
      r.append(el("span", "hc-dot"), el("span", "hc-label", label));
      r.append(el("span", "hc-val", String(value).slice(0, 36)));
      return r;
    };
    for (const item of filled) list.append(row("hc-ok", item.label, item.value));
    for (const item of missing) list.append(row("hc-miss", item.label, item.why));
    for (const item of skipped) list.append(row("hc-skip", item.label, item.why));
    panel.append(list);
    panel.append(
      el("div", "hc-note", "Nothing has been submitted. Check the form, then submit it yourself.")
    );
  }

  const actions = el("div", "hc-actions");
  const fill = el("button", "hc-btn hc-primary", state.busy ? "Filling…" : "Fill this form");
  fill.disabled = state.busy;
  fill.onclick = runFill;
  actions.append(fill);

  const track = el("button", "hc-btn", state.tracked ? "Tracked ✓" : "Track application");
  track.disabled = state.busy || state.tracked;
  track.onclick = runTrack;
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

async function runFill() {
  state.busy = true;
  state.status = "Reading your HireCraft profile…";
  render();

  const profileReply = await ask({ type: "profile" });
  if (!profileReply.ok) {
    Object.assign(state, { busy: false, status: profileReply.error });
    render();
    return;
  }
  const profile = profileReply.data;

  let resumeFile = null;
  const preferred = profile.resumes?.find((r) => r.is_default) || profile.resumes?.[0];
  if (preferred) {
    setStatus(`Fetching ${preferred.name}…`);
    const pdf = await ask({ type: "resume", resumeId: preferred.id });
    if (pdf.ok) {
      resumeFile = window.HIRECRAFT_FILL.fileFromDataUrl(
        pdf.data.dataUrl,
        `${preferred.name.replace(/\s+/g, "_")}.pdf`
      );
    }
  }

  state.resumeId = preferred?.id || null;
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
}

async function runTrack() {
  state.busy = true;
  setStatus("Recording this application…");
  const reply = await ask({
    type: "track",
    url: location.href,
    resumeId: state.resumeId,
  });
  Object.assign(state, {
    busy: false,
    tracked: reply.ok,
    status: reply.ok ? "Saved to your HireCraft tracker." : reply.error,
  });
  render();
}

// --- mounting ----------------------------------------------------------------

function mount() {
  if (document.getElementById(ROOT_ID)) return;
  if (!looksLikeApplicationForm()) return;
  const root = el("div", "hc-root");
  root.id = ROOT_ID;
  document.body.append(root);
  render();
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
