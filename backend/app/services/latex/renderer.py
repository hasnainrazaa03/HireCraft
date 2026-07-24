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
) -> str:
    """Render a validated resume into a complete LaTeX document."""
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
    return template.render(r=resume, basics=resume.basics, sections=sections)


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
