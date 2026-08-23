"""Jinja2 -> LaTeX rendering.

Jinja's default ``{{ }}`` / ``{% %}`` delimiters collide with LaTeX's own braces
and ``%`` comments, so this environment uses LaTeX-safe delimiters instead:

    ((( value )))      variables
    ((* for x in y *)) blocks
    ((# comment #))    comments

``finalize=escape_tex`` means every interpolated variable is escaped by default.
Templates opt out explicitly with the ``raw`` filter, which exists so a template
can emit LaTeX it constructed itself - never for user data.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, StrictUndefined, select_autoescape

from app.schemas.resume import MasterResume
from app.services.latex.escaping import TexSafe, display_url, escape_tex, escape_url


class TemplateNotFoundError(Exception):
    """Raised when a requested template does not exist in the templates dir."""


def _raw(value: object) -> TexSafe:
    """Explicit opt-out from escaping. Never apply this to user-supplied text."""
    return TexSafe("" if value is None else str(value))


def _join(values: object, separator: str = ", ") -> TexSafe:
    """Escape each element, then join with an unescaped separator."""
    if not values:
        return TexSafe("")
    if isinstance(values, str):
        return escape_tex(values)
    return TexSafe(separator.join(escape_tex(v) for v in values))


def _date_range(start: str | None, end: str | None) -> TexSafe:
    """Render '2024-05' + '2024-08' as 'May 2024 -- Aug 2024'."""
    months = {
        "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
        "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
        "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
    }

    def fmt(value: str | None) -> str:
        if not value:
            return ""
        if value == "Present":
            return "Present"
        if "-" in value:
            year, month = value.split("-", 1)
            return f"{months.get(month, '')} {year}".strip()
        return value

    left, right = fmt(start), fmt(end)
    if left and right:
        return TexSafe(f"{escape_tex(left)} -- {escape_tex(right)}")
    return escape_tex(left or right)


@lru_cache
def get_environment(templates_dir: str) -> Environment:
    path = Path(templates_dir)
    if not path.is_dir():
        raise TemplateNotFoundError(f"Templates directory not found: {templates_dir}")

    env = Environment(
        loader=FileSystemLoader(str(path)),
        block_start_string="((*",
        block_end_string="*))",
        variable_start_string="(((",
        variable_end_string=")))",
        comment_start_string="((#",
        comment_end_string="#))",
        trim_blocks=True,
        lstrip_blocks=True,
        keep_trailing_newline=True,
        undefined=StrictUndefined,
        autoescape=select_autoescape(enabled_extensions=(), default=False),
        finalize=escape_tex,
    )
    env.filters["raw"] = _raw
    env.filters["tex"] = escape_tex
    env.filters["url"] = escape_url
    env.filters["display_url"] = display_url
    env.filters["texjoin"] = _join
    env.globals["date_range"] = _date_range
    return env


def render_resume(
    resume: MasterResume,
    templates_dir: str,
    template_name: str = "base_resume.tex",
    *,
    density: int = 0,
) -> str:
    """Render a validated resume into a complete LaTeX document.

    ``density`` (0-3) drives the compact overrides in ``partials/_compact.tex``:
    0 is the template's native look, higher values tighten margins/spacing to
    fit more on a page. Callers use ``render_and_fit`` to escalate it.
    """
    env = get_environment(templates_dir)
    template = env.get_template(template_name)

    # Only render sections that have content, in the resume's declared order.
    sections = [
        name
        for name in resume.section_order
        if (
            getattr(resume, name, None)
            if name != "summary"
            else (resume.basics.summary or resume.basics.headline)
        )
    ]
    return template.render(
        r=resume, basics=resume.basics, sections=sections, density=density
    )


# Readable floor: never compact past this level, even if the résumé still spills.
_MAX_DENSITY = 3
# Backstop cap on how many bullets one-page fit may trim before giving up.
_MAX_TRIM_STEPS = 24


def _trim_one(resume: MasterResume) -> bool:
    """Drop the single lowest-priority BULLET so a résumé can fit one page.

    Never removes an entry. An earlier version popped an entry once its last
    bullet went, which silently deleted a whole project from the résumé to win a
    page — losing real work is far worse than spilling onto a second page. Every
    entry keeps at least one bullet, and if that still doesn't fit,
    ``render_and_fit`` accepts two pages rather than cutting deeper.

    Trims projects before experience, last entry first (the tailoring orders by
    relevance, so the tail is the least relevant), and leaves education alone.
    """
    for section in ("projects", "experience"):
        entries = getattr(resume, section, None) or []
        for i in range(len(entries) - 1, -1, -1):
            highlights = getattr(entries[i], "highlights", None)
            # > 1: the entry always keeps a bullet, so it never disappears.
            if highlights and len(highlights) > 1:
                highlights.pop()
                return True
    return False


def render_and_fit(
    resume: MasterResume,
    templates_dir: str,
    template_name: str = "base_resume.tex",
    *,
    one_page: bool = False,
    job_name: str = "resume",
):
    """Render and compile a résumé PDF. When ``one_page`` is set, escalate the
    compact density until the PDF fits a single page or the readable floor is
    reached; if it still spills at max density, trim the lowest-priority bullets
    until it fits — so one page is a real guarantee, not best-effort.

    Returns ``(CompileResult, tex, rendered)`` where ``rendered`` is the résumé the
    PDF actually contains — the input unless trimming was needed. Callers that
    persist, score, or export the résumé must store ``rendered``, or the app shows
    and scores bullets the delivered PDF doesn't have.
    """
    # Imported lazily so the renderer module has no import-time dependency on the
    # LaTeX toolchain wrapper.
    from app.services.latex.compiler import compile_latex

    max_density = _MAX_DENSITY if one_page else 0
    result = None
    tex = ""
    for density in range(max_density + 1):
        tex = render_resume(resume, templates_dir, template_name, density=density)
        result = compile_latex(tex, job_name=job_name)
        if not one_page or result.page_count <= 1:
            return result, tex, resume

    # Density is maxed and it still spills: prune lowest-priority content (on a
    # copy, so the caller's résumé is untouched) and re-render at max density.
    pruned = resume.model_copy(deep=True)
    for _ in range(_MAX_TRIM_STEPS):
        if not _trim_one(pruned):
            break
        tex = render_resume(pruned, templates_dir, template_name, density=max_density)
        result = compile_latex(tex, job_name=job_name)
        if result.page_count <= 1:
            break
    return result, tex, pruned


def render_cover_letter(
    resume: MasterResume,
    body_paragraphs: list[str],
    templates_dir: str,
    *,
    company: str | None = None,
    role: str | None = None,
    hiring_manager: str | None = None,
    date_line: str | None = None,
    template_name: str = "cover_letter.tex",
) -> str:
    env = get_environment(templates_dir)
    template = env.get_template(template_name)
    return template.render(
        basics=resume.basics,
        paragraphs=body_paragraphs,
        company=company,
        role=role,
        hiring_manager=hiring_manager,
        date_line=date_line,
    )
