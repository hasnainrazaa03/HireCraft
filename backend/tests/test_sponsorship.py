"""Whether a posting will consider someone who needs visa sponsorship.

Every "real posting" case below is text that actually appeared in the feed and
was classified wrongly at some point during development. They are kept verbatim
because each one broke a different assumption, and the assumptions are the
interesting part:

* Roblox — a refusal whose negation is ninety characters upstream, running
  through the periods in "U.S.", which naive sentence-splitting cut in half.
* HPR — a refusal arriving from the scraper as "does not\\ncurrently\\n\\nprovide
  employment sponsorship", because HTML extraction drops line breaks mid-sentence.
* Verkada — a genuine offer preceded by eight hundred characters of unpunctuated
  benefits bullets, one of which contains "not".
* Zurich — "Employment Sponsorship Offered: No", where the negation is a field
  value to the *right* of the words that look like an offer.
* Arkansas — a template whose sponsorship field was never filled in.

The asymmetry that matters: telling a candidate a company sponsors when it
refuses costs them a wasted application and false hope, so an apparent offer is
the claim held to the highest standard.
"""

from __future__ import annotations

import pytest

from app.services.sponsorship import (
    BLOCKS_VISA_HOLDER,
    Sponsorship,
    classify,
    evidence,
)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # --- explicit offers -------------------------------------------------
        ("Visa sponsorship is available for this position.", Sponsorship.SPONSORS),
        ("We will sponsor H-1B transfers.", Sponsorship.SPONSORS),
        ("We are happy to sponsor work authorization for the right candidate.", Sponsorship.SPONSORS),
        ("Sponsorship Offered: Yes", Sponsorship.SPONSORS),
        ("Unlimited PTO - Visa sponsorship available - In-person in San Francisco", Sponsorship.SPONSORS),
        (
            "We accept students eligible for CPT/OPT and we sponsor work visas for full-time positions.",
            Sponsorship.SPONSORS,
        ),
        # --- explicit refusals -----------------------------------------------
        ("We are unable to provide visa sponsorship for this role.", Sponsorship.NO_SPONSORSHIP),
        ("This position does not offer visa sponsorship.", Sponsorship.NO_SPONSORSHIP),
        ("No visa sponsorship is available.", Sponsorship.NO_SPONSORSHIP),
        ("Sponsorship is not available now or in the future.", Sponsorship.NO_SPONSORSHIP),
        ("Applicants must be authorized to work without sponsorship.", Sponsorship.NO_SPONSORSHIP),
        ("We are not currently able to sponsor visas for fellows.", Sponsorship.NO_SPONSORSHIP),
        # --- citizenship and clearance ---------------------------------------
        ("Must be a U.S. citizen or lawful permanent resident", Sponsorship.CITIZENSHIP_REQUIRED),
        ("ITAR REQUIREMENTS: To conform to U.S. Government export control regulations", Sponsorship.CITIZENSHIP_REQUIRED),
        ("Green card holders only", Sponsorship.CITIZENSHIP_REQUIRED),
        ("Must be a US Citizen holding an active TS/SCI security clearance", Sponsorship.CLEARANCE_REQUIRED),
        ("Active Secret clearance required", Sponsorship.CLEARANCE_REQUIRED),
        ("Must possess a current clearance with full-scope polygraph", Sponsorship.CLEARANCE_REQUIRED),
        # --- says nothing -----------------------------------------------------
        ("", Sponsorship.UNSTATED),
        ("We are looking for a great engineer to join our team.", Sponsorship.UNSTATED),
        ("Competitive salary, equity, and unlimited PTO.", Sponsorship.UNSTATED),
    ],
)
def test_classify(text: str, expected: Sponsorship) -> None:
    assert classify(text) is expected


@pytest.mark.parametrize(
    "text",
    [
        "You will sponsor internal initiatives across teams.",
        "You will sponsor and mentor junior engineers.",
        "The team sponsors a quarterly hackathon.",
        "Sponsor the adoption of new tooling within the org.",
    ],
)
def test_the_ordinary_meaning_of_sponsor_is_not_an_offer(text: str) -> None:
    """"Sponsor" mostly has nothing to do with immigration.

    Job descriptions use it for internal advocacy far more often than for
    visas, so the bare verb never counts on its own.
    """
    assert classify(text) is Sponsorship.UNSTATED


# --- text taken verbatim from real postings ---------------------------------


def test_roblox_negation_across_an_abbreviation() -> None:
    text = (
        "For US based roles only, please note the Company may not be able to employ "
        "candidates for this role who have United States work authorization related to "
        "certain U.S. visa categories, or support future H-1B sponsorship at this time."
    )
    assert classify(text) is Sponsorship.NO_SPONSORSHIP


def test_hpr_negation_across_scraper_line_breaks() -> None:
    text = (
        "Perks including casual dress code, free food, team events, onsite gym, and more.\n\n"
        "Please note: HPR currently does not\ncurrently\n\nprovide employment sponsorship\n\n"
        "Hyannis Port Research is an Equal Opportunity Employer"
    )
    assert classify(text) is Sponsorship.NO_SPONSORSHIP


def test_verkada_offer_after_unpunctuated_benefit_bullets() -> None:
    """A distant "not" in a bullet list must not cancel a real offer.

    This is the counterweight to the two tests above: widening the search for a
    negation far enough to catch Roblox and HPR is what broke this one, so both
    directions need pinning.
    """
    text = (
        "Paid parental leave policy Family Planning and fertility benefits Professional "
        "development stipend Wellness/fitness benefits Healthy lunches provided daily "
        "Commuter benefits Additional Information We do sponsor and take over sponsorship "
        "of employment visas for this role."
    )
    assert classify(text) is Sponsorship.SPONSORS


def test_field_answered_no() -> None:
    assert classify("Employment Sponsorship Offered: No") is Sponsorship.NO_SPONSORSHIP
    assert classify("Visa Sponsorship: None") is Sponsorship.NO_SPONSORSHIP


def test_unfilled_template_field_says_nothing() -> None:
    text = "Work Shift: Sponsorship Available: ## Institution Name: University of Arkansas"
    assert classify(text) is Sponsorship.UNSTATED


# --- precedence and reporting -------------------------------------------------


def test_a_blocker_outranks_an_offer() -> None:
    """Boilerplate that welcomes sponsorship does not open a cleared role.

    A federal posting can carry a company-wide benefits paragraph mentioning
    sponsorship and a clearance requirement in its qualifications. The clearance
    is the fact that decides whether applying is worth the candidate's time.
    """
    text = (
        "We sponsor employment visas across the company. "
        "This role requires an active TS/SCI clearance with polygraph."
    )
    assert classify(text) is Sponsorship.CLEARANCE_REQUIRED


def test_silence_is_not_a_refusal() -> None:
    """Most postings say nothing, and hiding them would hide the market."""
    assert Sponsorship.UNSTATED.value not in BLOCKS_VISA_HOLDER
    assert Sponsorship.SPONSORS.value not in BLOCKS_VISA_HOLDER
    for blocked in (
        Sponsorship.NO_SPONSORSHIP,
        Sponsorship.CITIZENSHIP_REQUIRED,
        Sponsorship.CLEARANCE_REQUIRED,
    ):
        assert blocked.value in BLOCKS_VISA_HOLDER


def test_evidence_returns_the_deciding_text() -> None:
    """A verdict the reader cannot check is one they must take on trust."""
    text = "Great team, great mission. We are unable to provide visa sponsorship for this role."
    assert "sponsorship" in evidence(text).lower()
    assert evidence("") == ""
    assert evidence("Nothing relevant here at all.") == ""


# --- the corpus the browser extension is also held to ------------------------


def _shared_cases() -> list[tuple[str, str]]:
    """The case list both implementations are driven from.

    Skipped rather than failed when absent, so the backend suite still runs in a
    checkout without the extension.
    """
    import json
    from pathlib import Path

    # Canonical location is beside this test, so it ships inside the API image
    # and the cross-check actually runs rather than skipping. The extension's
    # suite reaches it by relative path from the repository root.
    corpus = Path(__file__).with_name("visa_cases.json")
    return [(text, expected) for text, expected in json.loads(corpus.read_text())]


def test_agrees_with_the_extension_on_every_shared_case() -> None:
    """The extension ports this module, and a silent divergence is the danger.

    The extension classifies postings that never reach the feed — a link from a
    friend, a company's own careers page — so it cannot simply call the API.
    Two implementations means two answers, and a reader who saw one verdict in
    the app and another on the page would rightly trust neither. Both are driven
    from the same corpus so a drift fails here rather than in front of a user.
    """
    wrong = [
        f"{expected} -> {classify(text).value}: {text[:70]!r}"
        for text, expected in _shared_cases()
        if classify(text).value != expected
    ]
    assert not wrong, "\n  " + "\n  ".join(wrong)
