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
      // Prefer an obvious job container; fall back to the whole body.
      const main =
        document.querySelector("main, article, [class*='job'], [class*='description']") ||
        document.body;
      return {
        text: (main.innerText || "").trim().slice(0, 18000),
        title: document.title,
        url: location.href,
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
    const { text, url } = await grabPageText();
    const base = (appUrlEl.value.trim() || DEFAULT_APP).replace(/\/$/, "");
    // Stash the clipped text so the app can pre-fill the new-application form.
    await chrome.storage.local.set({ clippedJob: { text, url } });
    await navigator.clipboard.writeText(text).catch(() => {});
    chrome.tabs.create({ url: `${base}/new?clip=1` });
    statusEl.textContent = "Opening HireCraft…";
  } catch (e) {
    statusEl.textContent = "Couldn't clip this page.";
  }
});
