"""Prompt construction for the two LLM stages.

The optimizer prompt is written on the assumption that the guardrail layer will
mechanically reject fabrication. Stating that plainly to the model measurably
improves compliance, but the enforcement is never left to the prompt alone -
``guardrails.py`` re-derives every claim from the master resume regardless of
what the model was told.
"""

from __future__ import annotations

import json

from app.schemas.job import JobRequirements
from app.schemas.resume import MasterResume

EXTRACTOR_SYSTEM = """\
You are an expert technical recruiter who reads job postings and extracts their \
requirements into structured data.

Rules:
- Extract only what the posting actually states. Never infer unstated requirements.
- `ats_keywords` must be terms copied VERBATIM from the posting - exact casing and \
spelling, because applicant tracking systems match literally. Order them most to \
least important. Prefer concrete nouns (languages, frameworks, tools, methodologies) \
over generic soft skills.
- `required_skills` are things the posting frames as mandatory ("must have", \
"required", "you have"). `preferred_skills` are framed as optional ("nice to have", \
"bonus", "preferred").
- Set `importance` to 5 only for skills stated as hard requirements, 1 for passing \
mentions.
- If a field is not stated in the posting, leave it null or empty. Do not guess.
"""


def build_extractor_prompt(job_text: str, url: str | None = None) -> str:
    source = f"\nSource URL: {url}\n" if url else ""
    return f"""\
Extract the structured requirements from this job posting.
{source}
--- JOB POSTING START ---
{job_text}
--- JOB POSTING END ---

Return the structured requirements as JSON matching the provided schema."""


OPTIMIZER_SYSTEM = """\
You are an expert resume writer optimizing a candidate's existing resume for one \
specific job. You rewrite how their real experience is PRESENTED. You never change \
what that experience IS.

ABSOLUTE CONSTRAINTS - an automated verifier checks every one of these after you \
respond, and silently deletes any bullet that violates them:

1. NEVER introduce a number, percentage, quantity, duration, or metric that does not \
   already appear in the candidate's master resume. If a bullet has no metric, do not \
   invent one. "Improved performance" must not become "improved performance by 40%".
2. NEVER claim a technology, tool, framework, company, product, or certification the \
   candidate has not listed. If the job wants Kubernetes and the candidate has never \
   mentioned it, DO NOT write Kubernetes anywhere. Adding it is the single worst thing \
   you can do - it will be deleted and the candidate could be caught lying in an interview.
3. NEVER alter employers, job titles, institutions, degrees, or dates. You are not \
   given those fields to edit; identify entries only by their `id`.
4. NEVER write more bullets for an entry than it already has. You are rewording a \
   fixed set of facts, not adding accomplishments.

WHAT YOU MUST RETURN:
- For EVERY experience, project, and education entry you keep (`include: true`), you \
  MUST return its `highlights` array populated with rewritten bullets - one per bullet \
  the entry already has. Returning an empty highlights array, or omitting it, leaves \
  the candidate's original wording untouched and wastes the tailoring. Rewrite every \
  bullet even if the change is small; do not echo the original text verbatim.
- Return the same number of bullets the entry started with - no more, no fewer.

HOW TO REWRITE EACH BULLET:
- Lead with a strong, specific action verb. Vary them across bullets.
- Surface the candidate's genuinely relevant experience using the job's own vocabulary. \
  If the candidate wrote "made web pages faster" and the job says "performance \
  optimization", reframing it as "optimized front-end performance" is correct and \
  encouraged - the underlying fact is unchanged.
- Move the most job-relevant detail to the front of the bullet.
- Preserve every real metric that already exists; those are the strongest content you have.
- Set `relevance_rank` (0 = most relevant) so the entries that best match this job \
  appear first.
- Set `include: false` only for entries genuinely irrelevant to this role, and only \
  when the candidate has enough other material.
- Reorder and re-group `skills` to foreground what the job asks for - but every skill \
  you list must already exist in the candidate's skill list.
- Write a 2-3 sentence `summary` positioning the candidate for THIS role, and a short \
  `headline`. Both are subject to the same constraints.
- In `keywords_used`, list only job keywords you actually surfaced using genuine \
  candidate experience.

Honest, precise, specific writing beats keyword stuffing. A resume that survives \
verification is worth more than one that does not.
"""


def _entry_payload(resume: MasterResume) -> dict:
    """The editable view of the resume handed to the optimizer.

    Factual fields are included as read-only context so the model understands what
    each entry is, but the response schema gives it no way to write them back.
    """
    return {
        "current_headline": resume.basics.headline,
        "current_summary": resume.basics.summary,
        "experience": [
            {
                "id": e.id,
                "context_company": e.company,
                "context_title": e.title,
                "context_dates": f"{e.start_date or '?'} to {e.end_date or '?'}",
                "editable_highlights": e.highlights,
                "technologies_available": e.technologies,
            }
            for e in resume.experience
        ],
        "projects": [
            {
                "id": p.id,
                "context_name": p.name,
                "context_description": p.description,
                "editable_highlights": p.highlights,
                "technologies_available": p.technologies,
            }
            for p in resume.projects
        ],
        "education": [
            {
                "id": ed.id,
                "context_institution": ed.institution,
                "context_degree": f"{ed.degree} {ed.field_of_study or ''}".strip(),
                "editable_highlights": ed.highlights,
                "coursework_available": ed.coursework,
            }
            for ed in resume.education
        ],
        "skills": [{"category": g.category, "items": g.items} for g in resume.skills],
    }


def build_optimizer_prompt(
    resume: MasterResume,
    requirements: JobRequirements,
    job_text: str,
    *,
    max_job_chars: int = 6000,
) -> str:
    resume_json = json.dumps(_entry_payload(resume), indent=2, ensure_ascii=False)
    requirements_json = json.dumps(
        requirements.model_dump(exclude_none=True), indent=2, ensure_ascii=False
    )
    keywords = requirements.all_keywords()[:30]

    # The candidate's own vocabulary, so the model can see at a glance what it is
    # allowed to say. This measurably reduces keyword-injection attempts.
    allowed_tech = sorted(
        {
            item
            for group in resume.skills
            for item in group.items
        }
        | {t for e in resume.experience for t in e.technologies}
        | {t for p in resume.projects for t in p.technologies}
    )

    return f"""\
Tailor this candidate's resume for the target job below.

=== TARGET JOB REQUIREMENTS (extracted) ===
{requirements_json}

=== PRIORITY ATS KEYWORDS ===
{", ".join(keywords) if keywords else "(none extracted)"}

=== TECHNOLOGIES THE CANDIDATE MAY BE DESCRIBED AS KNOWING ===
This is the complete allowed list. Any technology outside it will be deleted by the \
verifier:
{", ".join(allowed_tech) if allowed_tech else "(none listed)"}

=== CANDIDATE MASTER RESUME (edit only the `editable_*` fields) ===
{resume_json}

=== ORIGINAL JOB POSTING (excerpt) ===
{job_text[:max_job_chars]}

Return JSON matching the schema. Reference every entry by its exact `id`. Rewrite \
only wording, ordering, and emphasis."""


COVER_LETTER_SYSTEM = """\
You are writing a concise, specific cover letter for a candidate.

Constraints, all mechanically verified afterwards:
- Use ONLY facts present in the candidate's resume. No invented metrics, employers, \
technologies, or motivations.
- Never claim a skill the candidate has not listed.
- 3 to 4 paragraphs, under 320 words total. No filler, no "I am writing to express my \
interest in".
- Open with something concrete about the candidate's most relevant real experience.
- Reference the specific company and role.
- Close briefly and professionally. Do not include a salutation or sign-off - those are \
added by the template.

Return a JSON object with a `paragraphs` array of strings.
"""


def build_cover_letter_prompt(
    resume: MasterResume,
    requirements: JobRequirements,
    job_text: str,
    *,
    max_job_chars: int = 3500,
) -> str:
    highlights = [
        f"- {e.company} ({e.title}): " + "; ".join(e.highlights[:3])
        for e in resume.experience[:4]
    ]
    projects = [
        f"- {p.name}: " + "; ".join(p.highlights[:2]) for p in resume.projects[:3]
    ]
    skills = ", ".join(item for g in resume.skills for item in g.items)

    return f"""\
Write a cover letter for this candidate.

Candidate: {resume.basics.name}
Target role: {requirements.title or "the advertised role"}
Company: {requirements.company or "the company"}

Candidate experience:
{chr(10).join(highlights) or "(none)"}

Candidate projects:
{chr(10).join(projects) or "(none)"}

Candidate skills: {skills or "(none listed)"}

Job posting excerpt:
{job_text[:max_job_chars]}

Return JSON with a `paragraphs` array."""
