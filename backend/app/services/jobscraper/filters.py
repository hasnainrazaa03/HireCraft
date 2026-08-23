"""Hard filters: role relevance, level, term/season, experience, sponsorship, location.
Each function annotates the Job (flags / level / dropped). `apply_filters` runs them all."""
from __future__ import annotations

import re
from typing import Iterable

from .models import Job

# ---- level detection -------------------------------------------------------
INTERN_RE = re.compile(r"\b(intern|interns|internship|internships|co-?op|summer analyst|summer 20\d\d|"
                       r"fall 20\d\d|spring 20\d\d|winter 20\d\d)\b", re.I)
INTERN_WORD_RE = re.compile(r"\b(internships?|(?:interns?|co-?op)(?!\s+(?:experience|background|work)))\b", re.I)
NEWGRAD_RE = re.compile(r"\b(new ?grads?|new graduates?|(?:new\s+)?college\s+grad(?:uate)?s?|entry[- ]level|early[- ]career|university grad(uate)?|"
                        r"recent grad(uate)?|campus|associate|junior|jr\.?|graduate (software|engineer|program|scheme)|"
                        r"engineer\s*(i|1)|rotational|class of 20\d\d|20\d\d grad(uate)?s?|"
                        r"(software|ml|machine learning|data|ai) engineer,? (20\d\d|early))\b", re.I)
SENIOR_RE = re.compile(r"\b(senior|sr\.?|staff|principal|lead|director|manager|head|vp|vice president|"
                       r"architect|distinguished|fellow|chief|executive|partner|"
                       r"engineer\s*(ii|iii|iv|v|[2-6]))\b", re.I)
# "Tech Lead" is senior; "Lead" inside e.g. "Lead Generation" would be excluded anyway by role words.

TERM_RE = re.compile(r"\b(summer|fall|autumn|spring|winter)\s*[-']?\s*(20\d\d)\b", re.I)
TERM_RE2 = re.compile(r"\b(20\d\d)\s*(summer|fall|autumn|spring|winter)\b", re.I)
YEAR_START_RE = re.compile(r"\b(20\d\d)\s*(?:start|grad(?:uate)?s?|cohort|program)\b|"
                           r"\b(?:start(?:ing)?\s*(?:in\s*)?|grad(?:uate)?s?\s*[-:]?\s*)(20\d\d)\b", re.I)

YEARS_RE = re.compile(
    r"(?:minimum of\s*|at least\s*|min\.?\s*)?(\d{1,2})\s*(?:\+|or more|plus)?\s*(?:-|to|–)?\s*(\d{1,2})?\s*\+?\s*"
    r"years?['’]?\s*(?:of\s+)?(?:(?:relevant|professional|industry|hands-on|full-time|proven|prior|work(?:ing)?|"
    r"software|engineering|ml|related|commercial|practical|recent|direct|applicable)\s+)*"
    r"(?:experience|exp\b)", re.I)

PART_TIME_RE = re.compile(r"\bpart[- ]time\b|\b(?:10|15|20|25)\s*(?:-\s*\d\d\s*)?(?:hours|hrs)\s*(?:per|a|/)\s*week", re.I)
FULL_TIME_HOURS_RE = re.compile(r"\b40\s*(?:hours|hrs)\s*(?:per|a|/)\s*week\b|\bfull[- ]time\s+(?:hours|commitment|internship|co-?op)\b", re.I)

NO_SPONSOR_RE = re.compile(
    r"(not\s+(?:be\s+)?(?:able|willing|eligible)\s+to\s+(?:offer\s+|provide\s+)?(?:visa\s+)?sponsor|"
    r"without\s+(?:the\s+need\s+for\s+|requiring\s+|current\s+or\s+future\s+)?(?:visa\s+)?sponsorship|"
    r"no\s+(?:visa\s+)?sponsorship|will\s+not\s+(?:now\s+or\s+in\s+the\s+future\s+)?sponsor|"
    r"unable\s+to\s+sponsor|cannot\s+sponsor|can\s*not\s+sponsor|does\s+not\s+(?:offer\s+|provide\s+)?sponsor|"
    r"not\s+(?:currently\s+)?sponsoring|sponsorship\s+is\s+not\s+available|"
    r"must\s+be\s+(?:legally\s+)?authori[sz]ed\s+to\s+work[^.]{0,60}without\s+sponsorship)", re.I)
CITIZEN_RE = re.compile(
    r"(u\.?s\.?\s+citizen(?:ship)?\s+(?:is\s+)?required|must\s+be\s+(?:a\s+)?u\.?s\.?\s+citizen|"
    r"u\.?s\.?\s+citizens?\s+only|(?:active\s+)?(?:security\s+)?clearance\s+(?:is\s+)?required|"
    r"must\s+(?:be\s+able\s+to\s+)?(?:obtain|hold|possess)\s+(?:and\s+maintain\s+)?(?:a\s+|an\s+)?"
    r"(?:active\s+|ts/sci|top\s+secret|secret|dod|security)\s*clearance|"
    r"\bitar\b[^.]{0,80}(?:u\.?s\.?\s+person|citizen)|u\.?s\.?\s+person(?:s)?\s+(?:status\s+)?(?:is\s+)?required)", re.I)

US_STATES = ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC "
             "ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC").split()
US_STATE_NAMES = ["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware",
                  "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana",
                  "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana",
                  "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "north carolina", "north dakota",
                  "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota",
                  "tennessee", "texas", "utah", "vermont", "virginia", "wisconsin", "wyoming", "district of columbia"]
US_MARKERS = [r"\bunited states\b", r"\busa?\b", r"\bu\.s\.", r"\bamericas?\b", r"\bnationwide\b"]
REMOTE_RE = re.compile(r"\bremote\b|\bwork from home\b|\bwfh\b", re.I)
US_CITIES = ["los angeles", "san francisco", "new york", "seattle", "austin", "boston", "chicago", "mountain view",
             "palo alto", "sunnyvale", "san jose", "menlo park", "redmond", "bellevue", "denver", "atlanta",
             "santa monica", "irvine", "san diego", "cupertino", "santa clara", "pittsburgh", "washington",
             "bay area", "nyc", "sf", "dallas", "houston", "phoenix", "portland", "miami", "philadelphia",
             "cambridge, ma", "minneapolis", "raleigh", "durham", "salt lake", "boulder", "san mateo",
             "redwood city", "foster city", "oakland", "berkeley", "pasadena", "el segundo", "hawthorne",
             "playa vista", "culver city", "burbank", "glendale", "long beach", "reston", "arlington",
             "mclean", "herndon", "madison", "ann arbor", "columbus", "nashville", "charlotte", "tampa",
             "orlando", "detroit", "st. louis", "kansas city", "las vegas", "san antonio", "fremont",
             "brooklyn", "jersey city", "stamford", "hartford", "providence", "new haven", "princeton"]
NON_US = ["canada", "toronto", "vancouver", "montreal", "montréal", "ottawa", "waterloo", "calgary", "ontario",
          "quebec", "québec", "british columbia", "united kingdom", "london", "uk", "u.k.", "england", "wales", "bracknell", "norwich", "cheltenham", "birmingham", "crewe", "newcastle", "bristol", "leeds", "glasgow", "belfast", "oxford", "reading, uk", "europe", "serbia", "belgrade", "croatia", "zagreb", "slovakia", "slovenia", "bulgaria", "sofia", "cyprus", "malta", "iceland", "pakistan", "bangladesh", "sri lanka", "lahore", "karachi", "dhaka", "scotland",
          "edinburgh", "manchester", "cambridge, uk", "india", "bengaluru", "bangalore", "hyderabad", "pune", "mumbai",
          "chennai", "gurgaon", "gurugram", "noida", "delhi", "germany", "berlin", "munich", "münchen", "france",
          "paris", "netherlands", "amsterdam", "singapore", "australia", "sydney", "melbourne", "japan", "tokyo",
          "israel", "tel aviv", "ireland", "dublin", "poland", "warsaw", "krakow", "spain", "madrid", "barcelona",
          "switzerland", "zurich", "zürich", "sweden", "stockholm", "denmark", "copenhagen", "norway", "oslo",
          "finland", "helsinki", "italy", "milan", "portugal", "lisbon", "brazil", "são paulo", "sao paulo",
          "mexico", "mexico city", "argentina", "buenos aires", "china", "beijing", "shanghai", "shenzhen",
          "hong kong", "taiwan", "taipei", "korea", "seoul", "philippines", "manila", "vietnam", "indonesia",
          "malaysia", "thailand", "bangkok", "uae", "dubai", "abu dhabi", "saudi", "riyadh", "egypt", "nigeria",
          "kenya", "south africa", "new zealand", "auckland", "austria", "vienna", "belgium", "brussels",
          "czech", "prague", "hungary", "budapest", "romania", "bucharest", "ukraine", "kyiv", "turkey",
          "istanbul", "greece", "athens", "estonia", "tallinn", "latvia", "lithuania", "luxembourg",
          "colombia", "bogota", "chile", "santiago", "peru", "lima", "costa rica", "emea", "apac", "latam"]
_NON_US_RE = re.compile("|".join(rf"\b{re.escape(p)}\b" for p in NON_US), re.I)
_US_CITY_RE = re.compile("|".join(rf"\b{re.escape(c)}\b" for c in US_CITIES + US_STATE_NAMES), re.I)
_US_STATE_RE = re.compile(r"(?:,\s*|\b)(" + "|".join(US_STATES) + r")\b(?![a-z])")
_US_MARK_RE = re.compile("|".join(US_MARKERS), re.I)


def _kw_re(words: Iterable[str]) -> re.Pattern:
    parts = []
    for w in words:
        w = str(w)
        if w.startswith(" ") or w.endswith(" "):
            parts.append(re.escape(w))       # caller asked for literal spacing (" ml")
        elif w.endswith("*"):                # prefix match: "data scien*" hits scientist/science
            parts.append(r"(?<![a-z0-9])" + re.escape(w[:-1]))
        else:
            parts.append(r"(?<![a-z0-9])" + re.escape(w) + r"(?![a-z0-9])")
    return re.compile("|".join(parts), re.I)


class Filters:
    def __init__(self, profile: dict):
        self.p = profile
        role = profile.get("role", {})
        self.role_inc = _kw_re(role.get("include", []))
        self.role_exc = _kw_re(role.get("exclude", []))
        self.levels = set(profile.get("levels", ["intern", "new_grad"]))
        self.target_terms = {t.lower() for t in profile.get("target_terms", [])}
        self.max_years = int(profile.get("max_years_experience", 3))
        self.keep_unknown = bool(profile.get("keep_unknown_level", False))
        self.grad_year = int(profile.get("graduation_year", 2027))
        self.buckets = profile.get("buckets") or {}
        self.bucket_order = [t for t in profile.get("target_terms", []) if t in self.buckets]
        self.needs_sponsor = bool(profile.get("requires_sponsorship", True))
        self.sponsor_policy = profile.get("sponsorship_policy", "flag")
        loc = profile.get("location", {})
        self.us_only = bool(loc.get("us_only", True))
        self.prefer_re = _kw_re(loc.get("prefer", [])) if loc.get("prefer") else None

    # ---- individual checks -------------------------------------------------
    def role_ok(self, job: Job) -> bool:
        t = f" {job.title} "
        if self.role_exc.search(t):
            return False
        return bool(self.role_inc.search(t))

    def detect_level(self, job: Job) -> str:
        t = f" {job.title} "
        if SENIOR_RE.search(t):
            return "senior"
        if INTERN_RE.search(t):
            return "intern"
        if NEWGRAD_RE.search(t):
            return "new_grad"
        head = job.description[:1500]
        if INTERN_WORD_RE.search(head):
            return "intern"
        if NEWGRAD_RE.search(head):
            return "new_grad"
        return "unknown"

    def detect_terms(self, job: Job) -> list[str]:
        terms = {t for t in job.terms if t and t.upper() != "N/A"}
        for src in (job.title, job.description[:1500]):
            for m in TERM_RE.finditer(src):
                terms.add(f"{m.group(1).title()} {m.group(2)}")
            for m in TERM_RE2.finditer(src):
                terms.add(f"{m.group(2).title()} {m.group(1)}")
        for m in YEAR_START_RE.finditer(job.title):
            terms.add(m.group(1) or m.group(2))   # bare year, e.g. "2026" from "2026 Start"
        return sorted({t.replace("Autumn", "Fall") for t in terms})

    def term_ok(self, term: str, level: str = "intern") -> bool:
        t = term.lower()
        if t in self.target_terms:
            return True
        if re.fullmatch(r"20\d\d", t):       # bare year ("2026 Start", "College Grad 2026")
            if level == "intern":            # accept if any target term falls in that year
                return any(tt.endswith(t) for tt in self.target_terms)
            return int(t) >= self.grad_year  # new-grad cohorts before you graduate are out
        return False

    def min_years(self, job: Job):
        yrs = []
        for m in YEARS_RE.finditer(job.description):
            try:
                yrs.append(int(m.group(1)))
            except ValueError:
                pass
        yrs = [y for y in yrs if 0 < y <= 20]
        return min(yrs) if yrs else None

    def location_status(self, job: Job) -> str:
        """'us' | 'non-us' | 'unknown'"""
        loc = job.location or ""
        us_strong = bool(_US_MARK_RE.search(loc) or _US_CITY_RE.search(loc) or _US_STATE_RE.search(loc))
        non_us = bool(_NON_US_RE.search(loc))
        remote = bool(job.remote) or bool(REMOTE_RE.search(loc))
        if us_strong:
            return "us"             # includes multi-location postings that list a US site
        if non_us:
            return "non-us"         # "Remote in UK", "Canada", ...
        if remote:
            return "us"             # bare "Remote" with no country named
        return "unknown"

    # ---- pipeline ----------------------------------------------------------
    def apply(self, job: Job) -> Job:
        if not self.role_ok(job):
            job.dropped = "role"
            return job

        job.level = self.detect_level(job)
        job.terms = self.detect_terms(job)
        job.min_years = self.min_years(job)

        if job.level == "senior":
            job.dropped = "senior"
            return job
        if job.level == "unknown":
            if job.min_years is not None and job.min_years <= self.max_years:
                job.level = "early"
            elif job.min_years is not None:
                job.dropped = f"exp:{job.min_years}y"
                return job
            elif not self.keep_unknown:
                job.dropped = "level-unknown"
                return job
            else:
                job.flags.append("level?")
        if job.level not in self.levels and not (job.level == "early" and "new_grad" in self.levels):
            job.dropped = f"level:{job.level}"
            return job
        if job.min_years is not None and job.min_years > self.max_years and job.level != "intern":
            job.dropped = f"exp:{job.min_years}y"
            return job
        if job.min_years is not None and job.min_years > self.max_years:
            job.flags.append(f"exp:{job.min_years}y")

        if job.terms and self.target_terms and not any(self.term_ok(t, job.level) for t in job.terms):
            job.dropped = "term:" + ",".join(job.terms)
            return job

        # sponsorship / citizenship
        if CITIZEN_RE.search(job.description) or (job.sponsorship or "").lower().startswith("u.s. citizenship"):
            if self.needs_sponsor:
                job.dropped = "citizenship"
                return job
            job.flags.append("citizen-req")
        if NO_SPONSOR_RE.search(job.description) or (job.sponsorship or "").lower().startswith("does not"):
            if self.needs_sponsor and self.sponsor_policy == "exclude":
                job.dropped = "no-sponsorship"
                return job
            job.flags.append("no-sponsorship")
        elif (job.sponsorship or "").lower().startswith("offers"):
            job.flags.append("sponsors")

        loc = self.location_status(job)
        if loc == "non-us" and self.us_only:
            job.dropped = "location"
            return job
        if loc == "unknown":
            job.flags.append("loc?")
        if loc == "us" and ((self.prefer_re and self.prefer_re.search(job.location or "")) or job.remote):
            job.flags.append("loc+")
        if re.search(r"\bph\.?d\b", job.title, re.I) or re.search(
                r"\b(ph\.?d\s+(?:is\s+)?required|must\s+(?:be\s+)?(?:currently\s+)?(?:enrolled\s+in|pursuing)\s+a\s+ph\.?d|"
                r"ph\.?d\s+(?:students?|candidates?)\s+only|currently\s+pursuing\s+a\s+ph\.?d)", job.description, re.I):
            job.flags.append("phd")
        if not job.description:
            job.flags.append("no-desc")
        if PART_TIME_RE.search(job.text):
            job.flags.append("part-time")
        elif FULL_TIME_HOURS_RE.search(job.text):
            job.flags.append("full-time-hrs")
        job.bucket = self.bucket_for(job)
        return job

    def bucket_for(self, job: Job) -> str:
        if job.level in ("new_grad", "early"):
            return self.buckets.get("fulltime", "Full-time")
        for term in self.bucket_order:                 # priority = order in target_terms
            if any(t.lower() == term.lower() for t in job.terms):
                return self.buckets[term]
        return self.buckets.get("unspecified", "Internship")
