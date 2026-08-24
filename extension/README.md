# HireCraft (Chrome extension)

Two things: clip a job posting into HireCraft, and fill its application form with
your own details and résumé.

## Autofill

On a **Greenhouse, Ashby or Lever** application page a small HireCraft panel
appears bottom-right. Click **Fill this form** and it enters your name, email,
phone, location, LinkedIn/GitHub/portfolio and years of experience, and attaches
your résumé as a PDF. **Track application** records it in your HireCraft tracker
without a tailoring run, so applying logs itself.

### It never submits

The panel fills and stops. Lever's apply form carries an hCaptcha, so automated
submission would not work there anyway — but the real reason is that an
application cannot be un-sent. Check what it filled, then submit it yourself.

### It leaves some questions alone, on purpose

Race, ethnicity, gender, pronouns, disability, veteran status and date of birth
are yours to answer; HireCraft stores nothing for them, and putting a default in
one would be inventing an answer. Salary is skipped too — a stored range is a
preference, not a number to commit to without reading the posting.

### It tells you what it did

Every fill reports which fields were filled, which were left for you, and which
it could not find. A filler that silently skips something is worse than one that
does nothing, because you submit assuming it worked.

## Setup

1. In HireCraft: **Settings → Extension → Create key**, and copy it. It is shown
   once — only a hash is stored.
2. `chrome://extensions` → **Developer mode** → **Load unpacked** → this folder.
3. Open the popup, paste the key under **Autofill**, click **Connect**. It should
   report your email and how many résumés it can see.

## When a site stops filling

Greenhouse and Ashby build their forms in the browser, so their markup changes
without warning. **Inspect this form** in the popup prints every control on the
page with the label the filler actually resolved for it — which is how to see
whether a field was renamed, and what to add to `autofill/adapters.js`.

## How it works

- `autofill/fields.js` — what to fill and the label patterns that identify it.
- `autofill/fill.js` — resolves each control's accessible label, then sets values
  through the native property setter with `input`/`change` events, because these
  forms are React-controlled and a plain `el.value = x` is silently discarded.
- `autofill/adapters.js` — per-ATS corrections. Deliberately near-empty: entries
  belong here only once the generic matcher is *proven* wrong on a real page.
- `background.js` — the only place that talks to the API. The key never enters
  the employer's page, and MV3 content scripts are subject to CORS while the
  service worker is not.

Run the field-matching tests with `node --test extension/test/fields.test.mjs` —
no dependencies.

## Clipping

- **Clip & open** grabs the posting with ATS-aware selectors (Greenhouse, Lever,
  Ashby, Workday, LinkedIn, Indeed) and opens HireCraft's new-application flow.
- **Copy** puts the text on your clipboard instead.

## Privacy / scope

- The extension key reaches three endpoints: the details it fills, your résumé
  PDF, and recording an application. It cannot change your account or start a
  paid AI run, and revoking it in Settings stops it immediately.
- Content scripts run on Greenhouse, Ashby and Lever only — not on every site.
- Nothing is sent anywhere except your own HireCraft instance.

## Icons

The icons are the app's own logo (`frontend/public/favicon.svg`), rasterised —
Chrome will not accept an SVG for an extension icon, and it refuses to load an
unpacked extension whose manifest names an icon that isn't there.

Regenerate with `tools/make-icons.sh` after changing the logo, rather than
editing the PNGs.
