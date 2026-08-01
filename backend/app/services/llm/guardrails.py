"""Hallucination guardrails.

The optimizer is allowed to *rephrase* the candidate's experience. It is never
allowed to invent it. This module is the enforcement layer, and it is designed so
the dangerous failure modes are impossible or caught rather than merely discouraged
by prompt wording:

1. **Structural immunity.** ``TailoredEntry`` carries no factual fields at all, so
   employer names, titles, and dates are copied from the master resume during the
   merge. A model cannot change a fact it is never asked to emit.
2. **Numeric provenance.** Every number in a rewritten bullet must trace back to
   the master resume. A metric that appears nowhere in the source is dropped.
3. **Vocabulary provenance.** Proper nouns and technologies not present in the
   master resume are flagged - this is what stops ATS keyword stuffing from
   silently turning into a fabricated skill claim.
4. **Claim verification.** The model's own report of which keywords it used is
   checked against the rendered text rather than trusted.
"""

from __future__ import annotations

import re
from typing import Any

from app.schemas.job import JobRequirements
from app.schemas.resume import (
    BASICS_IMMUTABLE_FIELDS,
    Education,
    Experience,
    MasterResume,
    Project,
)
from app.schemas.tailoring import (
    BulletConfidence,
    DiffEntry,
    GuardrailReport,
    GuardrailViolation,
    TailoredEntry,
    TailoringResult,
)

# Matches 40, 40%, 1,000, 3.5, 10x, $2M, 2.5k
NUMBER_RE = re.compile(r"\d[\d,]*\.?\d*")
TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9+#./_-]*")

# Capitalized words that are ordinary English rather than proper nouns. Keeps the
# proper-noun check from firing on every sentence-initial word.
COMMON_CAPITALIZED = frozenset(
    ["a", "an", "the", "and", "or", "but", "for", "nor", "so", "yet", "at", "by", "in", "on", "to", "of", "with", "from", "into", "over", "under", "i", "we", "my", "our", "it", "its", "this", "that", "these", "those", "as", "is", "are", "was", "were", "be", "been", "being", "led", "build", "built", "design", "designed", "develop", "developed", "create", "created", "implement", "implemented", "improve", "improved", "reduce", "reduced", "increase", "increased", "manage", "managed", "own", "owned", "drive", "drove", "ship", "shipped", "launch", "launched", "deliver", "delivered", "architect", "architected", "optimize", "optimized", "automate", "automated", "scale", "scaled", "migrate", "migrated", "collaborate", "collaborated", "partner", "partnered", "mentor", "mentored", "present", "presented", "analyze", "analyzed", "research", "researched", "write", "wrote", "test", "tested", "deploy", "deployed", "maintain", "maintained", "support", "supported", "coordinate", "coordinated", "engineer", "engineering", "software", "developer", "team", "teams", "project", "projects", "product", "system", "systems", "service", "services", "data", "api", "apis", "application", "applications", "performance", "latency", "throughput", "reliability", "availability", "accuracy", "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
)


def _normalize_number(raw: str) -> str:
    """Normalize a numeric token so 1,000 and 1000 compare equal."""
    cleaned = raw.replace(",", "").rstrip(".")
    if cleaned.endswith(".0"):
        cleaned = cleaned[:-2]
    try:
        value = float(cleaned)
    except ValueError:
        return cleaned
    return str(int(value)) if value.is_integer() else str(value)


def _numbers_in(text: str) -> set[str]:
    return {_normalize_number(m.group()) for m in NUMBER_RE.finditer(text or "")}


_TEXT_FIELDS = (
    "company",
    "title",
    "institution",
    "degree",
    "field_of_study",
    "name",
    "description",
    "location",
    "gpa",
)
_LIST_FIELDS = ("highlights", "technologies", "coursework", "honors")


def _entry_source_text(entry: Experience | Education | Project) -> str:
    """All text a rewritten bullet for this entry is permitted to draw from."""
    parts: list[str] = []
    for field in (*_TEXT_FIELDS, "start_date", "end_date"):
        value = getattr(entry, field, None)
        if isinstance(value, str):
            parts.append(value)
    for field in _LIST_FIELDS:
        values = getattr(entry, field, None) or []
        parts.extend(str(v) for v in values)
    return " ".join(parts)


def _entry_metric_numbers(entry: Experience | Education | Project) -> set[str]:
    """Numbers this entry legitimately establishes.

    Deliberately excludes month components of dates. ``2024-05`` would otherwise
    contribute a bare ``5`` to the allowed pool, which is enough to launder a
    fabricated claim like "scaled to 5 million requests" past the provenance
    check. Four-digit years are kept, since a bullet may reference its own year.
    """
    parts: list[str] = []
    for field in _TEXT_FIELDS:
        value = getattr(entry, field, None)
        if isinstance(value, str):
            parts.append(value)
    for field in _LIST_FIELDS:
        values = getattr(entry, field, None) or []
        parts.extend(str(v) for v in values)

    numbers = _numbers_in(" ".join(parts))
    for field in ("start_date", "end_date"):
        value = getattr(entry, field, None)
        if isinstance(value, str) and (year := value.split("-")[0]).isdigit():
            numbers.add(_normalize_number(year))
    return numbers


def _master_corpus(master: MasterResume) -> str:
    """Everything the candidate has actually written about themselves."""
    chunks: list[str] = [
        master.basics.headline or "",
        master.basics.summary or "",
    ]
    for section in (master.experience, master.education, master.projects):
        for entry in section:
            chunks.append(_entry_source_text(entry))
    for group in master.skills:
        chunks.append(group.category)
        chunks.extend(group.items)
    for cert in master.certifications:
        chunks.extend(filter(None, [cert.name, cert.issuer]))
    for award in master.awards:
        chunks.extend(filter(None, [award.title, award.issuer, award.description]))
    for pub in master.publications:
        chunks.extend(filter(None, [pub.title, pub.venue, *pub.authors]))

    return " ".join(chunk for chunk in chunks if chunk)


def _tokens(text: str) -> set[str]:
    return {m.group().lower() for m in TOKEN_RE.finditer(text)}


# Productive suffixes stripped to compare word forms, longest first. Deliberately
# conservative: agent-noun "-er"/"-or" is excluded (it would fold "engineer" into
# "engine"), and a stem must keep >=3 chars — so this only ever adds matches
# between genuine inflections ("imaging"/"image", "optimization"/"optimize",
# "engineered"/"engineer", "pipelines"/"pipeline"), never launders a real claim.
_STEM_SUFFIXES = (
    "ization", "isation", "ational", "ations", "izing", "ising", "ation",
    "ition", "ment", "ness", "ized", "ised", "izes", "ises", "ings", "ies",
    "ize", "ise", "ing", "ied", "es", "ed", "s", "e",
)


def _stem(word: str) -> str:
    """A light, conservative stem so different forms of a word compare equal."""
    w = word.lower().strip("._-")
    if len(w) <= 3:
        return w
    for suf in _STEM_SUFFIXES:
        if w.endswith(suf) and len(w) - len(suf) >= 3:
            return w[: -len(suf)]
    return w


def _stems(tokens: set[str]) -> set[str]:
    return {_stem(t) for t in tokens}


def _mentions(haystack_lower: str, term_lower: str) -> bool:
    """Does ``haystack_lower`` contain ``term_lower`` as a whole term?

    Plain substring containment is wrong here and dangerously so: a job keyword
    like "R", "Go", or "REST" is a substring of ordinary English ("Resolved",
    "going", "interest"), so every résumé would appear to "claim" it. That turns
    the keyword-injection check into a no-op for exactly the short, ambiguous
    technology names it most needs to catch. Anchoring on alphanumeric
    boundaries keeps "C++" and "Node.js" matching while "R" only matches a
    standalone R.
    """
    pattern = rf"(?<![A-Za-z0-9]){re.escape(term_lower)}(?![A-Za-z0-9])"
    return re.search(pattern, haystack_lower) is not None


def _master_numbers(master: MasterResume) -> set[str]:
    """Every number the candidate has actually claimed, anywhere in the master."""
    numbers: set[str] = set()
    for section in (master.experience, master.education, master.projects):
        for entry in section:
            numbers |= _entry_metric_numbers(entry)
    numbers |= _numbers_in(master.basics.summary or "")
    numbers |= _numbers_in(master.basics.headline or "")
    for cert in master.certifications:
        numbers |= _numbers_in(cert.name)
    for award in master.awards:
        numbers |= _numbers_in(f"{award.title} {award.description or ''}")
    for group in master.skills:
        numbers |= _numbers_in(" ".join(group.items))
    return numbers


def _suspicious_tokens(
    bullet: str, vocab: set[str], stem_vocab: set[str] | None = None
) -> list[str]:
    """Proper-noun-ish tokens in ``bullet`` with no basis in the master resume."""
    flagged: list[str] = []
    matches = list(TOKEN_RE.finditer(bullet))
    for position, match in enumerate(matches):
        token = match.group()
        lower = token.lower()
        if lower in vocab or lower in COMMON_CAPITALIZED:
            continue
        # A word-form of something in the résumé isn't a fabrication.
        if stem_vocab is not None and _stem(lower) in stem_vocab:
            continue
        # Sentence-initial capitalization carries no proper-noun signal.
        if position == 0 and token[0].isupper() and token[1:].islower():
            continue
        is_proper = token[0].isupper()
        # Mixed alphanumerics catch technology names like K8s, S3, GPT-4, Vue3.
        is_techy = any(c.isdigit() for c in token) and any(c.isalpha() for c in token)
        if is_proper or is_techy:
            flagged.append(token)
    return flagged


class GuardrailEngine:
    """Merges a tailoring result onto a master resume, enforcing truthfulness."""

    def __init__(
        self,
        master: MasterResume,
        requirements: JobRequirements | None = None,
        *,
        evidence: list[str] | None = None,
    ):
        self.master = master
        self.requirements = requirements
        # The brag bank is attested provenance: a number or proper noun the
        # candidate vouched for there is as real as one on the résumé, so it is
        # folded into the corpus and number set the checks validate against. This
        # is the mechanism behind "grounded leeway" — the pool of allowable facts
        # widens to exactly what the candidate has attested to, and no further.
        evidence_text = " ".join(evidence or [])
        self.master_text = f"{_master_corpus(master)} {evidence_text}".lower()
        self.vocab = _tokens(self.master_text)
        # Stemmed vocabulary, so "medical imaging" is recognised as claimed when
        # the résumé says "medical image segmentation" — a word-form difference,
        # not a fabrication.
        self.stem_vocab = _stems(self.vocab)
        self.evidence_numbers = _numbers_in(evidence_text)
        self.master_numbers = _master_numbers(master) | self.evidence_numbers
        # Terms the job asks for that the candidate has never claimed. Any of these
        # appearing in generated text is keyword injection, not rephrasing.
        self.unearned_job_terms: list[str] = []
        if requirements:
            self.unearned_job_terms = [
                kw
                for kw in requirements.all_keywords()
                if not self._claimed_in_master(kw)
            ]
        self.violations: list[GuardrailViolation] = []
        # Per-bullet truthfulness verdicts for the final résumé (Guardrails v2).
        self.confidence: list[BulletConfidence] = []

    def _confidence(
        self, entry_id: str, label: str, text: str, level: str, reason: str
    ) -> None:
        self.confidence.append(
            BulletConfidence(
                entry_id=entry_id,
                label=label,
                text=text,
                confidence=level,  # type: ignore[arg-type]
                reason=reason,
            )
        )

    def _claimed_in_master(self, term: str) -> bool:
        """Does the candidate's own resume support this term?"""
        needle = term.strip().lower()
        if not needle:
            return True
        if _mentions(self.master_text, needle):
            return True
        # Multi-word keyword counts as claimed only if every component is.
        parts = _tokens(needle)
        if bool(parts) and parts.issubset(self.vocab):
            return True
        # Word-form fallback: every component matches some form in the résumé
        # (imaging↔image). Conservative stemming, so this only bridges genuine
        # inflections, never a truly absent skill.
        stems = _stems(parts)
        return bool(stems) and stems.issubset(self.stem_vocab)

    def _injected_job_terms(self, text: str) -> list[str]:
        """Job keywords present in ``text`` that the master resume never supports."""
        haystack = text.lower()
        return [term for term in self.unearned_job_terms if _mentions(haystack, term.lower())]

    # -- internal helpers -------------------------------------------------

    def _flag(
        self,
        kind: str,
        severity: str,
        detail: str,
        *,
        entry_id: str | None = None,
        field: str | None = None,
        action: str = "flagged",
    ) -> None:
        self.violations.append(
            GuardrailViolation(
                kind=kind,  # type: ignore[arg-type]
                severity=severity,  # type: ignore[arg-type]
                entry_id=entry_id,
                field=field,
                detail=detail,
                action=action,  # type: ignore[arg-type]
            )
        )

    def _vet_bullets(
        self,
        entry_id: str,
        label: str,
        candidate_bullets: list[str],
        source_entry: Experience | Education | Project,
    ) -> list[str]:
        """Return only the bullets that survive numeric and vocabulary checks.

        Alongside filtering, records a per-bullet confidence verdict: dropped
        bullets are Blocked, a kept bullet with a caution is Needs-Review, one
        identical to the master is Verified, and a clean rewrite is Likely.
        """
        entry_numbers = _entry_metric_numbers(source_entry)
        original = set(source_entry.highlights)
        kept: list[str] = []

        for bullet in candidate_bullets:
            bullet_numbers = _numbers_in(bullet)

            invented = bullet_numbers - self.master_numbers
            if invented:
                self._flag(
                    "fabricated_number",
                    "error",
                    f"{label}: bullet dropped - the value(s) "
                    f"{', '.join(sorted(invented))} appear nowhere in the master resume. "
                    f"Bullet: {bullet!r}",
                    entry_id=entry_id,
                    field="highlights",
                    action="dropped",
                )
                self._confidence(
                    entry_id, label, bullet, "blocked",
                    f"Invented the number(s) {', '.join(sorted(invented))}.",
                )
                continue

            caution: str | None = None

            # Present in the resume, but borrowed from a different entry. A number
            # the candidate attested in the brag bank isn't "displaced" — they
            # vouched for it — so it doesn't earn the verify-before-sending warning.
            displaced = bullet_numbers - entry_numbers - self.evidence_numbers
            if displaced:
                self._flag(
                    "fabricated_number",
                    "warning",
                    f"{label}: the value(s) {', '.join(sorted(displaced))} come from a "
                    f"different entry in your resume. Verify before sending. "
                    f"Bullet: {bullet!r}",
                    entry_id=entry_id,
                    field="highlights",
                    action="flagged",
                )
                caution = f"Uses {', '.join(sorted(displaced))} from a different entry — verify it fits here."

            # The highest-risk failure: the model borrowed a technology straight
            # from the job description that the candidate has never claimed. This
            # is ATS keyword stuffing turning into a lie, so it is a hard drop.
            injected = self._injected_job_terms(bullet)
            if injected:
                self._flag(
                    "unverified_keyword_claim",
                    "error",
                    f"{label}: bullet dropped - it claims "
                    f"{', '.join(sorted(injected))}, which appears in the job posting "
                    f"but nowhere in your master resume. HireCraft will not claim "
                    f"experience you have not documented. Bullet: {bullet!r}",
                    entry_id=entry_id,
                    field="highlights",
                    action="dropped",
                )
                self._confidence(
                    entry_id, label, bullet, "blocked",
                    f"Claimed {', '.join(sorted(injected))} from the job posting, not your résumé.",
                )
                continue

            unknown_terms = _suspicious_tokens(bullet, self.vocab, self.stem_vocab)
            if unknown_terms:
                self._flag(
                    "fabricated_proper_noun",
                    "warning",
                    f"{label}: mentions {', '.join(sorted(set(unknown_terms)))}, which "
                    f"you never mention in your master resume. Confirm this is true "
                    f"before applying.",
                    entry_id=entry_id,
                    field="highlights",
                    action="flagged",
                )
                term_note = f"Mentions {', '.join(sorted(set(unknown_terms)))}, not found in your résumé."
                caution = f"{caution} {term_note}".strip() if caution else term_note

            # Classify the surviving bullet.
            if caution:
                self._confidence(entry_id, label, bullet, "needs_review", caution)
            elif bullet in original:
                self._confidence(
                    entry_id, label, bullet, "verified", "Unchanged from your résumé.",
                )
            else:
                self._confidence(
                    entry_id, label, bullet, "likely",
                    "Reworded; every number and named thing traces to your résumé.",
                )

            kept.append(bullet)

        return kept

    def _merge_section(
        self,
        section_name: str,
        master_entries: list[Any],
        tailored: list[TailoredEntry],
    ) -> list[Any]:
        """Apply tailored presentation onto master entries of one section."""
        by_id = {entry.id: entry for entry in master_entries}
        tailored_by_id: dict[str, TailoredEntry] = {}

        for item in tailored:
            if item.id not in by_id:
                self._flag(
                    "unknown_entry_id",
                    "error",
                    f"Model returned {section_name} entry id {item.id!r}, which does "
                    f"not exist in the master resume. Discarded.",
                    entry_id=item.id,
                    action="rejected",
                )
                continue
            tailored_by_id[item.id] = item

        merged: list[Any] = []
        for master_entry in master_entries:
            item = tailored_by_id.get(master_entry.id)

            # Untouched by the model: keep the master as-is.
            if item is None:
                merged.append(master_entry.model_copy(deep=True))
                continue

            # include=False hides this entry from the tailored version; the
            # master record is untouched. Skip it before vetting, not after:
            # verifying bullets that will never be rendered filed violations and
            # per-bullet verdicts against a role the résumé doesn't contain, so
            # the user was told a claim had been blocked on an entry they were
            # never going to send, and the "claims blocked" count was inflated
            # by it.
            if not item.include:
                continue

            label = (
                getattr(master_entry, "company", None)
                or getattr(master_entry, "institution", None)
                or getattr(master_entry, "name", None)
                or master_entry.id
            )

            new_entry = master_entry.model_copy(deep=True)

            # The model kept this entry but returned no rewritten bullets, so the
            # master wording stands. That is safe, but it means the entry was not
            # actually tailored - surface it rather than leaving a silent no-op.
            if not item.highlights and master_entry.highlights:
                self._flag(
                    "empty_entry",
                    "warning",
                    f"{label}: the optimizer returned no rewritten bullets, so your "
                    f"original wording was kept for this entry.",
                    entry_id=master_entry.id,
                    field="highlights",
                    action="reverted_to_master",
                )

            if item.highlights:
                original_count = len(master_entry.highlights)

                # Verify first, then truncate. Doing it the other way round lets a
                # fabricated bullet occupy a slot and evict a legitimate one.
                vetted = self._vet_bullets(
                    master_entry.id, str(label), item.highlights, master_entry
                )

                # Rewriting must not manufacture additional claims.
                allowance = max(original_count, 1)
                if len(vetted) > allowance:
                    self._flag(
                        "bullet_count_inflated",
                        "warning",
                        f"{label}: model returned {len(vetted)} verified bullets for an "
                        f"entry with {original_count} in the master. Extra bullets dropped.",
                        entry_id=master_entry.id,
                        field="highlights",
                        action="dropped",
                    )
                    vetted = vetted[:allowance]

                if vetted:
                    new_entry.highlights = vetted
                elif master_entry.highlights:
                    self._flag(
                        "empty_entry",
                        "warning",
                        f"{label}: every rewritten bullet failed verification. "
                        f"Reverted to your original wording.",
                        entry_id=master_entry.id,
                        field="highlights",
                        action="reverted_to_master",
                    )

            new_entry.__dict__["_rank"] = (
                item.relevance_rank if item.relevance_rank is not None else 50
            )
            merged.append(new_entry)

        # Stable sort by the model's relevance hint, preserving master order on ties.
        merged.sort(key=lambda e: e.__dict__.get("_rank", 50))
        for entry in merged:
            entry.__dict__.pop("_rank", None)
        return merged

    def _merge_skills(self, tailored: TailoringResult) -> list[Any]:
        """Reorder and filter skills; never introduce a skill not already claimed."""
        if not tailored.skills:
            return [group.model_copy(deep=True) for group in self.master.skills]

        known_items = {
            item.lower(): item for group in self.master.skills for item in group.items
        }
        known_categories = {group.category.lower() for group in self.master.skills}
        merged: list[Any] = []
        SkillGroup = type(self.master.skills[0]) if self.master.skills else None
        if SkillGroup is None:
            return []

        for group in tailored.skills:
            kept_items: list[str] = []
            for item in group.items:
                canonical = known_items.get(item.strip().lower())
                if canonical is None:
                    # Not in the explicit skills list — but a skill the candidate
                    # demonstrably used (in an experience bullet, a project, or the
                    # attested brag bank) is a real skill they may list. Only a
                    # skill supported nowhere is dropped. This stops the résumé
                    # burying genuine strengths just because they weren't also
                    # duplicated into the Skills section.
                    if self._claimed_in_master(item):
                        canonical = item.strip()
                    else:
                        self._flag(
                            "fabricated_proper_noun",
                            "error",
                            f"Skill {item!r} is supported nowhere in your résumé or "
                            f"evidence. Dropped - HireCraft will not claim a skill you "
                            f"have not shown.",
                            field="skills",
                            action="dropped",
                        )
                        continue
                if canonical not in kept_items:
                    kept_items.append(canonical)

            if not kept_items:
                continue
            if group.category.lower() not in known_categories:
                self._flag(
                    "fabricated_proper_noun",
                    "warning",
                    f"Skill category {group.category!r} was renamed by the model.",
                    field="skills",
                    action="flagged",
                )
            merged.append(SkillGroup(category=group.category, items=kept_items))

        # Any master skill group the model dropped entirely is preserved only if
        # nothing survived, so the resume never ends up with an empty skills block.
        return merged or [group.model_copy(deep=True) for group in self.master.skills]

    def _vet_free_text(self, field: str, text: str | None) -> str | None:
        """Numeric + vocabulary check for headline/summary."""
        if not text:
            return None
        invented = _numbers_in(text) - self.master_numbers
        if invented:
            self._flag(
                "fabricated_number",
                "error",
                f"{field}: contains value(s) {', '.join(sorted(invented))} with no basis "
                f"in the master resume. Reverted.",
                field=field,
                action="reverted_to_master",
            )
            return None
        injected = self._injected_job_terms(text)
        if injected:
            self._flag(
                "unverified_keyword_claim",
                "error",
                f"{field}: claims {', '.join(sorted(injected))}, which appears in the "
                f"job posting but not in your master resume. Reverted.",
                field=field,
                action="reverted_to_master",
            )
            return None
        unknown = _suspicious_tokens(text, self.vocab, self.stem_vocab)
        if unknown:
            self._flag(
                "fabricated_proper_noun",
                "warning",
                f"{field}: mentions {', '.join(sorted(set(unknown)))}, absent from your "
                f"master resume.",
                field=field,
                action="flagged",
            )
        return text

    # -- public API -------------------------------------------------------

    def vet_paragraph(self, text: str, *, field: str = "cover_letter") -> str | None:
        """Verify a free-text paragraph (e.g. a cover letter body paragraph).

        Returns the text if it survives the numeric and keyword-injection checks,
        or ``None`` if it makes a claim the master resume does not support.
        """
        return self._vet_free_text(field, text)

    def apply(self, tailored: TailoringResult) -> tuple[MasterResume, GuardrailReport]:
        """Merge ``tailored`` onto the master resume and return the vetted result."""
        result = self.master.model_copy(deep=True)

        # Contact details are copied wholesale - the model never supplies them.
        for field in BASICS_IMMUTABLE_FIELDS:
            setattr(result.basics, field, getattr(self.master.basics, field))

        headline = self._vet_free_text("headline", tailored.headline)
        result.basics.headline = headline or self.master.basics.headline

        summary = self._vet_free_text("summary", tailored.summary)
        result.basics.summary = summary or self.master.basics.summary

        result.experience = self._merge_section(
            "experience", self.master.experience, tailored.experience
        )
        result.projects = self._merge_section(
            "projects", self.master.projects, tailored.projects
        )
        result.education = self._merge_section(
            "education", self.master.education, tailored.education
        )
        result.skills = self._merge_skills(tailored)

        # Any final bullet not already judged reached the résumé unchanged from
        # the master (the model didn't rewrite it, or the entry was untouched).
        # Those are trivially verified — record them so the confidence report
        # covers every line the user will actually send, not just rewrites.
        self._backfill_verified(result)

        report = GuardrailReport(
            violations=self.violations,
            keywords_requested=(
                self.requirements.all_keywords() if self.requirements else []
            ),
            keywords_verified=self._verify_keywords(result),
            bullet_confidence=self.confidence,
        )
        return result, report

    def _backfill_verified(self, result: MasterResume) -> None:
        """Add a Verified verdict for every final bullet not already judged."""
        judged = {(c.entry_id, c.text) for c in self.confidence}
        for section in (result.experience, result.projects, result.education):
            for entry in section:
                label = (
                    getattr(entry, "company", None)
                    or getattr(entry, "institution", None)
                    or getattr(entry, "name", None)
                    or entry.id
                )
                for bullet in entry.highlights:
                    if (entry.id, bullet) not in judged:
                        self._confidence(
                            entry.id, str(label), bullet, "verified",
                            "Unchanged from your résumé.",
                        )
                        judged.add((entry.id, bullet))

    def _verify_keywords(self, resume: MasterResume) -> list[str]:
        """Which requested keywords genuinely appear in the final resume text."""
        if not self.requirements:
            return []
        haystack = _resume_text(resume).lower()
        # Whole-term matching, same rule as the provenance check: counting a
        # substring hit would report "R" as covered because the résumé says
        # "Resolved", and the coverage figure is supposed to be the honest one.
        return [
            keyword
            for keyword in self.requirements.all_keywords()
            if _mentions(haystack, keyword.lower())
        ]


def _resume_text(resume: MasterResume) -> str:
    parts: list[str] = [resume.basics.headline or "", resume.basics.summary or ""]
    for entry in resume.experience:
        parts.extend([entry.company, entry.title, *entry.highlights, *entry.technologies])
    for project in resume.projects:
        parts.extend(
            [project.name, project.description or "", *project.highlights, *project.technologies]
        )
    for edu in resume.education:
        parts.extend(
            [edu.institution, edu.degree, edu.field_of_study or "", *edu.coursework, *edu.highlights]
        )
    for group in resume.skills:
        parts.append(group.category)
        parts.extend(group.items)
    return " ".join(parts)


def build_diff(before: MasterResume, after: MasterResume) -> list[DiffEntry]:
    """Field-level diff powering the frontend's original-vs-optimized view."""
    diff: list[DiffEntry] = []

    for field in ("headline", "summary"):
        old = getattr(before.basics, field)
        new = getattr(after.basics, field)
        if old != new:
            diff.append(
                DiffEntry(
                    section="basics",
                    label=field.title(),
                    field=field,
                    before=old,
                    after=new,
                    change="modified" if old and new else ("added" if new else "removed"),
                )
            )

    for section in ("experience", "projects", "education"):
        old_entries = {e.id: e for e in getattr(before, section)}
        new_entries = {e.id: e for e in getattr(after, section)}

        for entry_id, old_entry in old_entries.items():
            label = (
                getattr(old_entry, "company", None)
                or getattr(old_entry, "institution", None)
                or getattr(old_entry, "name", None)
                or entry_id
            )
            new_entry = new_entries.get(entry_id)
            if new_entry is None:
                diff.append(
                    DiffEntry(
                        section=section,
                        entry_id=entry_id,
                        label=str(label),
                        field="entry",
                        before=list(old_entry.highlights),
                        after=None,
                        change="removed",
                    )
                )
                continue
            if list(old_entry.highlights) != list(new_entry.highlights):
                diff.append(
                    DiffEntry(
                        section=section,
                        entry_id=entry_id,
                        label=str(label),
                        field="highlights",
                        before=list(old_entry.highlights),
                        after=list(new_entry.highlights),
                        change="modified",
                    )
                )

        old_order = [e.id for e in getattr(before, section)]
        new_order = [e.id for e in getattr(after, section) if e.id in old_entries]
        if old_order != new_order and sorted(old_order) == sorted(new_order):
            diff.append(
                DiffEntry(
                    section=section,
                    label=f"{section.title()} order",
                    field="order",
                    before=old_order,
                    after=new_order,
                    change="reordered",
                )
            )

    diff.extend(_diff_skills(before, after))

    return diff


def _diff_skills(before: MasterResume, after: MasterResume) -> list[DiffEntry]:
    """Report what happened to the skills, by skill rather than by category.

    Comparing category-by-category is misleading, because the optimizer
    regularly renames and merges them: "Frameworks" and "Tools & Infrastructure"
    become "Backend Frameworks & Tools". Keyed on the category name, that read
    as two whole categories deleted and one added, so the Changes tab told the
    user their entire toolchain had been removed when every skill was still
    there. Since the diff is the surface the README tells people to check before
    they send, it has to answer the question they actually have — did I lose
    anything? — before anything about grouping.
    """
    old_groups = [(g.category, list(g.items)) for g in before.skills]
    new_groups = [(g.category, list(g.items)) for g in after.skills]
    old_items = {item for _, items in old_groups for item in items}
    new_items = {item for _, items in new_groups for item in items}

    entries: list[DiffEntry] = []

    if dropped := sorted(old_items - new_items):
        entries.append(
            DiffEntry(
                section="skills",
                label="Skills no longer shown",
                field="items",
                before=dropped,
                after=None,
                change="removed",
            )
        )
    if added := sorted(new_items - old_items):
        # The merge already refuses to introduce a skill the master doesn't
        # list, so this should stay empty; surfaced anyway rather than trusted.
        entries.append(
            DiffEntry(
                section="skills",
                label="Skills added",
                field="items",
                before=None,
                after=added,
                change="added",
            )
        )

    # Same skills, different packaging: a regroup, not a removal.
    if old_groups != new_groups:
        entries.append(
            DiffEntry(
                section="skills",
                label="Skill groups",
                field="groups",
                before=[f"{name} ({len(items)})" for name, items in old_groups],
                after=[f"{name} ({len(items)})" for name, items in new_groups],
                change="reordered",
            )
        )

    return entries
