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

async function tryRefresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
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
    } finally {
      // Clear on the next tick so callers awaiting this promise still see it.
      setTimeout(() => (refreshPromise = null), 0);
    }
  })();

  return refreshPromise;
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `Request failed (${res.status})`;
  let fieldErrors: { field: string; message: string }[] | undefined;
  try {
    const body = await res.json();
    if (typeof body.detail === "string") message = body.detail;
    if (Array.isArray(body.errors)) {
      fieldErrors = body.errors;
      message = body.detail ?? "Validation failed.";
    }
    // FastAPI's default 422 shape.
    if (Array.isArray(body.detail)) {
      fieldErrors = body.detail.map((d: { loc: string[]; msg: string }) => ({
        field: d.loc.slice(1).join("."),
        message: d.msg,
      }));
      message = "Validation failed.";
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
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${tokens.access ?? ""}` },
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

// --- Types mirroring the backend schemas ------------------------------------

export interface User {
  id: string;
  email: string;
  full_name: string | null;
  is_verified: boolean;
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
  id: string;
  name: string;
  is_default: boolean;
  tags: string[];
  template: string;
  current_version: number;
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

export interface CareerProfile {
  headline: string | null;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;
  github_url: string | null;
  portfolio_url: string | null;
  website_url: string | null;
  work_authorization: string | null;
  visa_status: string | null;
  years_experience: number | null;
  preferred_roles: string[];
  preferred_industries: string[];
  preferred_locations: string[];
  salary_min: number | null;
  salary_max: number | null;
  salary_currency: string;
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
  | "draft"
  | "applied"
  | "screening"
  | "interviewing"
  | "offer"
  | "rejected"
  | "ghosted"
  | "withdrawn";

export interface ApplicationSummary {
  id: string;
  pipeline_status: PipelineStatus;
  tracker_status: TrackerStatus;
  job_title: string | null;
  company: string | null;
  total_cost_usd: number;
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

export interface ApplicationDetail {
  id: string;
  pipeline_status: PipelineStatus;
  tracker_status: TrackerStatus;
  error_message: string | null;
  include_cover_letter: boolean;
  notes: string | null;
  tailored_resume: MasterResume | null;
  diff: DiffEntry[] | null;
  guardrail_report: GuardrailReport | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  created_at: string;
  updated_at: string;
  job: {
    id: string;
    url: string | null;
    title: string | null;
    company: string | null;
    location: string | null;
    raw_text: string;
    requirements: JobRequirements | null;
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
