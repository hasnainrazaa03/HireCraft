# HireCraft Job Clipper (Chrome extension)

A minimal Manifest V3 extension that grabs the job posting on the current tab and
hands it to the HireCraft web app so you can tailor a résumé to it in one click.

## What it does

- Extracts the job posting with **ATS-aware selectors** — Greenhouse, Lever,
  Ashby, Workday, LinkedIn, and Indeed each have targeted description/title/
  company selectors, so you get the clean role text (and title + company),
  not the whole chrome-heavy page. Falls back to a generic job/description
  container, then the page body, on any other site.
- **Copy** puts that text on your clipboard to paste into HireCraft.
- **Clip & open** stashes the text and opens `…/new?clip=1` in the HireCraft app.

## Privacy / scope

- No credentials live in the extension. You stay signed in to the web app; the
  extension only deep-links into it.
- It reads only the tab you explicitly click it on (`activeTab`), and sends the
  text nowhere except your own clipboard / your own HireCraft instance.
- No background scraping, no third-party servers.

## Install (developer mode)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this `extension/` folder.
3. Set your HireCraft URL in the popup (defaults to `http://localhost:5173`).

> Note: `icon128.png` is intentionally omitted from the repo — add any 128×128
> PNG before packaging for the Chrome Web Store. The web app reads the clipboard
> (reliable across browsers); the `clippedJob` in `chrome.storage` (text, title,
> company, url, source) is available for a tighter same-origin integration later.
