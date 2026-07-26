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
