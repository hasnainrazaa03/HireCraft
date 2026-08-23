"""Thin requests wrapper: shared session, browser-ish UA, retries, timeouts."""
from __future__ import annotations

import logging
import time
from typing import Any

import requests

log = logging.getLogger("jobscraper.http")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 jobscraper/0.1")

_session = requests.Session()
_session.headers.update({"User-Agent": UA, "Accept": "application/json, text/html;q=0.9"})


def request(method: str, url: str, *, retries: int = 2, timeout: int = 25,
            ok_statuses=(200,), **kw) -> requests.Response | None:
    last_err: Any = None
    for attempt in range(retries + 1):
        try:
            r = _session.request(method, url, timeout=timeout, **kw)
            if r.status_code in ok_statuses:
                return r
            if r.status_code in (404, 401, 403, 422):
                log.debug("%s %s -> %s (not retrying)", method, url, r.status_code)
                return None
            last_err = f"HTTP {r.status_code}"
        except requests.RequestException as e:  # network / timeout
            last_err = e
        time.sleep(0.8 * (attempt + 1))
    log.warning("%s %s failed: %s", method, url, last_err)
    return None


def get_json(url: str, **kw):
    r = request("GET", url, **kw)
    if r is None:
        return None
    try:
        return r.json()
    except ValueError:
        log.warning("non-JSON response from %s", url)
        return None


def post_json(url: str, payload: dict, **kw):
    r = request("POST", url, json=payload,
                headers={"Content-Type": "application/json"}, **kw)
    if r is None:
        return None
    try:
        return r.json()
    except ValueError:
        return None
