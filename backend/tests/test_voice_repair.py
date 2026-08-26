"""Salvaging a nearly-right voice profile instead of discarding it.

VoiceProfile is a tightly constrained schema, and the model fills it correctly
most of the time and slightly wrong the rest — inconsistently enough that the
same prompt on the same samples succeeded and failed on consecutive calls. The
failure the user meets is "couldn't analyse your writing" after uploading a
dozen samples, which is a poor return for a reply that understood the task and
got its punctuation wrong.

Both real failures seen against live output are pinned here: list fields
returned as a single string, and a capped string overrunning by a few characters.
"""

from __future__ import annotations

import pytest

from app.schemas.writing import VoiceProfile
from app.services.llm.voice import _repair


def test_a_list_field_returned_as_a_comma_string() -> None:
    out = _repair({"vocabulary": "hands-on, actionable insights, rigorous"})
    assert out["vocabulary"] == ["hands-on", "actionable insights", "rigorous"]


def test_a_list_field_returned_as_bullet_lines() -> None:
    out = _repair({"habits": "- opens with a hook\n- quotes the posting\n- closes warmly"})
    assert out["habits"] == ["opens with a hook", "quotes the posting", "closes warmly"]


def test_semicolons_win_over_commas() -> None:
    """A phrase can contain a comma; a semicolon-separated list must survive it."""
    out = _repair({"avoid": "warm, but never gushing; passive voice; filler"})
    assert out["avoid"] == ["warm, but never gushing", "passive voice", "filler"]


def test_a_single_value_becomes_a_one_item_list() -> None:
    assert _repair({"avoid": "passive voice"})["avoid"] == ["passive voice"]
    assert _repair({"avoid": ""})["avoid"] == []
    assert _repair({"avoid": None})["avoid"] == []


def test_a_correct_list_is_left_alone() -> None:
    out = _repair({"vocabulary": ["direct", "specific", "  padded  ", ""]})
    assert out["vocabulary"] == ["direct", "specific", "padded"]


def test_an_overlong_string_is_cut_at_a_boundary() -> None:
    """Cut where a sentence ends, so the description still reads as written."""
    text = ("Mostly medium-length declarative sentences built around I statements. "
            * 8)
    out = _repair({"sentence_style": text})
    assert len(out["sentence_style"]) <= 300
    assert out["sentence_style"].endswith(".")
    assert not out["sentence_style"].endswith(" ")


def test_an_unknown_formality_falls_back_rather_than_failing() -> None:
    assert _repair({"formality": "semi-formal"})["formality"] == "unknown"
    assert _repair({"formality": "professional"})["formality"] == "professional"
    assert _repair({})["formality"] == "unknown"


def test_the_repaired_payload_validates() -> None:
    """The whole point: a reply that failed validation now passes it."""
    broken = {
        "tone": "Earnest, high-energy",
        "formality": "semi-professional",
        "sentence_style": "Medium declarative sentences. " * 20,
        "vocabulary": "hands-on, bridge, rigor",
        "habits": "quotes the posting; names a specific hook",
        "avoid": "passive voice, filler",
        "summary": "Write like an earnest graduate student.",
    }
    with pytest.raises(Exception):
        VoiceProfile.model_validate(broken)

    voice = VoiceProfile.model_validate(_repair(dict(broken)))
    assert voice.vocabulary == ["hands-on", "bridge", "rigor"]
    assert voice.habits == ["quotes the posting", "names a specific hook"]
    assert voice.formality == "unknown"
    assert len(voice.sentence_style) <= 300
