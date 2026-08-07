"""House-style helpers: clichés, leak-stripping, verb variety, prompt block."""

from __future__ import annotations

from app.services.writing_quality import (
    cliches_in,
    house_style_block,
    leaks_in,
    repeated_opening_verbs,
    strip_leak_lines,
)


def test_cliches_detected_and_deduped():
    found = cliches_in("A passionate, results-driven team player with a proven track record.")
    assert "passionate" in found and "results-driven" in found and "team player" in found
    assert len(found) == len(set(found))  # deduped


def test_cliches_no_false_positive_inside_longer_words():
    # "compassionate" must not fire "passionate"; "passion project" is not "passion for"
    assert cliches_in("Delivered compassionate care on a passion project") == []


def test_cliches_cover_letter_pool_adds_transitions():
    text = "Furthermore, I am writing to express my interest."
    base = cliches_in(text)
    cl = cliches_in(text, cover_letter=True)
    assert "furthermore" in cl and "i am writing to" in cl
    assert "furthermore" not in base  # only in the cover-letter pool


def test_leaks_detected_and_stripped():
    assert leaks_in("Here is the revised letter you asked for") == ["here is the"]
    kept = strip_leak_lines(["Here is the letter:", "Dear Team, I built X.", "As requested, done."])
    assert kept == ["Dear Team, I built X."]


def test_repeated_opening_verbs():
    assert repeated_opening_verbs(["Built A", "Built B", "Led C"]) == {"built": 2}
    assert repeated_opening_verbs(["Built A", "Led B", "Designed C"]) == {}


def test_house_style_block_bans_and_shapes():
    block = house_style_block()
    assert "BANNED PHRASES" in block and "passionate" in block
    assert "DIFFERENT verb" in block  # verb-variety instruction (résumé mode)
    cl = house_style_block(cover_letter=True)
    assert "i am writing to" in cl  # cover-letter clichés folded in
