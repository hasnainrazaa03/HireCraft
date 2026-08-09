"""Usage labeling + categorization — the copy behind the Analytics tab.

The per-application Analytics view groups every LLM call by spend category and
shows a friendly step name per call. Both are derived from the raw ``purpose``
string, so these mappings are what the user actually reads.
"""

from __future__ import annotations

import pytest

from app.services.usage import (
    PURPOSE_LABELS,
    category_for,
    label_for,
)

# Every purpose the pipeline records (see the ledger.record calls).
KNOWN_PURPOSES = [
    "extract_requirements",
    "plan_coverage",
    "optimize_resume",
    "rewrite_resume",
    "revise_resume",
    "generate_profile_intro",
    "cover_letter",
    "outreach",
]


@pytest.mark.parametrize(
    ("purpose", "expected"),
    [
        ("extract_requirements", "resume"),
        ("plan_coverage", "resume"),
        ("optimize_resume", "resume"),
        ("rewrite_resume", "resume"),
        ("revise_resume", "resume"),
        ("generate_profile_intro", "resume"),
        ("cover_letter", "cover_letter"),
        ("draft_cover_letter", "cover_letter"),
        ("outreach", "outreach"),
        ("generate_outreach", "outreach"),
    ],
)
def test_category_for_maps_purposes(purpose: str, expected: str):
    assert category_for(purpose) == expected


def test_category_for_unknown_defaults_to_resume():
    assert category_for("some_new_step") == "resume"
    assert category_for("") == "resume"


def test_every_known_purpose_has_a_friendly_label():
    for purpose in KNOWN_PURPOSES:
        assert purpose in PURPOSE_LABELS
        assert label_for(purpose) == PURPOSE_LABELS[purpose]


def test_label_for_unknown_is_prettified_not_raw():
    # An unmapped purpose still reads as words, never a snake_case token.
    assert label_for("brand_new_step") == "Brand new step"
    assert "_" not in label_for("another_unknown_step")


def test_label_for_blank_has_a_fallback():
    assert label_for("") == "AI call"
    assert label_for("   ") == "AI call"
