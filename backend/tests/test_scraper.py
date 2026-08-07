"""Scraper safety tests.

The URL is user-supplied and the fetch happens from inside our network, so the
properties that matter are: we never reach an internal address, a redirect
cannot smuggle us to one, and a hostile response cannot exhaust memory.
"""

from __future__ import annotations

import http.server
import ipaddress
import socketserver
import threading

import pytest

from app.services.scraper import (
    ScrapeError,
    _assert_peer_allowed,
    _ats_api_result,
    _is_blocked_address,
    scrape_job,
    validate_url,
)

PAGE = (
    "<html><head><title>Senior Widget Engineer</title>"
    "<meta property='og:site_name' content='Globex'></head><body><main>"
    + "<p>We are hiring a widget engineer to build and ship widgets in Python. "
      "Requires five years of experience and a degree.</p>" * 6
    + "</main></body></html>"
).encode()


class _Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):  # keep pytest output clean
        pass

    def do_GET(self):  # noqa: N802 - stdlib naming
        if self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "/job")
            self.end_headers()
            return
        if self.path == "/badcharset":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=definitely-not-a-codec")
            self.send_header("Content-Length", str(len(PAGE)))
            self.end_headers()
            self.wfile.write(PAGE)
            return
        if self.path == "/huge":
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            for _ in range(200):
                self.wfile.write(b"<p>" + b"x" * 100_000 + b"</p>")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)


@pytest.fixture
def server():
    httpd = socketserver.TCPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


@pytest.fixture
def reachable(monkeypatch):
    """Let the pre-request check pass so loopback is fetchable.

    This is also the exact shape of a DNS rebind: the name resolved to a public
    address when it was checked, and to something internal when it was dialled.
    """
    import app.services.scraper as scraper

    monkeypatch.setattr(scraper, "_is_blocked_ip", lambda host: False)


class TestAddressFiltering:
    @pytest.mark.parametrize(
        "address",
        [
            "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1",
            "169.254.169.254",   # AWS/GCP/Azure metadata
            "fd00:ec2::254",     # its IPv6 equivalent
            "::1", "0.0.0.0",
        ],
    )
    def test_internal_addresses_are_blocked(self, address):
        assert _is_blocked_address(ipaddress.ip_address(address))

    @pytest.mark.parametrize("address", ["93.184.216.34", "8.8.8.8", "2606:2800:220:1::1"])
    def test_public_addresses_are_allowed(self, address):
        assert not _is_blocked_address(ipaddress.ip_address(address))

    def test_loopback_url_is_refused_before_any_request(self, server):
        with pytest.raises(ScrapeError, match="private or internal"):
            scrape_job(f"{server}/job")

    @pytest.mark.parametrize("url", ["ftp://example.com/x", "file:///etc/passwd"])
    def test_non_http_schemes_are_refused(self, url):
        with pytest.raises(ScrapeError):
            validate_url(url)


class TestRebinding:
    def test_a_peer_that_turns_out_internal_is_refused(self, server, reachable):
        """Regression: validating the hostname resolves it once for the check
        and again for the connection. A record that changes between the two —
        rebinding, or a short-TTL record with several answers — passed the
        check and still landed on an internal host, and the response came back
        to the caller. The address on the open socket is the only reliable
        answer, so it is re-checked before the body is read."""
        with pytest.raises(ScrapeError, match="private or internal"):
            scrape_job(f"{server}/job")

    def test_missing_peer_info_does_not_break_the_fetch(self):
        """Some transports expose no peer; fall back to the pre-request check
        rather than failing every scrape."""
        class _NoStream:
            extensions: dict = {}

        _assert_peer_allowed(_NoStream())  # must not raise


class TestFetching:
    @pytest.fixture(autouse=True)
    def _allow_loopback(self, monkeypatch, reachable):
        import app.services.scraper as scraper

        monkeypatch.setattr(scraper, "_assert_peer_allowed", lambda response: None)

    def test_extracts_text_and_metadata(self, server):
        result = scrape_job(f"{server}/job")
        assert result.title == "Senior Widget Engineer"
        assert result.company == "Globex"
        assert "widget engineer" in result.text.lower()

    def test_redirects_are_followed_and_revalidated(self, server):
        assert scrape_job(f"{server}/redirect").url.endswith("/job")

    def test_an_oversized_body_is_aborted(self, server, monkeypatch):
        """The cap has to apply while streaming; checking length afterwards
        means the whole page is already in memory."""
        from app.core import config

        monkeypatch.setattr(config.settings, "scrape_max_bytes", 500_000)
        with pytest.raises(ScrapeError, match="unexpectedly large"):
            scrape_job(f"{server}/huge")


class TestDecoding:
    """The charset comes from a header on a page we do not control."""

    @pytest.mark.parametrize(
        ("declared", "expected"),
        [
            ("utf-8", "café"),
            (None, "café"),
            # Regression: a codec Python has never heard of made bytes.decode
            # raise LookupError, which nothing caught — an unhandled 500 from
            # any pasted job URL. httpx's .text absorbed this; decoding by hand
            # means handling it by hand.
            ("definitely-not-a-codec", "café"),
            ("", "café"),
        ],
    )
    def test_unknown_charsets_fall_back_to_utf8(self, declared, expected):
        from app.services.scraper import _decode_body

        assert _decode_body("café".encode(), declared) == expected

    def test_a_declared_charset_is_honoured_when_real(self):
        from app.services.scraper import _decode_body

        assert _decode_body("café".encode("latin-1"), "latin-1") == "café"

    def test_undecodable_bytes_do_not_raise(self):
        from app.services.scraper import _decode_body

        assert _decode_body(b"\xff\xfe\x00bad", "utf-8")  # errors="replace"

    def test_a_bogus_charset_header_does_not_500_the_fetch(self, server, monkeypatch):
        """End to end through scrape_job, the way a job board would trigger it."""
        import app.services.scraper as scraper

        monkeypatch.setattr(scraper, "_is_blocked_ip", lambda host: False)
        monkeypatch.setattr(scraper, "_assert_peer_allowed", lambda response: None)
        result = scrape_job(f"{server}/badcharset")
        assert "widget engineer" in result.text.lower()


class _JsonResp:
    """Minimal stand-in for an httpx JSON response."""

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class TestAtsApi:
    """Ashby/Greenhouse/Lever serve JS shells; their public JSON APIs don't.

    _ats_api_result recognises the board from the URL and pulls the full
    description from the API keyed off the org + id already in that URL.
    """

    _DESC = "We are hiring a machine learning engineer. " * 8

    def test_ashby_posting_is_fetched_from_the_api(self, monkeypatch):
        import app.services.scraper as scraper

        pid = "3eb7e80e-6a0d-41b6-8ee4-f62421c486e4"
        payload = {"jobs": [
            {"id": "other", "title": "Nope", "descriptionPlain": "x"},
            {"id": pid, "title": "ML Engineer, New Grad",
             "location": "Remote", "descriptionPlain": self._DESC},
        ]}
        monkeypatch.setattr(scraper.httpx, "get", lambda *a, **k: _JsonResp(payload))
        r = _ats_api_result(f"https://jobs.ashbyhq.com/quora/{pid}", timeout=5)
        assert r is not None
        assert r.title == "ML Engineer, New Grad"
        assert r.company == "Quora" and r.source == "ashby"
        assert "machine learning engineer" in r.text.lower()

    def test_greenhouse_content_html_is_stripped(self, monkeypatch):
        import app.services.scraper as scraper

        payload = {"title": "Backend Engineer", "location": {"name": "NYC"},
                   "content": "&lt;p&gt;" + self._DESC + "&lt;/p&gt;"}
        monkeypatch.setattr(scraper.httpx, "get", lambda *a, **k: _JsonResp(payload))
        r = _ats_api_result("https://boards.greenhouse.io/acme/jobs/123456", timeout=5)
        assert r is not None and r.title == "Backend Engineer"
        assert "<p>" not in r.text and "machine learning engineer" in r.text.lower()

    def test_lever_posting_joins_description_and_lists(self, monkeypatch):
        import app.services.scraper as scraper

        pid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        payload = {"text": "Data Scientist", "descriptionPlain": self._DESC,
                   "categories": {"location": "Remote"},
                   "lists": [{"text": "Requirements", "content": "<li>Python</li>"}]}
        monkeypatch.setattr(scraper.httpx, "get", lambda *a, **k: _JsonResp(payload))
        r = _ats_api_result(f"https://jobs.lever.co/acme/{pid}", timeout=5)
        assert r is not None and r.title == "Data Scientist"
        assert "Python" in r.text

    def test_non_ats_url_returns_none(self):
        assert _ats_api_result("https://example.com/careers/123", timeout=5) is None

    def test_a_thin_api_response_is_rejected(self, monkeypatch):
        """Too little text falls through to None so HTML scraping can try."""
        import app.services.scraper as scraper

        pid = "3eb7e80e-6a0d-41b6-8ee4-f62421c486e4"
        payload = {"jobs": [{"id": pid, "title": "T", "descriptionPlain": "short"}]}
        monkeypatch.setattr(scraper.httpx, "get", lambda *a, **k: _JsonResp(payload))
        assert _ats_api_result(f"https://jobs.ashbyhq.com/o/{pid}", timeout=5) is None


class TestRejectReason:
    """The dead-link / JS-shell / thin-page guard (T-TLR-03)."""

    def test_javascript_shell_rejected(self):
        from app.services.scraper import _reject_reason

        assert _reject_reason("Careers. Please enable JavaScript to run this app. Home Jobs") is not None

    def test_expired_or_thin_page_rejected(self):
        from app.services.scraper import _reject_reason

        assert _reject_reason("The job you are looking for is no longer available. Browse openings.") is not None
        assert _reject_reason("Software Engineer. Apply. Login.") is not None

    def test_real_job_description_passes(self):
        from app.services.scraper import _reject_reason

        jd = (
            "Machine Learning Engineer. Build recommendation systems in PyTorch, deploy to "
            "production, collaborate with product. Requirements: 3+ years Python, deep "
            "learning, distributed training, MLOps. Design scalable pipelines and run "
            "experiments to improve ranking quality across the stack. " * 3
        )
        assert _reject_reason(jd) is None
        # A long, real JD that merely mentions "no longer" is NOT falsely rejected
        assert _reject_reason(jd + " Legacy code is no longer supported.") is None
