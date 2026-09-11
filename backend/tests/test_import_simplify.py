"""Matching a Simplify export against the tracker.

A wrong match is silent either way: a false one skips an application as
"already tracked", a missed one tracks it twice. Both were found in real
exports, which is why these cases are the real URLs.
"""

from __future__ import annotations

from scripts.import_simplify import _keys, _index_keys, _looks_like_page_chrome, _looks_like_slug, _posting_url


def test_a_url_that_names_no_posting_is_not_used_to_match_one():
    """Google's application dashboard is the same URL for every Google
    application; matching on it would swallow the next one."""
    assert _posting_url("https://www.google.com/about/careers/applications/dashboard") == ""
    assert _posting_url("https://career5.successfactors.eu/careers?company=capgemitecP3") == ""
    assert _posting_url("https://careers.rivian.com/jobs/30795?icims=1")


def test_two_google_applications_behind_the_dashboard_do_not_collide():
    a = _keys("https://www.google.com/about/careers/applications/dashboard", "Google",
              "Software Engineering Intern, MS, Summer 2027")
    b = _index_keys("https://www.google.com/about/careers/applications/dashboard", "Google",
                    "Software Engineer, Search Ads in AI Experiences")
    assert not set(a) & set(b)


def test_the_extensions_success_page_matches_the_exported_posting():
    """The extension records the page it saw the submission on; the export
    records the posting. Same Eightfold id, two places in the URL."""
    export = _keys("https://microsoft.eightfold.ai/careers/job/1970393556986737?domain=microsoft.com",
                   "Microsoft", "Software Engineering IC2")
    tracked = _index_keys("https://microsoft.eightfold.ai/careers/apply/success?domain=microsoft.com&pid=1970393556986737",
                          "Microsoft", "Submit application for Software Engineering IC2")
    assert set(export) & set(tracked)


def test_a_row_with_a_posting_id_is_never_matched_on_its_title_alone():
    """Two Coinbase postings both titled "Software Engineer" are two applications."""
    export = _keys("https://boards.greenhouse.io/embed/job_app?token=8113286", "Coinbase", "Software Engineer")
    other = _index_keys("https://boards.greenhouse.io/embed/job_app?token=9999999", "Coinbase", "Software Engineer")
    assert not set(export) & set(other)


def test_page_chrome_is_recognised_and_real_titles_are_not():
    assert _looks_like_page_chrome("Submit application for Software Engineer")
    assert _looks_like_page_chrome("Emory Careers")
    assert not _looks_like_page_chrome("Software Engineer - Early Careers")
    assert not _looks_like_page_chrome("Software Engineer")
    assert _looks_like_slug("non-clinical-emory")
    assert not _looks_like_slug("Jerry.ai")
    assert not _looks_like_slug("Torc Robotics")
