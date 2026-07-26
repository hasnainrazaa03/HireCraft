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
