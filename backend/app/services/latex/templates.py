"""Résumé template registry.

Each template is a LaTeX file in the templates dir that includes the shared
``partials/_body.tex`` after its own preamble, so they differ in style but stay
consistent in content. ``id`` is what's stored on a résumé; ``filename`` is what
the renderer loads.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Template:
    id: str
    name: str
    description: str
    filename: str


TEMPLATES: tuple[Template, ...] = (
    Template(
        id="classic",
        name="Classic",
        description=(
            "Single-column with a two-column contact header and small-caps rules — "
            "the widely-used engineering résumé layout. The default: an imported "
            "résumé of this shape keeps its own look instead of being restyled."
        ),
        filename="classic.tex",
    ),
    Template(
        id="modern",
        name="Modern",
        description="Navy accent with small-caps headings. Clean and professional — a strong default.",
        filename="modern.tex",
    ),
    Template(
        id="compact",
        name="Compact",
        description=(
            "Dense single-column classic at 10.5pt — the most content per page. "
            "Fits a full résumé on one page where styled templates need to shrink."
        ),
        filename="compact.tex",
    ),
    Template(
        id="ats",
        name="ATS",
        description="Monochrome and maximally parseable. Built for applicant-tracking systems.",
        filename="ats.tex",
    ),
    Template(
        id="minimal",
        name="Minimal",
        description="Airy and understated, with generous whitespace and no rules.",
        filename="minimal.tex",
    ),
    Template(
        id="academic",
        name="Academic",
        description="Formal CV style with a serif face — publications and research friendly.",
        filename="academic.tex",
    ),
)

_BY_ID = {t.id: t for t in TEMPLATES}

DEFAULT_TEMPLATE_ID = "classic"


def resolve_filename(template_id: str | None) -> str:
    """Map a stored template id to its filename, falling back to the default."""
    template = _BY_ID.get(template_id or DEFAULT_TEMPLATE_ID)
    return (template or _BY_ID[DEFAULT_TEMPLATE_ID]).filename


def is_valid(template_id: str) -> bool:
    return template_id in _BY_ID
