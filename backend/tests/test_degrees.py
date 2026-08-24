"""Degree-requirement classification.

Two bugs found by hand during development are pinned here, because both were
invisible in the output and wrong in a way that mattered:

* ``b\\.?e\\.?`` matched the word "be", so nearly every posting in the feed was
  classified as requiring a bachelor's.
* A stated bachelor's minimum was treated as excluding a master's candidate,
  which would have hidden hundreds of roles they are eligible for.
"""

from __future__ import annotations

import pytest

from app.services.degrees import (
    GRADUATE_STATED,
    MASTERS_ELIGIBLE,
    DegreeLevel,
    classify,
)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        # --- a bachelor's and nothing above it -----------------------------
        ("Bachelor's degree in Computer Science", DegreeLevel.BACHELORS),
        ("BS in CS or a related field", DegreeLevel.BACHELORS),
        ("B.S. in Computer Science", DegreeLevel.BACHELORS),
        ("BSc Computer Science", DegreeLevel.BACHELORS),
        ("B.Tech in Information Technology", DegreeLevel.BACHELORS),
        # --- open-ended, so a higher degree qualifies ----------------------
        ("Bachelor's degree or higher", DegreeLevel.BACHELORS_OR_HIGHER),
        ("Minimum of a Bachelor's degree in engineering", DegreeLevel.BACHELORS_OR_HIGHER),
        ("At least a Bachelor's degree", DegreeLevel.BACHELORS_OR_HIGHER),
        # --- both named -----------------------------------------------------
        ("BS/MS in Computer Science", DegreeLevel.BACHELORS_OR_HIGHER),
        ("Bachelor's required, Master's preferred", DegreeLevel.BACHELORS_OR_HIGHER),
        ("Pursuing a Bachelor's or Master's degree", DegreeLevel.BACHELORS_OR_HIGHER),
        # --- graduate only --------------------------------------------------
        ("Master's degree in Machine Learning", DegreeLevel.MASTERS),
        ("M.S. in Computer Science", DegreeLevel.MASTERS),
        ("MS or PhD in a quantitative field", DegreeLevel.MASTERS),
        ("MSc in Statistics", DegreeLevel.MASTERS),
        # --- doctorate ------------------------------------------------------
        ("PhD in Computer Science required", DegreeLevel.PHD),
        ("Ph.D. candidates only", DegreeLevel.PHD),
        # --- restricted to undergraduates -----------------------------------
        ("Must be currently pursuing a Bachelor's degree", DegreeLevel.UNDERGRAD_ONLY),
        ("Open to undergraduate students only", DegreeLevel.UNDERGRAD_ONLY),
        ("Rising senior graduating in 2027", DegreeLevel.UNDERGRAD_ONLY),
        ("Currently enrolled in an undergraduate program", DegreeLevel.UNDERGRAD_ONLY),
        # --- says nothing ---------------------------------------------------
        ("", DegreeLevel.UNSPECIFIED),
        ("We are looking for a strong engineer to join the team", DegreeLevel.UNSPECIFIED),
        ("Experience with microservices, Kubernetes and CI/CD", DegreeLevel.UNSPECIFIED),
    ],
)
def test_classify(text: str, expected: DegreeLevel) -> None:
    assert classify(text) is expected


@pytest.mark.parametrize(
    "text",
    [
        "You will be responsible for building distributed systems",
        "This role can be remote and you will be on call one week in six",
        "Must be able to be effective across several teams",
        "Build systems that scale to millions of items",
        "Analyse metrics and be a force multiplier for the team",
    ],
)
def test_prose_is_not_a_degree_requirement(text: str) -> None:
    """No degree stated means unspecified.

    Specifically guards the regression where the bachelor's pattern accepted a
    bare "be": every one of these sentences was previously read as requiring a
    bachelor's degree.
    """
    assert classify(text) is DegreeLevel.UNSPECIFIED


def test_stated_bachelors_minimum_is_open_to_a_masters_candidate() -> None:
    """A bachelor's floor is not a master's exclusion.

    "Bachelor's degree in computer science" under BASIC QUALIFICATIONS is a
    minimum a master's clears, so it must stay in the master's-eligible set —
    excluding it hid roles the candidate could apply to.
    """
    assert classify("BASIC QUALIFICATIONS: Bachelor's degree in computer science")
    assert DegreeLevel.BACHELORS.value in MASTERS_ELIGIBLE


def test_masters_eligible_excludes_only_what_rules_them_out() -> None:
    assert DegreeLevel.UNDERGRAD_ONLY.value not in MASTERS_ELIGIBLE
    assert DegreeLevel.PHD.value not in MASTERS_ELIGIBLE
    # Silence is not a rejection, and most postings state no degree at all.
    assert DegreeLevel.UNSPECIFIED.value in MASTERS_ELIGIBLE


def test_graduate_stated_is_the_strict_subset() -> None:
    assert GRADUATE_STATED < MASTERS_ELIGIBLE
    assert DegreeLevel.UNSPECIFIED.value not in GRADUATE_STATED
    assert DegreeLevel.BACHELORS.value not in GRADUATE_STATED
