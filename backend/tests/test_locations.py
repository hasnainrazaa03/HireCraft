"""Condensing a posting's location so it fits on a card.

Workday lets an employer attach one requisition to every site it could be
worked from and hands the list over as a single string. One CVS Health posting
arrives as 500 characters of work-from-home states, which rendered as sixteen
lines and pushed the rest of the card off the bottom.
"""

from __future__ import annotations

from app.services.locations import summarise

CVS = (
    "Chicago-525 West Monroe; Work At Home-Arkansas; Work At Home-Idaho; "
    "Work At Home-Texas; Work At Home-Georgia; Work At Home-Montana; "
    "Work At Home-Iowa; Work At Home-Wisconsin; Work At Home-Oregon; "
    "Work At Home-Washington; Work At Home-New York; Work At Home-District of Columbia; "
    "Work At Home-Connecticut; Work At Home-Nebraska; Work At Home-Rhode Island; "
    "Work At Home-Tennessee; Work At Home-Kentucky; Work At Home-Ohio; "
    "Work At Home-West Virginia; Work At Home-Maryland; Work At Home-Massachusetts;"
)


def test_the_posting_that_broke_the_card():
    got = summarise(CVS)
    assert got == "Chicago + remote (20 more)"
    assert len(got) < 40


def test_an_ordinary_location_is_left_exactly_as_it_is():
    """Almost every posting names one place. None of them should be touched."""
    for plain in ["Santa Clara, CA, USA", "New York, NY", "Remote in USA", "London, UK", ""]:
        assert summarise(plain) == plain


def test_a_short_list_is_left_alone_too():
    """Three cities fit on a card; condensing them would lose information for
    no gain."""
    short = "Atlanta, GA, USA | Normal, IL, USA | Plymouth, MI, USA"
    assert summarise(short) == short


def test_an_all_remote_list_says_remote_rather_than_naming_every_state():
    many = "; ".join(f"Work At Home-{s}" for s in
                     ["Texas", "Georgia", "Iowa", "Ohio", "Maine", "Utah", "Idaho", "Kansas"])
    assert summarise(many) == "Remote (8 locations)"


def test_the_count_is_kept_because_a_silent_truncation_would_be_a_lie():
    """"+18 more" is information. Cutting at the first entry and saying nothing
    would claim the role is in one city when it is in nineteen."""
    cities = "; ".join(f"City{n}, ST" for n in range(19))
    got = summarise(cities)
    assert got.startswith("City0")
    assert "18 more" in got


def test_one_very_long_entry_loses_the_building_before_it_loses_the_city():
    """Workday prefixes an office with its site code and street address. The
    city is the part anybody reads, so it is the part that survives.

    Note the threshold is a card's width, not tidiness: a 57-character entry
    fits and is returned untouched, so the input here is one that genuinely
    does not."""
    long_site = "USA-NY-New York-1 Penn Plaza Suite 3400 Floor 12 East Wing Building B"
    assert len(long_site) > 60
    assert summarise(long_site) == "NY-New York"
    assert summarise("USA-NY-New York-1 Penn Plaza Suite 3400") == "USA-NY-New York-1 Penn Plaza Suite 3400"


def test_nothing_is_returned_for_nothing():
    assert summarise(None) == ""
