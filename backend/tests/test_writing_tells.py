"""Detecting machine-written prose in a cover letter.

The prompt asks the model to avoid these phrasings. This is the check that the
asking worked, because an instruction competes with everything else in a prompt
and these are exactly the constructions a model reaches for under pressure.
"""

from __future__ import annotations

import pytest

from app.services.writing_tells import find_tells, tell_count, uniformity

GENERATED = (
    "I am writing to express my interest in the Software Engineer role. "
    "I am excited to leverage my proven track record in machine learning. "
    "As a seasoned engineer, I am passionate about cutting-edge technology. "
    "I believe my unique blend of skills makes me an ideal candidate."
)

WRITTEN = (
    "Your posting mentions the roof-damage detector runs behind a Spring Boot service. "
    "I built that exact seam at Sunbase — a containerized FastAPI inference service the "
    "Java backend called over REST. Most of my four months went into the data, not the "
    "model. Shadows and vents were generating most of the false positives, so I mined "
    "them back as hard negatives and the numbers moved. That is the work I want more of."
)


def test_it_separates_generated_prose_from_written_prose() -> None:
    assert len(find_tells(GENERATED)) >= 8
    assert find_tells(WRITTEN) == []


@pytest.mark.parametrize(
    "phrase",
    [
        "I am writing to apply for this role",
        "I am thrilled to join your team",
        "I am passionate about distributed systems",
        "I want to leverage my experience",
        "I spearheaded the migration",
        "a robust and seamless solution",
        "As a seasoned backend engineer",
        "my proven track record speaks for itself",
        "I bring a unique blend of skills",
        "In today's fast-paced world",
        "not just an engineer, but a builder",
        "I believe my background is a fit",
        "which makes me an ideal candidate",
        "working at the intersection of ML and infrastructure",
    ],
)
def test_each_tell_is_caught(phrase: str) -> None:
    assert find_tells(phrase), f"missed: {phrase}"


@pytest.mark.parametrize(
    "phrase",
    [
        "I used PyTorch to train the detector",
        "The work excited the whole team, which was rare",
        "I led a four-person research team",
        "We built the annotation pipeline first",
        "It failed twice before it worked",
    ],
)
def test_ordinary_writing_is_not_flagged(phrase: str) -> None:
    """Flagging normal English would train the reader to ignore the flag.

    "Excited" is not banned; "I am excited to apply for" is. The list stays
    narrow so that a flag always means something.
    """
    assert find_tells(phrase) == []


def test_every_tell_suggests_a_repair() -> None:
    """A writer told only what not to do writes around it badly."""
    for found in find_tells(GENERATED):
        assert found["instead"], f"{found['phrase']} has no suggested repair"


def test_uniform_sentence_length_scores_worse_than_varied() -> None:
    """The tell writers never notice, and the one hardest to fake away.

    Generated prose settles into sentences of near-identical length; written
    prose swings between a long developing sentence and a short flat one.
    """
    metronomic = " ".join(["The system processed the data and returned a result."] * 6)
    varied = (
        "The pipeline broke. It broke in a way that took three days to find, because the "
        "failure surfaced two services downstream from its cause and looked like a "
        "serialisation bug the whole time. Then it was obvious. One field was nullable "
        "upstream and not nullable in the consumer, and nothing had ever sent a null "
        "until that week. I added the check."
    )
    assert uniformity(metronomic) > uniformity(varied)
    assert uniformity(metronomic) > 0.7


def test_short_text_is_not_accused_of_monotony() -> None:
    """Two sentences carry no rhythm to judge."""
    assert uniformity("One sentence here. And a second.") == 0.0
    assert uniformity("") == 0.0


def test_tell_count_reads_a_whole_letter() -> None:
    assert tell_count([GENERATED, WRITTEN]) == len(find_tells(GENERATED))
    assert tell_count([]) == 0
