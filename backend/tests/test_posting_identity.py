"""The board's own name for a posting, dug out of its URL.

The feed carries the same job several times. Aggregators copy a posting under
their own title and their own spelling of the link, so neither the URL nor the
title is stable across sources — but the requisition id inside the URL is,
because it is what the employer's own system calls the job.
"""

from __future__ import annotations

from app.services.jobfeed import posting_identity


def test_one_workday_requisition_under_three_urls():
    """Real rows from the feed: two aggregators, two spellings of the site name,
    a locale segment on some and not others, and a trailing -2 on the ones
    posted to a second careers site. One job, three URLs, three titles."""
    urls = [
        "https://kyndryl.wd5.myworkdayjobs.com/en-US/KyndrylProfessionalCareers/job/X/Early-Career-Consult-Program---Associate-AI-Engineer_R-66739-2",
        "https://kyndryl.wd5.myworkdayjobs.com/KyndrylEarlyCareers/job/X/Early-Career-Consult-Program---Associate-AI-Engineer_R-66739",
        "https://kyndryl.wd5.myworkdayjobs.com/en-US/kyndrylprofessionalcareers/job/X/Early-Career-Consult-Program---Associate-AI-Engineer_R-66739-2",
    ]
    found = {posting_identity(u) for u in urls}
    assert found == {"workday:kyndryl:r-66739"}


def test_the_same_ashby_posting_with_and_without_the_embed_flag():
    base = "https://jobs.ashbyhq.com/allen-control-systems/cfb348d0-ab31-4fa5-9bd5-def1de764ca9"
    assert posting_identity(base) == posting_identity(f"{base}/application?embed=true")


def test_greenhouse_writes_the_same_posting_three_ways():
    ident = "greenhouse:nuro:6916236"
    assert posting_identity("https://job-boards.greenhouse.io/embed/job_app?for=nuro&token=6916236") == ident
    assert posting_identity("https://job-boards.greenhouse.io/nuro/jobs/6916236") == ident
    assert posting_identity("https://boards.greenhouse.io/nuro/jobs/6916236?gh_jid=6916236") == ident


def test_two_different_jobs_never_share_an_identity():
    """The whole value of this is that it is tighter than a title match, not
    looser. Hiding a job somebody has not applied to is the failure that goes
    unnoticed."""
    a = posting_identity("https://boards.greenhouse.io/spacex/jobs/8501225002")
    b = posting_identity("https://boards.greenhouse.io/spacex/jobs/8637049002")
    c = posting_identity("https://boards.greenhouse.io/vercel/jobs/8501225002")
    assert a != b, "two requisitions at one company"
    assert a != c, "the same number at two companies"


def test_a_url_no_board_claims_gets_no_identity():
    """Better to fall back to the URL and title match than to invent a key —
    an identity built from something arbitrary would collide arbitrarily."""
    assert posting_identity("https://careers.example.com/apply/123") == ""
    assert posting_identity("") == ""
    assert posting_identity("not a url") == ""
