"""Job posting scraper: URL in, clean plain text out.

Two hard requirements shape this module:

* **SSRF safety.** The URL comes from a user, and the fetch happens from inside
  our network. Every resolved IP is checked against private, loopback, and
  link-local ranges - including after each redirect hop, since a public hostname
  can redirect to 169.254.169.254 and reach a cloud metadata endpoint.
* **Extraction quality.** Job boards wrap the posting in navigation, cookie
  banners, and "similar jobs" lists. Feeding that to the LLM wastes tokens and
  pollutes requirement extraction, so trafilatura does main-content extraction
  with a BeautifulSoup fallback.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup

from app.core.config import settings
from app.core.logging import get_logger
from app.schemas.job import ScrapeResult

logger = get_logger(__name__)

MAX_TEXT_CHARS = 24_000

_WHITESPACE = re.compile(r"[ \t ]+")
_BLANK_LINES = re.compile(r"\n{3,}")

# Boilerplate lines that survive extraction on most job boards.
_NOISE_PATTERNS = re.compile(
    r"^(cookie|we use cookies|accept all|privacy policy|share this job|"
    r"sign in|log in|create account|apply now|save job|report job|"
    r"similar jobs|recommended for you|back to search)\b",
    re.IGNORECASE,
)

_KNOWN_BOARDS = {
    "linkedin.com": "linkedin",
    "greenhouse.io": "greenhouse",
    "lever.co": "lever",
    "workday.com": "workday",
    "myworkdayjobs.com": "workday",
    "ashbyhq.com": "ashby",
    "indeed.com": "indeed",
    "glassdoor.com": "glassdoor",
    "smartrecruiters.com": "smartrecruiters",
    "jobvite.com": "jobvite",
    "icims.com": "icims",
    "handshake.com": "handshake",
    "joinhandshake.com": "handshake",
}


class ScrapeError(Exception):
    """Raised when a job posting cannot be retrieved or parsed."""


def _is_blocked_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """True for any address we must never fetch from.

    ``is_link_local`` is what covers the cloud metadata endpoints -
    169.254.169.254 and, on IPv6, fd00:ec2::254 (which ``is_private`` catches).
    """
    return (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_multicast
        or address.is_unspecified
    )


def _is_blocked_ip(host: str) -> bool:
    """True if ``host`` resolves to any address we must not fetch from."""
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise ScrapeError(f"Could not resolve host {host!r}.") from exc

    return any(_is_blocked_address(ipaddress.ip_address(info[4][0])) for info in infos)


def _assert_peer_allowed(response: httpx.Response) -> None:
    """Re-check the address we actually connected to.

    Validating the hostname before the request leaves a gap: the name is
    resolved once for the check and again by the connection, so a DNS entry
    that flips between the two (rebinding, or simply a short-TTL record with
    several answers) can pass the check and still land on an internal host.
    Reading the peer off the open socket is the only way to know where the
    bytes are really coming from, and it happens before the body is read.

    If the transport doesn't expose a peer - a mock in tests, some proxy
    setups - fall back to the pre-request check rather than failing the fetch.
    """
    stream = response.extensions.get("network_stream")
    if stream is None:
        return
    try:
        peer = stream.get_extra_info("server_addr")
    except Exception:  # noqa: BLE001 - transport-specific; absence isn't fatal
        return
    if not peer:
        return
    try:
        address = ipaddress.ip_address(peer[0])
    except ValueError:
        return
    if _is_blocked_address(address):
        raise ScrapeError(
            "That URL resolves to a private or internal address and will not be fetched."
        )


def validate_url(url: str) -> str:
    """Validate a user-supplied job URL, rejecting anything unsafe to fetch."""
    url = (url or "").strip()
    if not url:
        raise ScrapeError("No URL provided.")
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ScrapeError(f"Unsupported URL scheme {parsed.scheme!r}.")
    if not parsed.hostname:
        raise ScrapeError("URL has no hostname.")
    if _is_blocked_ip(parsed.hostname):
        raise ScrapeError(
            "That URL resolves to a private or internal address and will not be fetched."
        )
    return url


def detect_source(url: str | None) -> str | None:
    if not url:
        return None
    host = (urlparse(url).hostname or "").lower()
    for domain, name in _KNOWN_BOARDS.items():
        if host == domain or host.endswith(f".{domain}"):
            return name
    return host or None


def clean_text(raw: str) -> str:
    """Collapse whitespace and strip job-board boilerplate."""
    lines: list[str] = []
    for line in raw.splitlines():
        line = _WHITESPACE.sub(" ", line).strip()
        if not line:
            lines.append("")
            continue
        if _NOISE_PATTERNS.match(line):
            continue
        # Drop isolated navigation fragments, but keep short real content like
        # section headings ("Requirements:") which end in a colon.
        if len(line) < 3 and not line.endswith(":"):
            continue
        lines.append(line)

    text = _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()
    return text


def _extract_with_trafilatura(html: str, url: str | None) -> str | None:
    try:
        import trafilatura
    except ImportError:  # pragma: no cover - optional at test time
        return None
    try:
        return trafilatura.extract(
            html,
            url=url,
            include_comments=False,
            include_tables=True,
            no_fallback=False,
            favor_recall=True,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("scraper.trafilatura_failed", error=str(exc))
        return None


def _extract_with_soup(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(
        ["script", "style", "nav", "footer", "header", "noscript", "svg", "form", "iframe"]
    ):
        tag.decompose()

    # Prefer an explicit job-description container when the board provides one.
    for selector in (
        '[class*="job-description"]',
        '[class*="jobDescription"]',
        '[data-testid*="jobDescription"]',
        '[class*="description"]',
        "main",
        "article",
    ):
        node = soup.select_one(selector)
        # Guard against matching a stub container that holds only a heading.
        if node and len(node.get_text(strip=True)) > 200:
            return node.get_text(separator="\n")
    return soup.get_text(separator="\n")


def _extract_metadata(html: str) -> dict[str, str | None]:
    soup = BeautifulSoup(html, "lxml")
    meta: dict[str, str | None] = {"title": None, "company": None, "location": None}

    if og_title := soup.find("meta", property="og:title"):
        meta["title"] = (og_title.get("content") or "").strip() or None
    elif soup.title and soup.title.string:
        meta["title"] = soup.title.string.strip()

    if og_site := soup.find("meta", property="og:site_name"):
        meta["company"] = (og_site.get("content") or "").strip() or None

    # schema.org JobPosting is the most reliable source when present.
    import json

    for script in soup.find_all("script", type="application/ld+json"):
        try:
            payload = json.loads(script.string or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        candidates = payload if isinstance(payload, list) else [payload]
        for item in candidates:
            if not isinstance(item, dict) or item.get("@type") != "JobPosting":
                continue
            meta["title"] = item.get("title") or meta["title"]
            org = item.get("hiringOrganization")
            if isinstance(org, dict):
                meta["company"] = org.get("name") or meta["company"]
            loc = item.get("jobLocation")
            if isinstance(loc, list) and loc:
                loc = loc[0]
            if isinstance(loc, dict):
                address = loc.get("address")
                if isinstance(address, dict):
                    parts = [
                        address.get("addressLocality"),
                        address.get("addressRegion"),
                        address.get("addressCountry"),
                    ]
                    joined = ", ".join(p for p in parts if isinstance(p, str) and p)
                    meta["location"] = joined or meta["location"]
    return meta


def _read_capped(response: httpx.Response, limit: int) -> bytes:
    """Read a streamed body, aborting as soon as it exceeds ``limit``.

    Checking ``len(response.content)`` after the fact (as this once did) means
    the whole page is already in memory before it is rejected - a hostile or
    merely broken URL could stream gigabytes at a worker first.
    """
    chunks: list[bytes] = []
    total = 0
    for chunk in response.iter_bytes():
        total += len(chunk)
        if total > limit:
            raise ScrapeError("The job posting page is unexpectedly large.")
        chunks.append(chunk)
    return b"".join(chunks)


def scrape_job(url: str, *, timeout: int | None = None) -> ScrapeResult:
    """Fetch ``url`` and return the cleaned posting text plus any metadata."""
    safe_url = validate_url(url)
    timeout = timeout or settings.scrape_timeout_seconds

    headers = {
        "User-Agent": settings.scrape_user_agent,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    try:
        with httpx.Client(
            timeout=timeout,
            follow_redirects=False,
            headers=headers,
        ) as client:
            current = safe_url
            response: httpx.Response | None = None
            # Redirects are followed manually so each hop is re-validated; a
            # public host can otherwise redirect into the private network.
            # Streamed so headers can be inspected, and the size cap enforced,
            # before the body is pulled into memory.
            for _ in range(5):
                response = client.send(client.build_request("GET", current), stream=True)
                # Checked on every hop, not just the first: a redirect chain is
                # exactly where a rebind would be aimed.
                try:
                    _assert_peer_allowed(response)
                except ScrapeError:
                    response.close()
                    raise
                if not response.is_redirect:
                    break
                response.close()
                location = response.headers.get("location")
                if not location:
                    response = None
                    break
                current = validate_url(str(response.url.join(location)))
            else:
                if response is not None:
                    response.close()
                raise ScrapeError("Too many redirects while fetching the job posting.")

            if response is None:
                raise ScrapeError("That URL redirected somewhere we could not follow.")

            try:
                response.raise_for_status()

                content_type = response.headers.get("content-type", "")
                if "html" not in content_type and "text" not in content_type:
                    raise ScrapeError(
                        f"Expected an HTML page but the server returned {content_type!r}."
                    )

                body = _read_capped(response, settings.scrape_max_bytes)
            finally:
                response.close()

            html = body.decode(response.charset_encoding or "utf-8", errors="replace")
            final_url = str(response.url)

    except httpx.HTTPStatusError as exc:
        status = exc.response.status_code
        if status in (401, 403):
            raise ScrapeError(
                "This job board blocks automated access. Paste the job description "
                "text directly instead."
            ) from exc
        if status == 404:
            raise ScrapeError("That job posting no longer exists (404).") from exc
        raise ScrapeError(f"The job site returned HTTP {status}.") from exc
    except httpx.TimeoutException as exc:
        raise ScrapeError(f"The job site did not respond within {timeout}s.") from exc
    except httpx.HTTPError as exc:
        raise ScrapeError(f"Could not reach the job posting: {exc}") from exc

    extracted = _extract_with_trafilatura(html, final_url) or _extract_with_soup(html)
    text = clean_text(extracted or "")

    if len(text) < 120:
        raise ScrapeError(
            "Could not extract a usable job description from that page - it is "
            "likely rendered by JavaScript or behind a login. Paste the text "
            "directly instead."
        )

    truncated = len(text) > MAX_TEXT_CHARS
    if truncated:
        text = text[:MAX_TEXT_CHARS]

    meta = _extract_metadata(html)
    logger.info(
        "scraper.success",
        url=final_url,
        chars=len(text),
        truncated=truncated,
        source=detect_source(final_url),
    )

    return ScrapeResult(
        url=final_url,
        source=detect_source(final_url),
        title=meta["title"],
        company=meta["company"],
        location=meta["location"],
        text=text,
        truncated=truncated,
    )


def from_pasted_text(text: str, *, title: str | None = None, company: str | None = None) -> ScrapeResult:
    """Build a ScrapeResult from text the user pasted, bypassing the network."""
    cleaned = clean_text(text or "")
    if len(cleaned) < 80:
        raise ScrapeError("That job description is too short to tailor against.")
    truncated = len(cleaned) > MAX_TEXT_CHARS
    return ScrapeResult(
        url=None,
        source="pasted",
        title=title,
        company=company,
        location=None,
        text=cleaned[:MAX_TEXT_CHARS],
        truncated=truncated,
    )
