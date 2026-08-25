/**
 * HireCraft Job Clipper — popup logic.
 *
 * Extracts the visible text of the active tab, then either copies it or hands it
 * to the HireCraft web app's new-application flow (via a URL param the app reads).
 * No credentials live in the extension: the user is already signed in to the web
 * app, so we just deep-link into it — nothing is scraped or sent anywhere else.
 */

const DEFAULT_APP = "http://localhost:5173";
const statusEl = document.getElementById("status");
const appUrlEl = document.getElementById("appUrl");

// Remember the user's HireCraft URL between sessions.
chrome.storage.local.get(["appUrl"], ({ appUrl }) => {
  appUrlEl.value = appUrl || DEFAULT_APP;
});
appUrlEl.addEventListener("change", () => {
  chrome.storage.local.set({ appUrl: appUrlEl.value.trim() || DEFAULT_APP });
});

async function grabPageText() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // Per-ATS selectors so we grab the clean job description + title/company
      // instead of the whole chrome-heavy page. Ordered [descriptionSel, titleSel,
      // companySel]; the first host match wins, else a generic fallback.
      const ATS = [
        {
          host: /greenhouse\.io/,
          desc: "#content, .job__description, [class*='job-post']",
          title: ".app-title, .job__title h1, h1",
          company: ".company-name, .job__company",
        },
        {
          host: /lever\.co/,
          desc: "[data-qa='job-description'], .section-wrapper, .content-wrapper",
          title: ".posting-headline h2, h2",
          company: ".main-header-logo img",
        },
        {
          host: /ashbyhq\.com/,
          desc: "[class*='_description'], .ashby-job-posting-right-pane, main",
          title: "h1",
          company: "[class*='_companyName'], a[href*='ashbyhq']",
        },
        {
          host: /myworkdayjobs\.com/,
          desc: "[data-automation-id='jobPostingDescription']",
          title: "[data-automation-id='jobPostingHeader'], h1, h2",
          company: "",
        },
        {
          host: /linkedin\.com/,
          desc: ".jobs-description__content, .show-more-less-html__markup, .description__text",
          title: ".job-details-jobs-unified-top-card__job-title, .topcard__title, h1",
          company: ".job-details-jobs-unified-top-card__company-name, .topcard__org-name-link",
        },
        {
          host: /indeed\.com/,
          desc: "#jobDescriptionText",
          title: ".jobsearch-JobInfoHeader-title, h1",
          company: "[data-company-name], .jobsearch-CompanyInfoContainer a",
        },
      ];

      const pick = (sel) => {
        for (const s of (sel || "").split(",").map((x) => x.trim()).filter(Boolean)) {
          const el = document.querySelector(s);
          if (el) {
            if (el.tagName === "IMG") return (el.getAttribute("alt") || "").trim();
            const t = (el.innerText || "").trim();
            if (t) return t;
          }
        }
        return "";
      };

      const ats = ATS.find((a) => a.host.test(location.host));
      let descEl = null;
      if (ats) {
        for (const s of ats.desc.split(",").map((x) => x.trim())) {
          descEl = document.querySelector(s);
          if (descEl) break;
        }
      }
      const container =
        descEl ||
        document.querySelector("main, article, [class*='job'], [class*='description']") ||
        document.body;

      const title = (ats && pick(ats.title)) || document.title;
      const company = ats ? pick(ats.company) : "";
      return {
        text: (container.innerText || "").trim().slice(0, 18000),
        title: (title || "").slice(0, 200),
        company: (company || "").slice(0, 120),
        url: location.href,
        source: ats ? ats.host.source.replace(/\\\./g, ".").replace(/[^a-z.]/gi, "") : "page",
      };
    },
  });
  return result;
}

document.getElementById("copy").addEventListener("click", async () => {
  try {
    const { text } = await grabPageText();
    await navigator.clipboard.writeText(text);
    statusEl.textContent = "Copied the job text — paste it into HireCraft.";
  } catch (e) {
    statusEl.textContent = "Couldn't read this page.";
  }
});

document.getElementById("clip").addEventListener("click", async () => {
  try {
    const job = await grabPageText();
    const base = (appUrlEl.value.trim() || DEFAULT_APP).replace(/\/$/, "");
    // The web app is an ordinary page — it cannot read chrome.storage, so
    // stashing the clip there (as this used to) meant the title and company we
    // worked to extract were simply thrown away. Small fields ride in the query
    // string; only the description is too big for a URL, so that goes on the
    // clipboard.
    await navigator.clipboard.writeText(job.text).catch(() => {});
    const params = new URLSearchParams({ clip: "1" });
    if (job.title) params.set("title", job.title);
    if (job.company) params.set("company", job.company);
    chrome.tabs.create({ url: `${base}/new?${params}` });
    const detected = job.source && job.source !== "page" ? ` (${job.source})` : "";
    statusEl.textContent = `Clipped${detected} — opening HireCraft…`;
  } catch (e) {
    statusEl.textContent = "Couldn't clip this page.";
  }
});

// --- autofill: connect, and inspect a form -----------------------------------

const DEFAULT_API = "http://localhost:8000";
const apiUrlEl = document.getElementById("apiUrl");
const extKeyEl = document.getElementById("extKey");
const connEl = document.getElementById("connStatus");
const inspectOut = document.getElementById("inspectOut");

chrome.storage.local.get(["apiUrl", "extensionKey"], ({ apiUrl, extensionKey }) => {
  apiUrlEl.value = apiUrl || DEFAULT_API;
  // Show that a key is stored without redisplaying it: the real one is never
  // recoverable from HireCraft either, so echoing it here would be the only
  // place it could leak from.
  if (extensionKey) extKeyEl.placeholder = "•••••••• (saved)";
});

function say(text, isError) {
  connEl.textContent = text;
  connEl.classList.toggle("err", Boolean(isError));
}

document.getElementById("connect").addEventListener("click", async () => {
  const api = (apiUrlEl.value.trim() || DEFAULT_API).replace(/\/$/, "");
  const typed = extKeyEl.value.trim();
  const stored = (await chrome.storage.local.get(["extensionKey"])).extensionKey;
  const key = typed || stored;
  if (!key) {
    say("Paste the key from Settings → Extension.", true);
    return;
  }

  await chrome.storage.local.set({ apiUrl: api, extensionKey: key });
  say("Checking…");
  const reply = await chrome.runtime.sendMessage({ type: "ping" });
  if (!reply?.ok) {
    say(reply?.error || "Couldn't connect.", true);
    return;
  }
  const { profile } = reply.data;
  extKeyEl.value = "";
  extKeyEl.placeholder = "•••••••• (saved)";
  const resumes = profile.resumes?.length || 0;
  say(`Connected as ${profile.email} · ${resumes} résumé${resumes === 1 ? "" : "s"}`);
});

document.getElementById("inspect").addEventListener("click", async () => {
  // Two of the three ATSs render their forms client-side, so this is how an
  // adapter gets written or a stopped-working page gets diagnosed: it prints the
  // label the filler actually resolved for every control on the page.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () =>
        window.HIRECRAFT_FILL
          ? window.HIRECRAFT_FILL.inspectForm()
          : "HireCraft isn't active on this page (it runs on Greenhouse, Ashby and Lever).",
    });
    inspectOut.hidden = false;
    inspectOut.textContent =
      typeof result === "string"
        ? result
        : result.length
          ? result
              .map((f) => `${f.tag}${f.type ? `[${f.type}]` : ""}  ${f.label || "(no label)"}\n    → ${f.normalised}`)
              .join("\n")
          : "No fillable controls found on this page.";
    say(typeof result === "string" ? "" : `${result.length || 0} controls found`);
  } catch (error) {
    say("Couldn't read this page.", true);
  }
});

document.getElementById("visa").addEventListener("click", async () => {
  // Works on any job page, not only the three ATSs the content script runs on:
  // activeTab grants access to the current tab on click, so a posting sent by a
  // friend or living on a company's own careers site can be checked too —
  // without asking for permission to read every site the user visits.
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["autofill/visa.js"],
    }).then(() =>
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.HIRECRAFT_VISA.classifyVisa(),
      })
    );

    const LABEL = {
      sponsors: ["Sponsors visas", false],
      no_sponsorship: ["Will not sponsor", true],
      citizenship_required: ["US citizens only", true],
      clearance_required: ["Security clearance required", true],
      unstated: ["Sponsorship not mentioned", false],
    };
    const [text, blocks] = LABEL[result.verdict] || LABEL.unstated;
    inspectOut.hidden = false;
    inspectOut.textContent = result.evidence
      ? `${text}\n\n…${result.evidence}…`
      : `${text}\n\nNothing in this posting mentions sponsorship either way. That is the\ncommon case — three postings in five say nothing — so it is not a no.`;
    say(text, blocks);
  } catch (error) {
    say("Couldn't read this page.", true);
  }
});
