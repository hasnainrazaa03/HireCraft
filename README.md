<div align="center">

# 🛠️ HireCraft

### Tailor your resume to any job — without inventing a single thing.

*Paste a job posting. Get back an ATS-ready PDF where every line is still true.*

`FastAPI` · `Celery` · `PostgreSQL` · `Redis` · `Gemini` · `Tectonic` · `React`

</div>

---

## 👋 Start here

You have one real resume. A job wants it phrased *their* way, stuffed with *their*
keywords, reordered to put *their* priorities first. Doing that by hand for every
application is soul-crushing. Handing it to a generic AI is worse — it cheerfully
adds "Kubernetes" to your skills because the posting asked, and now you're
defending a lie in the interview.

**HireCraft draws a hard line the AI cannot cross:** it may rewrite *how* your
experience reads, never *what* it is. If a fact isn't in your master resume, it
does not make it into the PDF. Full stop.

```
   your master résumé  ─┐
                        ├──▶  🤖 rewrite the wording  ──▶  🛡️ prove every claim  ──▶  📄 tailored PDF
   the job posting     ─┘        (Gemini)                    (guardrails)               (LaTeX)
```

---

## ✨ The party trick

Watch what happens when the AI gets greedy. Here's a candidate who has never
touched Kubernetes, applying to a job that demands it:

> **The model writes:** *"Deployed microservices on Kubernetes and AWS Lambda,
> scaling to 5 million requests/second."*
>
> **HireCraft ships:** *(nothing — the whole bullet is deleted)*
>
> **And tells you why:**
> - 🚫 `Kubernetes` — in the posting, nowhere in your résumé. Blocked.
> - 🚫 `5 million` — a number you never wrote. Blocked.
> - ✅ Keyword coverage reported as **the honest 60%**, not the 100% the model claimed.

Four independent checks enforce this, and **none of them trust the model to
behave:**

| # | Guard | What it stops |
|---|-------|---------------|
| 1 | **Structural immunity** | The AI is never even *given* fields for your employer, title, or dates — so it can't change them. |
| 2 | **Numeric provenance** | Every number in a bullet must already exist in your résumé, or the bullet is dropped. |
| 3 | **Keyword-injection blocking** | A skill from the *job* that's absent from *you* gets deleted, not "flagged for review." |
| 4 | **Claim verification** | The keyword-match % is re-measured from your actual PDF, never taken from the model's word. |

Everything the guardrails remove is shown to you, with the reason. You stay in
control; the AI just does the typing.

---

## 🚀 Run it in three commands

You'll need **Docker**, and a **Gemini API key** ([grab one free here](https://aistudio.google.com/apikey)).

```bash
git clone https://github.com/hasnainrazaa03/HireCraft.git && cd HireCraft

cp backend/.env.example .env      # then open .env and fill in two values:
                                  #   SECRET_KEY    → openssl rand -base64 48
                                  #   GEMINI_API_KEY → your key

docker compose up --build         # ☕ first build fetches LaTeX support files
```

Then open:

| 🎯 | Where | What |
|----|-------|------|
| 🖥️ | **http://localhost:5173** | The app — start here |
| 📚 | http://localhost:8000/docs | Interactive API playground |
| ❤️ | http://localhost:8000/ready | "is everything wired up?" |

> 💡 **Ports 5432 or 6379 already taken?** Drop `POSTGRES_PORT=55432` and
> `REDIS_PORT=56379` into your `.env` and they'll move out of the way.

---

## 🎬 Your first tailored resume

1. **Sign up** on the login screen (it's all local — your data never leaves your machine).
2. **Add your master résumé** under *Resumes*. Start from the built-in template, or
   upload JSON. There's a full worked example at
   [`templates/example_master_resume.json`](templates/example_master_resume.json).
   → *Put your real numbers in. HireCraft can spotlight a metric you wrote; it can
   never conjure one you didn't.*
3. **New application** → paste a job URL or the description text → **Tailor my resume**.
4. **Read the diff.** The *Changes* tab shows original vs. tailored side by side.
   The *Guardrails* tab shows what got blocked and why. **Look here before you send.**
5. **Download** the PDF (or the LaTeX source, if you like to hand-tune).
6. **Track it** on the board as you move from Applied → Screening → Offer. 🎉

### ⚡ Just want a PDF, no AI?

Render any master résumé straight to PDF — great for iterating on the template:

```bash
python scripts/render_resume.py templates/example_master_resume.json -o resume.pdf
```

---

## 🧠 How it's put together

```
                    ┌──────────────┐   URL comes from a user → every fetch is
  job URL / text →  │   Scraper    │   SSRF-checked, even across redirects
                    └──────┬───────┘
                           ▼
                    ┌──────────────┐   Gemini reads the posting →
                    │  Extractor   │   structured requirements + ATS keywords
                    └──────┬───────┘
                           ▼
   master résumé  →  ┌──────────────┐   Gemini rewrites *presentation only*.
                     │  Optimizer   │   Facts aren't on the table to change.
                     └──────┬───────┘
                            ▼
                     ┌──────────────┐   ⭐ the heart of the whole thing:
                     │  GUARDRAILS  │   merge onto master, verify every claim
                     └──────┬───────┘
                            ▼
                     ┌──────────────┐   Jinja2 → Tectonic, sandboxed with
                     │ LaTeX → PDF  │   --untrusted. Injection-proof escaping.
                     └──────────────┘
```

A **FastAPI** app takes requests and hands the slow work to a **Celery** worker
over **Redis**, so the UI never blocks while Gemini thinks and LaTeX compiles.
State lives in **PostgreSQL**; the **React + Tailwind** dashboard polls for
progress and renders the diff. Everything runs as containers behind one
`docker compose up`.

### The stack, and why

| Layer | Pick | Because |
|-------|------|---------|
| API | **FastAPI** | async, typed, self-documenting at `/docs` |
| Worker | **Celery + Redis** | tailoring takes ~60s; that belongs off the request path |
| Database | **PostgreSQL + SQLAlchemy 2** | JSONB stores résumés without flattening them |
| AI | **Google Gemini** | strong instruction-following, and cheap — *~$0.001 per application* |
| Typesetting | **Tectonic** | LaTeX-grade output from a single static binary, no 5GB TeX install |
| Frontend | **React + Tailwind + TanStack Query** | polling, caching, and a board view without the ceremony |

---

## 🔒 On security (because your résumé is *your* data)

- **Argon2id** password hashing; JWTs with enforced access/refresh separation.
- **SSRF-proof scraping** — every resolved IP is checked against private and
  cloud-metadata ranges, re-checked on each redirect hop.
- **Injection-proof LaTeX** — a single-pass escaper neutralizes `\input`,
  `\write18`, and friends; Tectonic runs `--untrusted` with shell-escape off.
- **Rate limiting** on everything, with a tighter budget on the endpoints that
  spend real AI credits.
- **Multi-tenant by default** — one user can never see, touch, or even confirm the
  existence of another's data (we return `404`, not `403`).

---

## 🧪 Developing on it

```bash
# just the infrastructure
docker compose up -d postgres redis

# backend  (needs `brew install tectonic` for PDFs)
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload

# worker, in another shell
celery -A app.workers.celery_app.celery_app worker --loglevel=info

# frontend, in another shell
cd frontend && npm install && npm run dev
```

```bash
cd backend
pytest                 # everything, including a real LaTeX compile
pytest -m "not slow"   # skip the PDF engine when you're in a hurry
```

The test suite worth reading is the guardrail one — it encodes *every way the
truthfulness promise could break* as an explicit, named test. That's the spec.

---

## 💸 A word on cost & quotas

Each tailoring run makes 2–3 Gemini calls, landing around **$0.001 per
application** on Flash-class models. The dashboard tracks every token and dollar,
broken down by pipeline stage, under *Usage*.

> ⚠️ **Free-tier keys are capped at ~20 requests/day** — enough to kick the tires
> (~6–10 applications), not enough to run a job hunt on. Enable billing on your key
> when you're ready to go for real. Swapping the model is a one-line `.env` change.

---

## 🗺️ Where it's headed

The core loop — scrape, tailor, guard, typeset, track — is **built and working
end to end**. On deck: cloud file storage, résumé version history, and batch
applications. Ideas and PRs welcome.

---

<div align="center">

**Built for anyone who's ever rewritten the same résumé for the hundredth time.**

*Go get the job. 🎯*

</div>
