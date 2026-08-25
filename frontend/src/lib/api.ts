/**
 * API client.
 *
 * Tokens live in localStorage. A 401 triggers exactly one refresh attempt, and
 * concurrent 401s share that single attempt via `refreshPromise` - otherwise a
 * page with several parallel queries would fire a refresh per request and race
 * itself into a logout.
 */

const BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const API = `${BASE}/api/v1`;

const ACCESS_KEY = "hirecraft.access";
const REFRESH_KEY = "hirecraft.refresh";

export const tokens = {
  get access() {
    return localStorage.getItem(ACCESS_KEY);
  },
  get refresh() {
    return localStorage.getItem(REFRESH_KEY);
  },
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

/**
 * Is this JWT past its own expiry?
 *
 * Used to avoid firing a request we already know will 401. The check is a
 * convenience, never a security boundary — the server validates every token
 * regardless, and an unreadable or unsigned token is treated as expired.
 */
export function isExpired(jwt: string | null): boolean {
  if (!jwt) return true;
  try {
    const [, payload] = jwt.split(".");
    // base64url → base64, re-padded: JWTs strip "=" and atob rejects some
    // unpadded lengths. A throw here would report "expired" and sign the user
    // out on every reload, so the decode has to be exact.
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const { exp } = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    if (typeof exp !== "number") return false; // no expiry claim — let the server decide
    // A few seconds of slack for clock skew.
    return Date.now() / 1000 >= exp - 5;
  } catch {
    return true;
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public fieldErrors?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let refreshPromise: Promise<boolean> | null = null;

const REFRESH_LOCK = "hirecraft.refresh";

/**
 * Perform the actual rotation. Only ever runs one-at-a-time per browser (see
 * tryRefresh), and re-reads storage on entry because the tab that went first
 * has already written the new pair.
 */
async function rotate(staleAccess: string | null): Promise<boolean> {
  // Another tab refreshed while we were queued behind it. Its tokens are
  // already in localStorage, so there is nothing left to do — and crucially,
  // nothing to replay.
  if (tokens.access && tokens.access !== staleAccess) return true;

  const refresh = tokens.refresh;
  if (!refresh) return false;
  try {
    const res = await fetch(`${API}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    tokens.set(data.access_token, data.refresh_token);
    return true;
  } catch {
    return false;
  }
}

export async function tryRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  // Captured before we queue for the lock, so rotate() can tell whether someone
  // else refreshed while we waited.
  const staleAccess = tokens.access;

  refreshPromise = (async () => {
    try {
      // Refresh tokens are single-use and presenting a rotated one is treated
      // server-side as a replay, which revokes the whole session. Deduping
      // within a tab is not enough: two tabs of the same app would each present
      // the same token and sign the user out of both. A cross-tab lock
      // serializes it; whoever waits finds the new token already stored.
      return navigator.locks
        ? await navigator.locks.request(REFRESH_LOCK, () => rotate(staleAccess))
        : await rotate(staleAccess);
    } finally {
      // Clear on the next tick so callers awaiting this promise still see it.
      setTimeout(() => (refreshPromise = null), 0);
    }
  })();

  return refreshPromise;
}

/**
 * Turn a raw pydantic validation message into something a user should read:
 *  - "String should have at least 10 characters" (field "password") → "Password should have at least 10 characters."
 *  - "Value error, Maximum salary cannot be less than minimum salary" (field "body") → "Maximum salary cannot be less than minimum salary."
 *  - HttpUrl errors → "Portfolio URL must be a valid URL (e.g. https://example.com)."
 */
function humanizeFieldError(field: string, message: string): string {
  // "body" is a model-level (whole-request) error — it has no field label.
  const label =
    field && field !== "body"
      ? field.replace(/_/g, " ").replace(/\burl\b/gi, "URL")
      : "";
  // Pydantic prefixes model-validator errors with "Value error, " — drop it.
  let msg = message.replace(/^Value error,?\s*/i, "").trim();
  if (/valid URL/i.test(msg)) {
    msg = `${label || "This"} must be a valid URL (e.g. https://example.com)`;
  } else if (label && /^(String|Value|Input)\b/.test(msg)) {
    msg = msg.replace(/^(String|Value|Input)\b/, label);
  }
  msg = msg.charAt(0).toUpperCase() + msg.slice(1);
  return msg.replace(/[.!?]*$/, ".");
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  let fieldErrors: { field: string; message: string }[] | undefined;
  try {
    const body = await res.json();
    if (typeof body.detail === "string") message = body.detail;
    if (Array.isArray(body.errors)) {
      fieldErrors = body.errors;
    }
    // FastAPI's default 422 shape.
    if (Array.isArray(body.detail)) {
      fieldErrors = body.detail.map((d: { loc: string[]; msg: string }) => ({
        field: d.loc.slice(1).join("."),
        message: d.msg,
      }));
    }
    // Prefer a specific field error over the generic "Validation failed." — the
    // user needs to know *why* (e.g. "Password should have at least 10 characters.").
    if (fieldErrors && fieldErrors.length > 0) {
      message = fieldErrors
        .slice(0, 3)
        .map((e) => humanizeFieldError(e.field, e.message))
        .join(" ");
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(message, res.status, fieldErrors);
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const access = tokens.access;
  if (access) headers.set("Authorization", `Bearer ${access}`);

  const res = await fetch(`${API}${path}`, { ...options, headers });

  if (res.status === 401 && retry && tokens.refresh) {
    if (await tryRefresh()) return request<T>(path, options, false);
    tokens.clear();
    window.dispatchEvent(new Event("hirecraft:logout"));
    throw new ApiError("Your session expired. Please sign in again.", 401);
  }

  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** One page of a list endpoint, plus the unpaged total the server reports. */
async function page<T>(path: string): Promise<{ items: T[]; total: number | null }> {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  const access = tokens.access;
  if (access) headers.set("Authorization", `Bearer ${access}`);

  const res = await fetch(`${API}${path}`, { headers });
  if (res.status === 401 && tokens.refresh) {
    if (await tryRefresh()) return page<T>(path);
    tokens.clear();
    window.dispatchEvent(new Event("hirecraft:logout"));
    throw new ApiError("Your session expired. Please sign in again.", 401);
  }
  if (!res.ok) throw await parseError(res);

  const raw = res.headers.get("X-Total-Count");
  const total = raw === null ? null : Number(raw);
  return {
    items: (await res.json()) as T[],
    total: total === null || Number.isNaN(total) ? null : total,
  };
}

/**
 * Read every page of a list endpoint.
 *
 * Views that group or search across the whole collection — the Kanban board,
 * most obviously — are wrong if they only ever see the first page. Asking for
 * one big page instead just moves the cliff: the server caps `limit`, so the
 * request silently returns a prefix and the UI has no idea. Walk the pages
 * until the server's own total is satisfied, and report honestly when a hard
 * safety cap stops us early rather than pretending the rest doesn't exist.
 */
export async function fetchAll<T>(
  path: string,
  { pageSize = 200, cap = 2000 }: { pageSize?: number; cap?: number } = {},
): Promise<{ items: T[]; total: number; truncated: boolean }> {
  const join = path.includes("?") ? "&" : "?";
  const items: T[] = [];
  let total: number | null = null;

  while (items.length < cap) {
    const got = await page<T>(`${path}${join}limit=${pageSize}&offset=${items.length}`);
    if (total === null) total = got.total;
    items.push(...got.items);
    // A short page means the end, with or without a total header.
    if (got.items.length < pageSize) break;
    if (total !== null && items.length >= total) break;
  }

  const known = total ?? items.length;
  return { items, total: known, truncated: items.length < known };
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  /** Multipart file upload. Content-Type is left to the browser (boundary). */
  upload: <T>(path: string, file: File, field = "file") => {
    const form = new FormData();
    form.append(field, file);
    return request<T>(path, { method: "POST", body: form });
  },

  download: downloadFile,
  blob: fetchBlob,
  /** POST a JSON body and download the binary response as a file. */
  downloadPost: downloadPostFile,
};

/**
 * Downloads go through fetch directly rather than request<T>(), because the
 * response is a binary blob rather than JSON. That means the refresh-on-401
 * handling has to be repeated here: without it, an expired access token turns
 * "Download PDF" into a dead button after the TTL elapses, even though every
 * other call on the page silently refreshes and succeeds.
 */
/** Fetch a binary response with auth + one-shot refresh, returning the Blob. */
async function fetchBlob(path: string, retry = true): Promise<Blob> {
  // Artifacts (résumé/cover-letter PDFs) are regenerated in place, so never let
  // the browser cache serve a stale copy — the preview must reflect the latest.
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${tokens.access ?? ""}` },
    cache: "no-store",
  });
  if (res.status === 401 && retry && tokens.refresh) {
    if (await tryRefresh()) return fetchBlob(path, false);
    tokens.clear();
    window.dispatchEvent(new Event("hirecraft:logout"));
    throw new ApiError("Your session expired. Please sign in again.", 401);
  }
  if (!res.ok) throw await parseError(res);
  return res.blob();
}

async function downloadFile(
  path: string,
  fallbackName: string,
  retry = true,
): Promise<void> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${tokens.access ?? ""}` },
  });

  if (res.status === 401 && retry && tokens.refresh) {
    if (await tryRefresh()) return downloadFile(path, fallbackName, false);
    tokens.clear();
    window.dispatchEvent(new Event("hirecraft:logout"));
    throw new ApiError("Your session expired. Please sign in again.", 401);
  }

  if (!res.ok) throw await parseError(res);

  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^"';]+)"?/);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = match?.[1] ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function downloadPostFile(
  path: string,
  body: unknown,
  fallbackName: string,
  retry = true,
): Promise<void> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.access ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });

  if (res.status === 401 && retry && tokens.refresh) {
    if (await tryRefresh()) return downloadPostFile(path, body, fallbackName, false);
    tokens.clear();
    window.dispatchEvent(new Event("hirecraft:logout"));
    throw new ApiError("Your session expired. Please sign in again.", 401);
  }

  if (!res.ok) throw await parseError(res);

  const blob = await res.blob();
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^"';]+)"?/);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = match?.[1] ?? fallbackName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// --- Types mirroring the backend schemas ------------------------------------

export interface User {
  id: string;
  email: string;
  full_name: string | null;
  is_verified: boolean;
  is_superuser?: boolean;
  theme: "dark" | "light";
  notification_prefs: Record<string, boolean>;
  created_at: string;
}

export interface SessionInfo {
  id: string;
  user_agent: string | null;
  ip_address: string | null;
  last_used_at: string;
  created_at: string;
  current: boolean;
}

export interface ResumeProfileSummary {
  /** The file this résumé was imported from, if any. */
  source_filename?: string | null;
  id: string;
  name: string;
  is_default: boolean;
  tags: string[];
  template: string;
  one_page: boolean;
  current_version: number;
  label: string | null;
  updated_at: string;
}

export interface ResumeProfile extends ResumeProfileSummary {
  content: MasterResume;
  created_at: string;
}

export interface ResumeVersionSummary {
  id: string;
  version: number;
  label: string | null;
  created_at: string;
}

export type EvidenceKind =
  | "impact"
  | "scope"
  | "skill"
  | "achievement"
  | "context"
  | "other";

export interface EvidenceItem {
  id: string;
  kind: EvidenceKind;
  text: string;
  label: string | null;
  created_at: string;
  updated_at: string;
}

export interface CareerProfile {
  headline: string | null;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;
  github_url: string | null;
  portfolio_url: string | null;
  website_url: string | null;
  country: string | null;
  legal_first_name: string | null;
  legal_last_name: string | null;
  preferred_name: string | null;
  contact_email: string | null;
  work_authorization: string | null;
  visa_status: string | null;
  /** null means unanswered — the autofiller leaves the question blank. */
  authorized_to_work: boolean | null;
  requires_sponsorship: boolean | null;
  years_experience: number | null;
  preferred_roles: string[];
  preferred_industries: string[];
  preferred_locations: string[];
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
  salary_period: "hourly" | "weekly" | "monthly" | "yearly" | null;
  work_arrangement: "remote" | "hybrid" | "onsite" | "flexible" | null;
  open_to_relocation: boolean;
}

export interface VoiceProfile {
  tone: string;
  formality: string;
  sentence_style: string;
  vocabulary: string[];
  habits: string[];
  avoid: string[];
  summary: string;
}

export interface WritingSample {
  id: string;
  kind: "cover_letter" | "email" | "sop" | "other";
  title: string | null;
  content: string;
  created_at: string;
}

export interface WritingProfile {
  voice: VoiceProfile | null;
  analyzed_at: string | null;
  sample_count: number;
  samples: WritingSample[];
}

export interface ApiKeyStatus {
  configured: boolean;
  hint: string | null;
}

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
}

export interface ResumeParseResponse {
  /** Server-side stash of the uploaded file; pass to POST /resumes to keep it. */
  source_ref?: string | null;
  content: MasterResume;
  cost_usd: number;
  source_filename: string;
}

export interface GuardrailReport {
  violations: GuardrailViolation[];
  keywords_requested: string[];
  keywords_verified: string[];
  bullet_confidence?: BulletConfidence[];
  locks?: string[];
}

export interface ResumeRewriteResponse {
  content: MasterResume;
  diff: DiffEntry[];
  guardrail_report: GuardrailReport;
  score_before: number;
  score_after: number;
  cost_usd: number;
}

export interface ProfileIntroResponse {
  headline: string;
  summary: string;
  cost_usd: number;
}

export interface ScoreMetric {
  key: string;
  label: string;
  score: number;
  detail: string;
}

export interface Finding {
  category: string;
  severity: "good" | "info" | "warning" | "critical";
  title: string;
  detail: string;
  location: string | null;
}

export interface AtsCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ResumeAnalysis {
  overall_score: number;
  grade: "Excellent" | "Strong" | "Fair" | "Needs work";
  metrics: ScoreMetric[];
  findings: Finding[];
  ats_checks: AtsCheck[];
  ats_score: number;
  bullet_count: number;
  quantified_bullets: number;
  estimated_pages: number;
}

export type Confidence = "verified" | "likely" | "needs_review" | "blocked";

export interface BulletConfidence {
  entry_id: string | null;
  label: string;
  text: string;
  confidence: Confidence;
  reason: string;
  source: "resume" | "brag_bank";
}

export interface MasterResume {
  schema_version: string;
  basics: {
    name: string;
    email: string;
    phone?: string | null;
    location?: string | null;
    website?: string | null;
    linkedin?: string | null;
    github?: string | null;
    headline?: string | null;
    summary?: string | null;
  };
  experience: ResumeEntry[];
  education: ResumeEntry[];
  projects: ResumeEntry[];
  skills: { category: string; items: string[] }[];
  certifications: unknown[];
  awards: unknown[];
  publications: unknown[];
  section_order: string[];
}

export interface ResumeEntry {
  id: string;
  company?: string;
  institution?: string;
  name?: string;
  title?: string;
  degree?: string;
  start_date?: string | null;
  end_date?: string | null;
  highlights: string[];
  technologies?: string[];
}

export type PipelineStatus =
  | "pending"
  | "scraping"
  | "extracting"
  | "optimizing"
  | "rendering"
  | "completed"
  | "failed";

export type TrackerStatus =
  | "wishlist"
  | "saved"
  | "preparing"
  | "draft"
  | "applied"
  | "assessment"
  | "screening"
  | "interviewing"
  | "technical"
  | "behavioral"
  | "final"
  | "offer"
  | "accepted"
  | "rejected"
  | "ghosted"
  | "withdrawn"
  | "archived";

export interface ApplicationSummary {
  id: string;
  pipeline_status: PipelineStatus;
  tracker_status: TrackerStatus;
  job_title: string | null;
  company: string | null;
  total_cost_usd: number;
  applied_at: string | null;
  interview_at: string | null;
  reminder_at: string | null;
  has_notes: boolean;
  created_at: string;
  updated_at: string;
}

export interface GuardrailViolation {
  kind: string;
  severity: "error" | "warning";
  entry_id: string | null;
  field: string | null;
  detail: string;
  action: string;
}

export interface DiffEntry {
  section: string;
  entry_id: string | null;
  label: string;
  field: string;
  before: string | string[] | null;
  after: string | string[] | null;
  change: "added" | "removed" | "modified" | "reordered" | "unchanged";
}

export interface ScorecardMetric {
  key: string;
  label: string;
  score: number;
  detail: string;
  measured: boolean;
  delta: number | null;
}

export interface ScorecardSuggestion {
  key: string;
  title: string;
  detail: string;
  metric_key: string;
  keywords: string[];
  instruction: string;
}

export interface Scorecard {
  overall: number;
  overall_delta: number | null;
  metrics: ScorecardMetric[];
  suggestions: ScorecardSuggestion[];
}

export interface JobSignals {
  red_flags: string[];
  geo_mismatch: string | null;
  injection: string[];
  thin: boolean;
  word_count: number;
}

export interface NoteEntry {
  id: string;
  text: string;
  at: string;
  updated_at: string | null;
}

export interface QualityBullet {
  id: string;
  where: string;
  text: string;
  note: string;
}

export interface QualityInspect {
  keywords: string[];
  impact: QualityBullet[];
  verbs: QualityBullet[];
  conciseness: QualityBullet[];
}

export interface ApplicationDetail {
  id: string;
  resume_profile_id: string;
  pipeline_status: PipelineStatus;
  tracker_status: TrackerStatus;
  error_message: string | null;
  include_cover_letter: boolean;
  reach_mode: boolean;
  notes: string | null;
  interview_at: string | null;
  reminder_at: string | null;
  tailored_resume: MasterResume | null;
  diff: DiffEntry[] | null;
  guardrail_report: GuardrailReport | null;
  scorecard: Scorecard | null;
  job_signals: JobSignals | null;
  cover_letter: string[] | null;
  activity: { kind: string; label: string; at: string; meta: Record<string, unknown> }[];
  note_entries: NoteEntry[];
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  cost_breakdown: Record<string, { input_tokens: number; output_tokens: number; cost_usd: number }>;
  created_at: string;
  updated_at: string;
  job: {
    id: string;
    url: string | null;
    source: string | null;
    title: string | null;
    company: string | null;
    location: string | null;
    raw_text: string;
    requirements: JobRequirements | null;
    created_at: string;
  } | null;
  artifacts: { id: string; kind: string; size_bytes: number }[];
}

export interface JobRequirements {
  title: string | null;
  company: string | null;
  seniority: string;
  required_skills: { name: string; importance: number }[];
  preferred_skills: { name: string; importance: number }[];
  ats_keywords: string[];
  responsibilities: string[];
  qualifications: string[];
  min_years_experience: number | null;
}

export interface ApplicationStatus {
  id: string;
  pipeline_status: PipelineStatus;
  error_message: string | null;
  stage_message: string | null;
  has_pdf: boolean;
}

export interface UsageSummary {
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_calls: number;
  applications: number;
  average_cost_per_application: number;
  by_day: {
    date: string;
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
    calls: number;
  }[];
  by_purpose: Record<string, number>;
  by_model: ModelUsage[];
  by_provider: ProviderUsage[];
}

export interface ModelUsage {
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  calls: number;
}

export interface ProviderUsage {
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  calls: number;
}

export interface UsageEvent {
  at: string;
  purpose: string;
  label: string;
  category: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  succeeded: boolean;
}

export interface PurposeUsage {
  purpose: string;
  label: string;
  category: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface ApplicationUsage {
  call_count: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  by_model: ModelUsage[];
  by_purpose: PurposeUsage[];
  timeline: UsageEvent[];
}

export interface TrackerStats {
  counts: Record<string, number>;
  total: number;
}

export interface FunnelStats {
  total: number;
  submitted: number;
  active: number;
  applied: number;
  interviewing: number;
  offers: number;
  closed: number;
  response_rate: number;
  interview_rate: number;
  offer_rate: number;
}

export interface ContentStats {
  resume_count: number;
  resume_versions: number;
  tailored_resumes: number;
  cover_letters: number;
  avg_resume_score: number | null;
}

export interface NamedCount {
  name: string;
  count: number;
}

export interface TimePoint {
  date: string;
  count: number;
}

export interface ActivityItem {
  kind: "application" | "completed" | "offer" | "resume_version";
  title: string;
  subtitle: string | null;
  at: string;
  ref: string | null;
}

export interface AnalyticsOverview {
  funnel: FunnelStats;
  content: ContentStats;
  applications_over_time: TimePoint[];
  top_companies: NamedCount[];
  top_titles: NamedCount[];
  top_keywords: NamedCount[];
  best_resume: NamedCount | null;
  activity: ActivityItem[];
}

// --- Writing studio: cover letters + outreach -------------------------------

export interface ToneInfo {
  id: string;
  label: string;
  description: string;
}

export interface OutreachKindInfo {
  id: string;
  label: string;
  description: string;
}

export interface CoverLetterResult {
  paragraphs: string[];
  guardrail_report: GuardrailReport;
  tone: string;
  used_voice: boolean;
  cost_usd: number;
  greeting: string;
  signature: string;
}

export interface OutreachResult {
  kind: string;
  subject: string;
  body: string;
  used_voice: boolean;
  cost_usd: number;
  warnings: string[];
}

export interface SavedCoverLetterSummary {
  id: string;
  company: string | null;
  role: string | null;
  tone: string;
  used_voice: boolean;
  application_id: string | null;
  application_label: string | null;
  paragraph_count: number;
  updated_at: string;
}

export interface SavedCoverLetterDetail {
  id: string;
  company: string | null;
  role: string | null;
  hiring_manager: string | null;
  tone: string;
  used_voice: boolean;
  resume_profile_id: string | null;
  application_id: string | null;
  application_label: string | null;
  paragraphs: string[];
  job_text: string | null;
  guardrail_report: GuardrailReport | null;
  greeting: string;
  signature: string;
  created_at: string;
  updated_at: string;
}

// --- Company intelligence ---------------------------------------------------

export interface CompanyBrief {
  overview: string;
  industry: string | null;
  size_band: string | null;
  headquarters: string | null;
  known_for: string[];
  likely_tech_stack: string[];
  culture_signals: string[];
  recent_context: string[];
  interview_angles: string[];
  smart_questions: string[];
  watch_outs: string[];
  confidence: "high" | "medium" | "low";
  freshness_note: string;
}

export interface ContactGuidance {
  steps: string[];
  note: string;
}

export interface CompanyBriefResponse {
  company: string;
  role: string | null;
  brief: CompanyBrief;
  contact_guidance: ContactGuidance;
  used_grounding: boolean;
  cost_usd: number;
  disclaimer: string;
}

// --- Career insights: match + skill gaps ------------------------------------

export interface SubScore {
  key: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
}

export interface SkillHit {
  name: string;
  importance: number;
  have: boolean;
}

export interface JobMatch {
  overall_score: number;
  verdict: "Strong match" | "Good match" | "Fair match" | "Reach";
  subscores: SubScore[];
  matched_skills: SkillHit[];
  missing_skills: SkillHit[];
  matched_keywords: string[];
  missing_keywords: string[];
  strengths: string[];
  gaps: string[];
}

export interface SkillDemand {
  name: string;
  demand: number;
  avg_importance: number;
  have: boolean;
}

export interface SkillGapReport {
  jobs_analyzed: number;
  average_match: number | null;
  top_missing: SkillDemand[];
  high_demand: SkillDemand[];
  covered: SkillDemand[];
}

// --- Interview prep ---------------------------------------------------------

export type QuestionCategory =
  | "behavioral"
  | "technical"
  | "resume"
  | "project"
  | "company"
  | "system_design"
  | "coding"
  | "general";

export interface InterviewQuestion {
  category: QuestionCategory;
  question: string;
  why: string;
  tip: string;
}

export interface QuestionsResponse {
  questions: InterviewQuestion[];
  cost_usd: number;
  /** Persisted copies carrying the ids needed to draft/redraft an answer. */
  saved: SavedQuestion[];
}

export interface StarAnswer {
  situation: string;
  task: string;
  action: string;
  result: string;
}

export interface AnswerResponse {
  star: StarAnswer;
  used_voice: boolean;
  warnings: string[];
  cost_usd: number;
}

export interface SavedQuestion {
  id: string;
  category: QuestionCategory;
  question: string;
  why: string;
  tip: string;
  role: string | null;
  company: string | null;
  application_id: string | null;
  resume_profile_id: string | null;
  answer: StarAnswer | null;
  answer_warnings: string[];
  used_voice: boolean;
  order_index: number;
}

// --- Notifications ----------------------------------------------------------

export interface NotificationItem {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

export interface NotificationList {
  items: NotificationItem[];
  unread_count: number;
}

// --- Copilot ----------------------------------------------------------------

/** A previewed résumé revision — the diff and the proposed résumé, not yet saved. */
export interface AssistantProposal {
  note: string;
  diff: Record<string, unknown>[];
  proposed: Record<string, unknown>;
  blocked: string[];
}

export interface CopilotAction {
  kind: "revise_resume";
  instruction: string;
}

export interface CopilotResponse {
  reply: string;
  action?: CopilotAction | null;
  grounded_in: string[];
  cost_usd: number;
}

// --- Assistant + admin ------------------------------------------------------

export interface ResumeRanking {
  resume_profile_id: string;
  name: string;
  match_score: number;
  verdict: string;
}

export interface ResumeRecommendation {
  job_title: string | null;
  company: string | null;
  rankings: ResumeRanking[];
  best_resume_id: string | null;
  weak_areas: string[];
  missing_skills: string[];
}

export interface ResumeOutcome {
  resume_profile_id: string;
  name: string;
  applications: number;
  interviews: number;
  offers: number;
  response_rate: number;
}

export interface HistoryInsights {
  resumes: ResumeOutcome[];
  best_resume_id: string | null;
  total_applications: number;
  winning_keywords: string[];
}

export interface AdminUserRow {
  email: string;
  full_name: string | null;
  is_verified: boolean;
  created_at: string;
  applications: number;
}

export interface AdminStats {
  total_users: number;
  verified_users: number;
  active_users_30d: number;
  total_applications: number;
  total_resumes: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_llm_calls: number;
  cost_by_purpose: Record<string, number>;
  recent_signups: AdminUserRow[];
}

// --- LLM provider / model settings ------------------------------------------

export interface LlmModelInfo {
  id: string;
  label: string;
  input_cost: number;
  output_cost: number;
}

export interface LlmProviderInfo {
  id: string;
  label: string;
  models: LlmModelInfo[];
  has_key: boolean;
  byo_key: boolean;
  key_hint: string | null;
}

export interface LlmSettings {
  provider: string;
  model: string;
  providers: LlmProviderInfo[];
}

// --- Job search, config, admin extras ---------------------------------------

export interface JobSearchResult {
  title: string;
  company: string;
  location: string;
  url: string;
  remote: boolean;
  tags: string[];
  snippet: string;
  /** Whole posting; only present on a single-job response, "" in list results. */
  description?: string;
  source: string;
  created_at: number | null;
  company_domain: string;
  match_score: number | null;
  verdict: string | null;
  interview_chance: string | null;
  summary: string | null;
  strengths: string[];
  gaps: string[];
  // --- scraped-feed extras (absent/empty for the live board sources) ------
  id?: string | null;
  level?: string | null;
  /** Which degrees the posting will consider (see backend services/degrees.py). */
  degree_level?: string;
  /** What the posting says about sponsoring a work visa. */
  visa_verdict?: string;
  /** The sentence that decided it — only sent for a single job. */
  visa_evidence?: string;
  bucket?: string | null;
  terms?: string[];
  sponsorship?: string;
  track?: string | null;
  track_resume?: string | null;
  track_score?: number | null;
  status?: string | null;
  active?: boolean;
}

export interface PublicConfig {
  flags: Record<string, boolean>;
  oauth_providers: string[];
}

export interface FeatureFlagRow {
  key: string;
  enabled: boolean;
  description: string;
}

export interface AdminUserDetail {
  id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
  is_verified: boolean;
  is_superuser: boolean;
  created_at: string;
  applications: number;
  total_cost_usd: number;
  llm_calls: number;
}

export interface AdminUserPage {
  users: AdminUserDetail[];
  total: number;
}

/** Copilot's streamed reply.
 *
 * `fetch` + a reader rather than EventSource: EventSource can't send a POST body
 * or an Authorization header, and the request carries both.
 */
export async function streamCopilot(
  body: Record<string, unknown>,
  handlers: {
    onToken: (text: string) => void;
    onDone: (final: { grounded_in: string[]; action: CopilotAction | null }) => void;
  },
  retry = true,
): Promise<void> {
  const res = await fetch(`${API}/copilot/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokens.access ?? ""}`,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 401 && retry && tokens.refresh) {
    if (await tryRefresh()) return streamCopilot(body, handlers, false);
    tokens.clear();
    window.dispatchEvent(new Event("hirecraft:logout"));
    throw new ApiError("Your session expired. Please sign in again.", 401);
  }
  if (!res.ok) throw await parseError(res);
  if (!res.body) throw new ApiError("The reply stream was empty.", 500);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  // SSE frames are separated by a blank line and can split across chunks, so
  // hold a buffer and only consume whole frames.
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split: number;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      let event = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      const payload = JSON.parse(dataLines.join("\n"));
      if (event === "token") handlers.onToken(payload.text ?? "");
      else if (event === "done") {
        handlers.onDone({
          grounded_in: payload.grounded_in ?? [],
          action: payload.action ?? null,
        });
      } else if (event === "error") {
        throw new ApiError(payload.detail ?? "The reply failed.", 502);
      }
    }
  }
}
