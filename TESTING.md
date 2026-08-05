# HireCraft — Full Testing Guide

> A living, click-by-click test plan for the whole product. Work top to bottom,
> mark each case, and jot findings inline. We'll update this doc as we fix things.

---

## How to use this doc

- **App:** http://localhost:5173 (frontend) · API at http://localhost:8000
- **Mark each case** by replacing the box: `⬜` untested → `✅` pass · `❌` fail · `⚠️` works-but-rough.
- **Write findings** on the `Notes:` line under a case — screenshot filename, exact text, what you expected vs. saw.
- **Test IDs** (e.g. `T-JOB-04`) are stable handles so we can talk about a specific case.
- When a case fails, keep going — note it and move on; we'll batch fixes.

**Two accounts help:**
- **Your account** (`hasnainrazaa03@gmail.com`) — already has a résumé, 26 brag-bank facts, 1 application. Best for the "rich data" flows.
- **A throwaway** (register a new `+test@…`) — best for first-run / empty-state flows (Section 1–2).

**The product's signature promise to keep testing everywhere:** *bold but never fabricated.* Any AI output (résumé bullets, cover letters, STAR answers) must only state things your résumé **or brag bank** support. If you ever catch it inventing a number, tool, employer, or credential — that's a **P0 bug**; note it loudly.

**Severity tags for your notes:** `P0` breaks a core promise / data loss · `P1` blocks a flow · `P2` wrong-but-recoverable · `P3` cosmetic.

---

## 0. Quick smoke test (5 min — do this first each session)

Confirms the app is up before deep testing.

- ✅ **T-SMOKE-01** Load http://localhost:5173 — you land on Login or Dashboard, no console errors (open DevTools console).
  - Notes: PASS. Unauthenticated → auto-redirects to `/login`; page loads; no JS errors/warnings (only the default DevTools info message).
- ⬜ **T-SMOKE-02** Sign in — Dashboard renders with your name and stat cards.
  - Notes:
- ⬜ **T-SMOKE-03** Every left-nav item opens without a blank screen or error: Dashboard, Copilot, Applications, Resumes, Career Profile, Writing Voice, Cover Letters, Company Intel, Interview Prep, Job Search, Analytics, Templates.
  - Notes:
- ⬜ **T-SMOKE-04** Job Search shows cards; open one job's **View More** modal; close it.
  - Notes:

---

## 1. Authentication & onboarding

> Use a **throwaway account** for this section. Emails are logged, not sent (no
> SMTP), so you never need to receive a real email — verification links appear in
> the app or can be skipped.

### 1.1 Sign up
- ✅ **T-AUTH-01** From Login, switch to **Sign up**. Register with a new email + password + name.
  - *Expected:* lands on the Dashboard (empty state); no forced email-verification wall.
  - Notes: PASS. Throwaway registered → straight to Dashboard empty state ("No applications yet"); no verification wall; "Confirm your email" banner shown (expected). Server-side verified: user row created, `is_active=true`, `is_verified=false`.
- ✅ **T-AUTH-02** Try registering the **same email again** → clear "already exists" style error, no crash.
  - Notes: PASS. Duplicate email → "An account with that email already exists." (matches code `auth.py:134`); registration blocked, form state preserved, no crash.
- ✅ **T-AUTH-03** Weak/short password and malformed email are rejected with a readable message.
  - Notes: PASS (re-tested after fix). Invalid email → browser HTML5 message ✅. Weak password → now shows the specific reason (was generic "Validation failed." — Issue #1, fixed via `parseError` humanizing field errors + `minLength` on the register field). Resolved.
- ✅ **T-AUTH-04** A yellow **"Confirm your email"** banner appears at the top. Click **Resend link** → success toast; **Dismiss (×)** hides it.
  - Notes: PASS. Banner shown; Resend → "Verification sent / Check your inbox" toast; × dismisses cleanly without affecting the page.

### 1.2 Login / logout / session
- ✅ **T-AUTH-05** Log out (top-right avatar → Log out) → back to Login.
  - Notes: PASS. Avatar → Log out → redirected to Login; session terminated, no errors.
- ✅ **T-AUTH-06** Log back in with correct credentials → Dashboard.
  - Notes: PASS. Valid credentials → authenticated → Dashboard loads; session established, no errors.
- ✅ **T-AUTH-07** Wrong password → clear error, no crash; repeated wrong attempts don't lock you out permanently.
  - Notes: PASS. Wrong password → "Incorrect email or password." (same message whether or not the email exists — no user enumeration, verified in code `auth.py:164/171`); UI stable, no crash.
- ✅ **T-AUTH-08** Refresh the page while logged in → stays logged in (no bounce to Login).
  - Notes: PASS. Both normal (Ctrl+R) and hard (Cmd+Shift+R) refresh keep the session; Dashboard reloads, no redirect to Login.

### 1.3 Password reset & email verify
- ✅ **T-AUTH-09** Login → **Forgot password** → submit your email → confirmation message (no leak of whether the email exists).
  - Notes: PASS. "If an account exists for … a reset link is on its way. It expires in 30 minutes." — no enumeration; "Back to sign in" provided. Verified server-side: a reset token was generated in the logs.
- ✅ **T-AUTH-10** (Optional) Grab the reset link from the API logs and open it → set a new password → can log in with it.
  - Notes: PASS — verified E2E by Claude on a throwaway (to avoid resetting the active test account): register→forgot→token-from-logs→reset-password (200) → **old password now 401, new password 200**. Full reset flow works.
- ✅ **T-AUTH-11** (Optional) Open a `verify-email?token=…` link → badge flips to verified / banner disappears.
  - Notes: PASS — verified E2E by Claude on the active throwaway: resend (200) → verify-email (200, "Your email is verified.") → DB `is_verified=true`. **UI check for user:** reload Dashboard → the "Confirm your email" banner is gone.

### 1.4 Devices / sessions (Settings → Devices)
- ⬜ **T-AUTH-12** Settings → **Devices** lists your active session(s) with device/time.
  - Notes:
- ⬜ **T-AUTH-13** **Log out everywhere** → you're signed out; old session no longer valid.
  - Notes:

---

## 2. Dashboard

- ⬜ **T-DASH-01** Top stat cards read sensibly: **Total applications**, **In progress**, **Interviewing**, **Offers**.
  - Notes:
- ⬜ **T-DASH-02** **Application pipeline** widget shows columns **Preparing · Applied · Screening · Interviewing · Offer · Closed** and your app appears in the *correct* column for its stage (a fresh tailoring = **Preparing**, not Applied).
  - Notes:
- ⬜ **T-DASH-03** **Recent activity** lists real events (tailoring started/ready) with times.
  - Notes:
- ⬜ **T-DASH-04** **Quick actions** (Tailor résumé, My résumés, Applications, Analytics) each navigate correctly.
  - Notes:
- ⬜ **T-DASH-05** Empty account: Dashboard shows a friendly empty state, not zeros-everywhere confusion.
  - Notes:
- ⬜ **T-DASH-06** "Good morning/afternoon/evening" greeting matches the time of day.
  - Notes:

---

## 3. Career Profile  (`/profile`)

### 3.1 Basics & links
- ⬜ **T-PROF-01** Edit **Professional headline**, **Location** → **Save changes** → success toast; reload → values persisted.
  - Notes:
- ⬜ **T-PROF-02** Fill **LinkedIn / GitHub / Portfolio / Website** with valid URLs → saves. A clearly-invalid URL is rejected with a readable error.
  - Notes:

### 3.2 Phone with country code (new)
- ⬜ **T-PROF-03** Click the **country button** (flag + dial code) → dropdown opens with a search box and a long country list.
  - Notes:
- ⬜ **T-PROF-04** Search **"india"** → select India → button shows 🇮🇳 **+91**. Search **"+44"** → United Kingdom appears.
  - Notes:
- ⬜ **T-PROF-05** Type a phone number → Save → reload → the **country + number both restore** correctly (e.g. `+1 2139945086` shows US selected + the number).
  - Notes:
- ⬜ **T-PROF-06** Clicking outside the dropdown closes it; keyboard/tab reaches the field.
  - Notes:

### 3.3 Eligibility dropdowns (new)
- ⬜ **T-PROF-07** **Work authorization** is now a dropdown (US Citizen / Green Card / sponsorship options / EU-UK / Other) — pick one, save, reload → persists.
  - Notes:
- ⬜ **T-PROF-08** **Visa status** dropdown is exhaustive (F-1, OPT, **STEM OPT**, CPT, H-1B, H-4 EAD, L-1/L-2, J-1, O-1, TN, E-3, Green Card, Asylum, DACA, Other) — select **F-1 STEM OPT**, save, reload.
  - Notes:

### 3.4 Preferences, salary & pay period (new)
- ⬜ **T-PROF-09** **Preferred roles / industries / locations** tag inputs: add with Enter, remove with ×, persist on save.
  - Notes:
- ⬜ **T-PROF-10** **Salary min/max** + new **Pay period** dropdown (Per year / month / week / hour). Set 120k–160k, **Per year**, save, reload → persists.
  - Notes:
- ⬜ **T-PROF-11** Set salary **max < min** → clear validation error, save blocked.
  - Notes:
- ⬜ **T-PROF-12** **Work arrangement** (remote/hybrid/onsite/flexible) + **Open to relocation** checkbox persist.
  - Notes:

### 3.5 Brag Bank (bottom of Career Profile)
> This is the substrate for "grounded persuasion" — everything the AI is *allowed*
> to say. Your account is pre-seeded with **26 facts**.

- ⬜ **T-BRAG-01** The Brag Bank section lists facts **grouped by role/project** (Deloitte · DRDO · Prana.ai · USC Ledger · Team Antariksh · …) each with a **kind badge** (Impact / Scope / Skill / Achievement / Context) and a count.
  - Notes:
- ⬜ **T-BRAG-02** **Add fact** → pick a kind, type a role label + text → Add → appears under the right group instantly.
  - Notes:
- ⬜ **T-BRAG-03** **Edit** a fact (hover on desktop, always-visible on touch) → change text → Save → updates.
  - Notes:
- ⬜ **T-BRAG-04** **Delete** a fact → it's removed.
  - Notes:
- ⬜ **T-BRAG-05** Add the **metrics / recent-USC / leadership** facts you flagged earlier — these should later lift tailoring/interview quality (verify in Sections 7 & 10).
  - Notes:
- ⬜ **T-BRAG-06** Very short text (< 3 chars) is rejected; long text is accepted.
  - Notes:

---

## 4. Résumés  (`/resumes`)

### 4.1 Import / parse
- ⬜ **T-RES-01** **New / Import** → upload `~/Downloads/MHR_ML.pdf`. Parsing runs (~a few seconds, one LLM call) → lands in the **builder** pre-filled.
  - Notes:
- ⬜ **T-RES-02 (P0 check)** In the builder, **Experience dates are present** (e.g. Deloitte 2022-08 → 2024-11) — the previously-broken case. Education + project dates too.
  - Notes:
- ⬜ **T-RES-03** Parsed structure is complete: 3 experience, 2 education, 2 projects, skills groups; bullets not clipped.
  - Notes:
- ⬜ **T-RES-04** Upload a **non-résumé / garbage file** or a corrupt PDF → friendly error, no crash.
  - Notes:
- ⬜ **T-RES-05** (Optional) Upload a **.docx** and a **.json** résumé — both import.
  - Notes:

### 4.2 Builder (structured editing)
- ⬜ **T-RES-06** Sections are **collapsible cards** with entry counts; expand/collapse works.
  - Notes:
- ⬜ **T-RES-07** Long **bullets auto-grow** to show full text (no mid-sentence clipping).
  - Notes:
- ⬜ **T-RES-08** Add / remove / reorder (↑↓) an experience entry and a bullet; add a skill group.
  - Notes:
- ⬜ **T-RES-09** **Basics → ✨ Generate with AI** fills **Headline + Summary** from your experience. Read them: are they truthful (no invented metrics/tools)? Editable after.
  - Notes:
- ⬜ **T-RES-10** Generate-intro with an almost-empty résumé → graceful "add experience first" message (no crash).
  - Notes:
- ⬜ **T-RES-11** **Save** → success; new résumé appears in the list; set as **Default** works.
  - Notes:

### 4.3 Analyze / score / versions / render
- ⬜ **T-RES-12** Open a résumé's **analysis** (score / grade / ATS checks / per-metric breakdown / findings). Numbers look reasonable.
  - Notes:
- ⬜ **T-RES-13** **Rewrite** (job-agnostic AI improvement) → shows before/after + diff + guardrail report; **nothing saved** until you accept; save as a new **version**.
  - Notes:
- ⬜ **T-RES-14** **Versions** list; open a past version; **restore** it.
  - Notes:
- ⬜ **T-RES-15** **Download** the résumé as **PDF**, **DOCX**, **LaTeX** — all produce valid files; PDF opens and looks clean.
  - Notes:
- ⬜ **T-RES-16** Long résumé name **truncates** in the list (doesn't break the row).
  - Notes:

---

## 5. Templates  (`/templates`)

- ⬜ **T-TMPL-01** Four templates shown: **Modern · ATS · Minimal · Academic**.
  - Notes:
- ⬜ **T-TMPL-02** Click a template → **preview modal** renders *your default résumé* in that template as a PDF.
  - Notes:
- ⬜ **T-TMPL-03** Preview each of the four; the modal caps to the viewport and scrolls (no lost close button).
  - Notes:
- ⬜ **T-TMPL-04** Apply/select a template for a résumé → subsequent renders use it.
  - Notes:

---

## 6. Job Search  (`/jobs`)

### 6.1 Recommended feed & search
- ⬜ **T-JOB-01** Land on Job Search with an **empty search box** → a **"Recommended for your profile"** banner + roles matched to your résumé (e.g. Machine Learning Engineer), not random jobs.
  - Notes:
- ⬜ **T-JOB-02** Search **"machine learning engineer"** → relevant results; the grid **does not blank to a spinner** — old results stay with a subtle fade while loading.
  - Notes:
- ⬜ **T-JOB-03** Footer shows **"Aggregated from GitHub · Arbeitnow · …"** (multiple real sources).
  - Notes:
- ⬜ **T-JOB-04 (P1 check)** Match scores are **granular and sensible** (e.g. 76, 73, 69 — not all 100%, not all round multiples of 5). A clearly off-domain search (e.g. **"nurse"** or **"SEO manager"**) scores **low**, an ML role scores **high**.
  - Notes:

### 6.2 Cards & interactions
- ⬜ **T-JOB-05** Each card: **company logo** (or clean initials fallback), title, company, location, **match ring** (color by score, verdict), skill chips, "Posted · source".
  - Notes:
- ⬜ **T-JOB-06** **Flip** a card (↻ top-right) → quick analysis (strengths ✓ / gaps ⚠ / interview chance); flip back.
  - Notes:
- ⬜ **T-JOB-07** **Save** (bookmark) a job → persists across reloads; saving one job doesn't mark others saved.
  - Notes:
- ⬜ **T-JOB-08** **View More** → centered modal with tabs **Overview · Match Analysis · Requirements · Recruiters**; each renders; ✕ / Esc / click-outside close it.
  - Notes:
- ⬜ **T-JOB-09** No fake data: cards/modal should **not** show a hardcoded "Full Time" or invented fields.
  - Notes:
- ⬜ **T-JOB-10** Filters: **Remote only** toggle and **Sort: Best match / Newest** change the list.
  - Notes:

### 6.3 Hand-off to tailoring
- ⬜ **T-JOB-11** Click **Tailor Resume** (card or modal) → routes to New Application pre-filled with that job. (Continue in Section 7.)
  - Notes:

---

## 7. Tailoring pipeline  (New Application → Application detail)  ⭐ core flow

### 7.1 Create
- ⬜ **T-TLR-01** `/new`: **Master résumé** dropdown shows your default; **From URL / Paste text** toggle; **Also draft a cover letter** checkbox.
  - Notes:
- ⬜ **T-TLR-02** Paste an **Ashby/Greenhouse/Lever** job URL (e.g. `jobs.ashbyhq.com/…`) → **Tailor my résumé** → it fetches via the ATS API (no "couldn't read" error) and starts the run.
  - Notes:
- ⬜ **T-TLR-03** Paste a **JS-heavy board** URL (e.g. `jobs.bytedance.com/…`) → friendly **"couldn't read that link — paste the text instead"** (graceful, no junk application).
  - Notes:
- ⬜ **T-TLR-04** **Paste text** mode with a real JD → run.
  - Notes:
- ⬜ **T-TLR-05** No default résumé on the account → the form tells you to add a master résumé first.
  - Notes:

### 7.2 Run & progress
- ⬜ **T-TLR-06** After submit → redirect to the Application page showing **live progress** (Reading job → Tailoring → Typesetting). Completes in ~30–60s.
  - Notes:
- ⬜ **T-TLR-07** During the run the page doesn't flash blank "Loading…" repeatedly.
  - Notes:

### 7.3 Result & review
- ⬜ **T-TLR-08** **Résumé quality scorecard** appears: overall /100 + bars (Job-fit keywords · Quantified impact · Action-verb strength · Conciseness · Truthfulness). Numbers make sense for the role's fit.
  - Notes:
- ⬜ **T-TLR-09** **Changes** tab: before→after diff is accurate; a harmless skill *regroup* is not reported as "deleted everything".
  - Notes:
- ⬜ **T-TLR-10 (P0 check)** **Guardrails** tab: locks shown; any flagged/removed claims are genuinely unsupported. **Read the tailored bullets** — every claim traces to your résumé or brag bank. If a brag-bank fact (e.g. **$50K pre-seed**, leadership, containerized deployment) is surfaced, confirm it's *yours* and not invented.
  - Notes:
- ⬜ **T-TLR-11** **Match / Requirements** tabs render coverage sensibly.
  - Notes:
- ⬜ **T-TLR-12** **Download** the tailored **PDF** and the **package** (zip) — open the PDF, it's clean and reflects the changes.
  - Notes:
- ⬜ **T-TLR-13** **Two-stage lift:** tailor to a role slightly outside your core (e.g. a backend/distributed-systems JD). The engine should surface your genuinely-relevant backend evidence (REST, distributed, Postgres) — relevance/keywords higher than a naive pass, still truthful.
  - Notes:
- ⬜ **T-TLR-14** **Retry** on a failed/blocked run re-runs; **Delete** an application removes it (and it disappears from the board + dashboard funnel).
  - Notes:

---

## 8. Applications Tracker  (`/applications`)

- ⬜ **T-APP-01** **Board view**: kanban columns; your application sits in the right column; **drag** it Preparing → Applied → Interviewing and it **persists** (reload).
  - Notes:
- ⬜ **T-APP-02** Moving to **Interviewing** updates the Dashboard's Interviewing count and Analytics (Section 12).
  - Notes:
- ⬜ **T-APP-03** A **failed drag** (simulate offline if you can) rolls back with a toast, not a silent snap.
  - Notes:
- ⬜ **T-APP-04** **List view** toggle (segmented control) shows a table with stage `<select>` (clean arrow, no double chevron) + cost.
  - Notes:
- ⬜ **T-APP-05** **Search** by role/company filters both views.
  - Notes:
- ⬜ **T-APP-06** Total count is accurate (if you had many apps, the count matches, not capped at a page size).
  - Notes:
- ⬜ **T-APP-07** Open an application → set **Interview date** and **Follow-up reminder** (they save on blur, not per keystroke).
  - Notes:

---

## 9. Cover Letters & Outreach  (`/cover-letters`)

### 9.1 Cover letter
- ⬜ **T-CL-01** Pick résumé; **Job description or link** field: paste an **Ashby URL** → generates; **Company & Role auto-fill** from the posting; the letter is addressed to the **real company** (not "the company").
  - Notes:
- ⬜ **T-CL-02** Paste **plain text** JD → works. Paste a JS-board URL → friendly "paste text instead".
  - Notes:
- ⬜ **T-CL-03** The preview reads as a **real letter**: greeting ("Dear Hiring Team at …,") → 3–4 body paragraphs → "Sincerely," → your name. Not just naked paragraphs.
  - Notes:
- ⬜ **T-CL-04 (P0 check)** Guardrail badge if a sentence was removed for being unsupported. Read the letter — truthful, specific, uses brag-bank facts where relevant.
  - Notes:
- ⬜ **T-CL-05** Change **Tone** (Traditional / Modern / Short / Enthusiastic / Formal / Startup / Research / Academic) → regenerate → register/voice changes, facts don't.
  - Notes:
- ⬜ **T-CL-06** **Write in my saved writing voice** checkbox (needs a Writing Voice — Section 11) changes the style.
  - Notes:
- ⬜ **T-CL-07** **Copy text** copies the full letter (greeting + body + sign-off). **PDF / DOCX / LaTeX** export (spinner while working) produce valid files.
  - Notes:
- ⬜ **T-CL-08** If every sentence gets removed as unsupported → the "nothing to hand you" explanation shows (no empty letter).
  - Notes:

### 9.2 Outreach
- ⬜ **T-OUT-01** Switch to **Outreach**: pick a **message type** (Recruiter email / LinkedIn note / Follow-up / Thank-you / Interview check-in / Referral request / Offer negotiation) — description updates.
  - Notes:
- ⬜ **T-OUT-02** **Generate message** is disabled until **Company** is entered; add company/role/recipient/context → generate.
  - Notes:
- ⬜ **T-OUT-03** Message is short, specific, truthful; respects the chosen kind; can copy.
  - Notes:

---

## 10. Interview Prep  (`/interview`)

- ⬜ **T-INT-01** Pick **role/company** + **categories** (Behavioral, Technical, Résumé, Project, Company, System Design, Coding, General) → **Generate questions** → ~8 questions, **specific to your résumé** (they reference your real projects/companies).
  - Notes:
- ⬜ **T-INT-02** Ask for a **STAR answer** to a question → returns **Situation / Task / Action / Result**, grounded in your experience.
  - Notes:
- ⬜ **T-INT-03 (brag-bank check)** A STAR answer pulls **attested specifics** from your brag bank (e.g. "Welch two-sample t-test on 2,500+ samples", "6-DOF solver", "$50K pre-seed") rather than staying vague. Confirm those specifics are truthful.
  - Notes:
- ⬜ **T-INT-04** **Write in my voice** applies the saved writing voice.
  - Notes:
- ⬜ **T-INT-05** Answer to a question about experience you *don't* have → it stays honest (doesn't invent) or picks the closest real experience.
  - Notes:

---

## 11. Writing Voice  (`/writing`)

- ⬜ **T-WV-01** Add **samples** of your writing (kind: cover letter / email / SOP / other) — paste text, title optional → added to the list.
  - Notes:
- ⬜ **T-WV-02** **Analyze** → produces a **voice profile** (tone, formality, sentence style, habits) after ~1 LLM call.
  - Notes:
- ⬜ **T-WV-03** Delete a sample; re-analyze reflects the change.
  - Notes:
- ⬜ **T-WV-04** With a voice saved, cover letters / outreach / STAR answers with "use my voice" read noticeably more like you (compare on vs off).
  - Notes:

---

## 12. Copilot  (`/copilot`)

- ⬜ **T-COP-01** Ask **"What roles am I most competitive for, and my biggest gap?"** → a grounded answer citing your real résumé/score/data (not generic advice).
  - Notes:
- ⬜ **T-COP-02** The reply can draw on your **brag bank** and **application/guardrail** data (ask "why was anything removed from my Rainmaker tailoring?").
  - Notes:
- ⬜ **T-COP-03** Focus a **specific résumé / application** (if the UI offers it) and ask a targeted question → answer scoped to it.
  - Notes:
- ⬜ **T-COP-04** **Model/provider switcher** (if shown) changes which model answers; dropdown renders cleanly (native to the theme, text not clipped).
  - Notes:
- ⬜ **T-COP-05 (P0 check)** Copilot only states things backed by your data — if it invents a fact about you, note it.
  - Notes:

---

## 13. Company Intel  (`/companies`)

- ⬜ **T-CI-01** Enter a **company** (+ optional role) → **Research** → a brief with overview, what-they-do, likely interview focus, etc.
  - Notes:
- ⬜ **T-CI-02** Add a **public URL** or **paste page text** for grounding → the brief reflects it (and `used_grounding` is true).
  - Notes:
- ⬜ **T-CI-03** **Recruiter/contact guidance** is present and **compliant** — it explains legitimate ways to find a contact, and does **not** scrape/produce private personal contact data.
  - Notes:
- ⬜ **T-CI-04** The "add a public page" input and the "Research" button don't overlap; layout is clean.
  - Notes:

---

## 14. Analytics  (`/analytics`)

- ⬜ **T-ANL-01** **Response / Interview / Offer rates** + **Avg résumé score** cards read consistently with your funnel.
  - Notes:
- ⬜ **T-ANL-02** **Funnel** (Submitted / Interviewing / Offers) and **Applications over time** chart match your real data.
  - Notes:
- ⬜ **T-ANL-03 (P2 check)** **Top performer** card: only says "Landed N interviews" when a résumé *actually* reached interview; otherwise "Your most-used résumé". (No false interview claim on a draft-only résumé.)
  - Notes:
- ⬜ **T-ANL-04** **Usage / cost**: total cost, tokens, calls; breakdown **by day**, **by purpose** (resume_parse, optimize_resume, plan_coverage, cover_letter, job_rerank, interview_answer, generate_profile_intro, copilot…), **by model**, **by provider**. Costs are tiny but non-zero after your activity.
  - Notes:
- ⬜ **T-ANL-05** Recent activity feed is sorted newest-first and bounded.
  - Notes:

---

## 15. Notifications

- ⬜ **T-NOT-01** The **bell** shows an unread **badge** that renders cleanly on the corner (not clipped/oversized).
  - Notes:
- ⬜ **T-NOT-02** Open the panel → items with title/body/time; click one → marks read + navigates if it has a link.
  - Notes:
- ⬜ **T-NOT-03** **Mark all read** clears the badge (no 500).
  - Notes:
- ⬜ **T-NOT-04** (Reminders) A "tailored résumé ready" style notification exists from your earlier runs.
  - Notes:

---

## 16. Settings  (`/settings`)

- ⬜ **T-SET-01** **Profile** tab: **theme** toggle Light/Dark → the whole app re-themes and the choice sticks across reloads/sign-in.
  - Notes:
- ⬜ **T-SET-02** **Security**: change email (with confirmation flow) and change password → both enforce and take effect.
  - Notes:
- ⬜ **T-SET-03** **AI Model**: switch active **provider** (Gemini / Anthropic / OpenAI) and **model**; a provider without a key is clearly gated ("add a key to unlock").
  - Notes:
- ⬜ **T-SET-04 (BYO keys)** Add your own key for a provider → status shows configured (last-4 hint, never full key); saving a **bad key** fails gracefully (and doesn't burn your generate quota). Remove a key.
  - Notes:
- ⬜ **T-SET-05** **Devices**: covered in 1.4.
  - Notes:
- ⬜ **T-SET-06** **Notifications**: toggle product emails / application reminders → persist.
  - Notes:
- ⬜ **T-SET-07** **Data**: **Export** (account.zip / applications.csv) downloads; **Delete account** requires typing `DELETE` and actually wipes (test on a throwaway only!).
  - Notes:

---

## 17. Admin  (`/admin`, superuser only)

> Only visible if your account is a superuser. If the Admin nav item is absent,
> skip this section (or ask me to promote a throwaway for testing).

- ⬜ **T-ADM-01** **Feature flags** list (signups_enabled, job_search_enabled, byo_keys_enabled, copilot_enabled) — toggle one and see the effect (e.g. turn off Job Search → the page reports it's disabled).
  - Notes:
- ⬜ **T-ADM-02** **Users** list with per-user cost; **suspend** / **reactivate** a (throwaway) user works; a suspended user can't act.
  - Notes:
- ⬜ **T-ADM-03** **Stats** render.
  - Notes:

---

## 18. Cross-cutting (spot-check throughout)

### 18.1 Truthfulness (the signature promise) — `P0` if broken
- ⬜ **T-X-01** Across résumé rewrite, tailoring, cover letters, outreach, STAR answers, and Copilot: **no invented numbers, tools, employers, or credentials.** Brag-bank facts are OK (you attested them); anything else is not.
  - Notes:
- ⬜ **T-X-02** Adding a fact to the brag bank *unlocks* the engine to use it (e.g. add a real metric → re-tailor → it can now appear). Removing it re-blocks it.
  - Notes:

### 18.2 Responsive / mobile
- ⬜ **T-X-03** Shrink the window to ~mobile width: nav collapses sensibly; no **horizontal body scroll**; cards/tables scroll within their own container; headers/banners wrap instead of overflowing.
  - Notes:
- ⬜ **T-X-04** Touch-style interactions (brag-bank edit/delete, card buttons) are reachable without hover.
  - Notes:

### 18.3 Accessibility
- ⬜ **T-X-05** Tab through a form — focus is visible; icon-only buttons (New Application, bell, close ×) have labels (screen-reader / inspect `aria-label`).
  - Notes:
- ⬜ **T-X-06** Color isn't the only signal (match verdict, statuses also have text).
  - Notes:

### 18.4 Errors, limits, resilience
- ⬜ **T-X-07** Trigger a generation error path (e.g. remove your API key / hit the generate rate limit ~10/hr) → friendly message, no raw 500.
  - Notes:
- ⬜ **T-X-08** Dropdowns/modals across the app are theme-native (no stock-white OS dropdowns), text not clipped.
  - Notes:
- ⬜ **T-X-09** Cost of a full session stays tiny (cents) — confirm in Analytics after a heavy test run.
  - Notes:

---

## Issue log (roll findings up here as you go)

| ID | Test | Severity | Summary | Status |
|----|------|----------|---------|--------|
| 1 | T-AUTH-03 | P3 | Weak password showed generic "Validation failed." instead of the specific reason. | ✅ **Closed** (fixed + re-tested pass) |

---

## Sign-off

- [ ] Sections 1–9 (core journey) fully passed
- [ ] Sections 10–14 (assist features) passed
- [ ] Section 18 (cross-cutting) spot-checked
- [ ] All `P0`/`P1` issues logged and triaged

_Last updated: 2026-08-05 — Progress: Section 1 auth 01–11 all ✅ (T-AUTH-12/13 Devices next — need the UI). 1 issue found & closed (P3). Section 0 smoke: T-SMOKE-01 ✅._
