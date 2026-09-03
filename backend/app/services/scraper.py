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

import html as _html
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
_SPACE_BEFORE_PUNCT = re.compile(r"[ \t]+([:;,.!?)\]])")

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
    # Joining inline markup inserts a space that the rendered HTML never had —
    # "<strong>Evals for design</strong>: Building…" comes back as
    # "Evals for design : Building…". Nothing in English wants a space before
    # its punctuation, so close it up.
    return _SPACE_BEFORE_PUNCT.sub(r"\1", text)


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


def _decode_body(body: bytes, declared: str | None) -> str:
    """Decode a response body using its declared charset, tolerating nonsense.

    The charset comes from a header on a page we do not control, so it can name
    a codec Python has never heard of - ``bytes.decode`` raises LookupError for
    those, which is not something any caller here expects. httpx's ``.text``
    absorbed that for us; decoding by hand means handling it by hand. Fall back
    to UTF-8, which is right far more often than not, and let ``errors=replace``
    deal with whatever doesn't fit.
    """
    for encoding in (declared, "utf-8"):
        if not encoding:
            continue
        try:
            return body.decode(encoding, errors="replace")
        except LookupError:
            logger.info("scraper.unknown_charset", declared=encoding)
    return body.decode("utf-8", errors="replace")


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


# --- ATS public APIs --------------------------------------------------------
# Ashby, Greenhouse, and Lever render the posting client-side, so the HTML a
# server fetches is an empty shell — trafilatura and BeautifulSoup both come
# back with nothing. But each exposes a public JSON API that returns the full
# description keyed off the org + posting id already in the URL. Recognising
# these turns "tailor from URL" from a dead end into the common case, since job
# aggregators (Simplify et al.) mostly link to exactly these boards.

_ASHBY_RE = re.compile(r"ashbyhq\.com/([^/?#]+)/([0-9a-f-]{36})", re.IGNORECASE)
_LEVER_RE = re.compile(r"lever\.co/([^/?#]+)/([0-9a-f-]{36})", re.IGNORECASE)
_GREENHOUSE_RE = re.compile(r"greenhouse\.io/(?:embed/job_app\?for=)?([^/?#]+).*?(?:/jobs/|token=)(\d+)", re.IGNORECASE)

# Oracle's hosted candidate experience — every employer on Oracle HCM, on a
# per-tenant subdomain. The page is a JavaScript shell that fetches this same
# posting from a REST path, so scraping the HTML gets a spinner while asking
# the API gets the posting. 104 rows of the current feed sit behind it, and
# they are 104 rows the degree and visa filters cannot judge.
_ORACLE_RE = re.compile(
    r"https://([^/]+\.oraclecloud\.com)/hcmUI/CandidateExperience/"
    r"(?:[a-z]{2}/)?sites/([^/]+)/(?:jobs/)?job/(\d+)",
    re.IGNORECASE,
)
# Workday serves the posting from a "cxs" JSON endpoint; the public page is a JS
# shell. The optional locale segment ("/en-US/") is not part of the site id.
_WORKDAY_RE = re.compile(
    r"https://([^./]+)\.([^./]+)\.myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?([^/]+)(/job/[^?#]+)",
    re.IGNORECASE,
)
_SMARTRECRUITERS_RE = re.compile(
    r"jobs\.smartrecruiters\.com/(?:[^/]+/)??([^/?#]+)/(\d+)", re.IGNORECASE
)


def _html_to_text(fragment: str) -> str:
    """Plain text from an HTML fragment (the ATS APIs return escaped HTML).

    List items and headings keep a lightweight marker ("• ", "## ") rather than
    being flattened into anonymous lines. Postings are mostly headed sections and
    bullets, and a bare ``get_text`` throws that away — leaving the reader one
    undifferentiated wall of text with responsibilities and requirements running
    together. The markers survive ``clean_text`` and let the UI lay the posting
    back out.
    """
    soup = BeautifulSoup(_html.unescape(fragment or ""), "html.parser")
    for tag in soup.find_all("br"):
        tag.replace_with("\n")
    # Assigning .string collapses each item to a single line, so nested inline
    # markup (<strong>, <a>, <span>) can't split one bullet across several.
    for li in soup.find_all("li"):
        if (item := li.get_text(" ", strip=True)):
            li.string = f"• {item}"
    for heading in soup.find_all(["h1", "h2", "h3", "h4", "h5", "h6"]):
        if (head := heading.get_text(" ", strip=True)):
            heading.string = f"## {head}"
    return clean_text(soup.get_text(separator="\n"))


def _ats_api_result(url: str, *, timeout: int) -> ScrapeResult | None:
    """Fetch a posting from a known ATS's public API, or None if not one.

    The request goes to the ATS's fixed public API host (not a user-controlled
    host), so it needs no SSRF revalidation. A failure returns None so the caller
    falls back to normal HTML scraping.
    """
    host = (urlparse(url).hostname or "").lower()
    try:
        if (m := _ASHBY_RE.search(url)) and host.endswith("ashbyhq.com"):
            org, pid = m.group(1), m.group(2)
            data = httpx.get(
                f"https://api.ashbyhq.com/posting-api/job-board/{org}",
                params={"includeCompensation": "true"}, timeout=timeout,
            ).json()
            job = next((j for j in data.get("jobs", []) if j.get("id") == pid), None)
            if job:
                text = clean_text(job.get("descriptionPlain") or "") or _html_to_text(
                    job.get("descriptionHtml") or ""
                )
                return _ats_result(url, text, job.get("title"), org, job.get("location"))

        elif (m := _LEVER_RE.search(url)) and host.endswith("lever.co"):
            org, pid = m.group(1), m.group(2)
            job = httpx.get(f"https://api.lever.co/v0/postings/{org}/{pid}", timeout=timeout).json()
            parts = [job.get("descriptionPlain") or _html_to_text(job.get("description") or "")]
            for section in job.get("lists", []):
                parts.append(_html_to_text(f"{section.get('text','')}<br>{section.get('content','')}"))
            loc = (job.get("categories") or {}).get("location")
            return _ats_result(url, clean_text("\n\n".join(p for p in parts if p)),
                               job.get("text"), org, loc)

        elif (m := _WORKDAY_RE.match(url)) and host.endswith("myworkdayjobs.com"):
            tenant, cell, site, path = m.groups()
            data = httpx.get(
                f"https://{tenant}.{cell}.myworkdayjobs.com/wday/cxs/{tenant}/{site}{path}",
                headers={"Accept": "application/json"}, timeout=timeout,
            ).json()
            info = (data or {}).get("jobPostingInfo") or {}
            loc = info.get("location") or ""
            if info.get("additionalLocations"):
                loc = "; ".join([loc, *info["additionalLocations"]]).strip("; ")
            return _ats_result(url, _html_to_text(info.get("jobDescription") or ""),
                               info.get("title"), tenant, loc)

        elif (m := _SMARTRECRUITERS_RE.search(url)) and host.endswith("smartrecruiters.com"):
            org, pid = m.group(1), m.group(2)
            job = httpx.get(
                f"https://api.smartrecruiters.com/v1/companies/{org}/postings/{pid}",
                timeout=timeout,
            ).json()
            sections = ((job.get("jobAd") or {}).get("sections") or {})
            parts = []
            for key in ("companyDescription", "jobDescription", "qualifications",
                        "additionalInformation"):
                block = sections.get(key) or {}
                body = _html_to_text(block.get("text") or "")
                if body:
                    parts.append(f"{block.get('title') or ''}\n{body}".strip())
            loc = (job.get("location") or {})
            where = ", ".join(x for x in (loc.get("city"), loc.get("region"),
                                          loc.get("country")) if x)
            return _ats_result(url, clean_text("\n\n".join(parts)),
                               job.get("name"), org, where)

        elif (m := _ORACLE_RE.match(url)) and host.endswith("oraclecloud.com"):
            tenant, site, pid = m.group(1), m.group(2), m.group(3)
            job = httpx.get(
                f"https://{tenant}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails"
                f'?expand=all&finder=ById;Id="{pid}",siteNumber="{site}"',
                timeout=timeout,
                headers={"User-Agent": settings.scrape_user_agent},
            ).json()
            items = job.get("items") or []
            if not items:
                return None
            item = items[0]
            # The description and the qualifications are separate fields and
            # the qualifications are the half that says who may apply, so a
            # scrape that took only the description would miss the degree.
            body = "\n\n".join(
                _html_to_text(item.get(key) or "")
                for key in ("ExternalDescriptionStr", "ExternalQualificationsStr")
            )
            where = "; ".join(
                loc.get("Name") or "" for loc in (item.get("requisitionLocation") or [])
            ).strip("; ") or item.get("PrimaryLocation")
            # No company name in the payload leaves the tenant subdomain, which
            # is an opaque code ("egug" for American Express) and worse than
            # nothing — an empty string lets the caller keep the name it has.
            return _ats_result(url, clean_text(body), item.get("Title"),
                               item.get("CompanyName") or "", where)

        elif (m := _GREENHOUSE_RE.search(url)) and host.endswith("greenhouse.io"):
            org, pid = m.group(1), m.group(2)
            job = httpx.get(
                f"https://boards-api.greenhouse.io/v1/boards/{org}/jobs/{pid}", timeout=timeout
            ).json()
            loc = (job.get("location") or {}).get("name")
            return _ats_result(url, _html_to_text(job.get("content") or ""),
                               job.get("title"), org, loc)
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        logger.info("scraper.ats_api_failed", host=host, error=str(exc)[:200])
    return None


def _ats_result(
    url: str, text: str, title: str | None, org: str, location: str | None
) -> ScrapeResult | None:
    """Wrap ATS-API text as a ScrapeResult, or None if it came back too thin."""
    if len(text) < 120:
        return None
    truncated = len(text) > MAX_TEXT_CHARS
    logger.info("scraper.ats_api_success", url=url, chars=len(text), source=detect_source(url))
    return ScrapeResult(
        url=url, source=detect_source(url), title=title,
        company=org.replace("-", " ").title() if org else None,
        location=location, text=text[:MAX_TEXT_CHARS], truncated=truncated,
    )


# A posting that no longer exists / a JS shell often still returns a 200 page with
# enough chrome text to clear a naive length check. Catch those so we never tailor
# against a dead link or a "please enable JavaScript" stub.
_CLOSED_MARKERS: tuple[str, ...] = (
    "no longer available", "no longer accepting", "no longer active",
    "position has been filled", "this position is closed", "this job is closed",
    "posting has expired", "posting is closed", "job not found", "page not found",
    "has been removed", "we couldn't find", "we could not find",
    "job you are looking for", "this role is no longer",
)
_JS_MARKERS: tuple[str, ...] = (
    "enable javascript", "requires javascript", "please enable javascript",
    "javascript is required", "javascript to run this app",
)


def _reject_reason(text: str) -> str | None:
    """Return why ``text`` isn't a usable job description, or None if it looks real.

    A real posting is a few hundred words; a dead/expired link or a JS shell is a
    short page dominated by navigation and a "not found"/"closed" notice.
    """
    low = text.lower()
    words = len(text.split())
    if any(m in low for m in _JS_MARKERS):
        return "the page needs JavaScript to load its content"
    if words < 50:
        return "the page didn't contain a readable job description"
    if words < 250 and any(m in low for m in _CLOSED_MARKERS):
        return "this posting appears to be closed or expired"
    return None


def scrape_job(url: str, *, timeout: int | None = None) -> ScrapeResult:
    """Fetch ``url`` and return the cleaned posting text plus any metadata."""
    safe_url = validate_url(url)
    timeout = timeout or settings.scrape_timeout_seconds

    # Fast path: a known ATS (Ashby/Greenhouse/Lever) serves its posting via a
    # public JSON API — the HTML would be an empty JS shell.
    if (ats := _ats_api_result(safe_url, timeout=timeout)) is not None:
        return ats

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
                # The final hop was already closed inside the loop.
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

            html = _decode_body(body, response.charset_encoding)
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

    reject = _reject_reason(text)
    if reject:
        # A redirect may have landed on an ATS (e.g. a Simplify link resolving to
        # jobs.ashbyhq.com) whose HTML is an empty shell — try its API first.
        if final_url != safe_url and (ats := _ats_api_result(final_url, timeout=timeout)):
            return ats
        raise ScrapeError(
            f"We couldn't read a usable job description from that link — {reject}. "
            "Open the posting to check it's still live, or paste the job description "
            "text here instead."
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
