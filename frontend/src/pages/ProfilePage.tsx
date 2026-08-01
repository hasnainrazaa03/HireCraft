import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type CareerProfile } from "../lib/api";
import { useToast } from "../lib/toast";
import { PageLoader } from "../components/ui";
import { TagInput } from "../components/TagInput";
import { BragBank } from "../components/BragBank";
import { PhoneInput } from "../components/PhoneInput";

const ARRANGEMENTS = ["remote", "hybrid", "onsite", "flexible"] as const;

const WORK_AUTH = [
  "U.S. Citizen",
  "U.S. Permanent Resident (Green Card)",
  "Authorized to work (no sponsorship needed)",
  "Will require sponsorship (future)",
  "Require sponsorship now (student visa)",
  "Not authorized to work in the U.S.",
  "EU / UK work authorization",
  "Other",
];
const VISA_STATUS = [
  "N/A — Citizen / Permanent Resident",
  "F-1 (Student)",
  "F-1 OPT",
  "F-1 STEM OPT",
  "F-1 CPT",
  "H-1B",
  "H-4 EAD",
  "L-1",
  "L-2 EAD",
  "J-1",
  "O-1",
  "TN (USMCA)",
  "E-3 (Australia)",
  "Green Card (Permanent Resident)",
  "Asylum / Refugee EAD",
  "DACA",
  "Other",
];
const SALARY_PERIODS = [
  ["yearly", "Per year"],
  ["monthly", "Per month"],
  ["weekly", "Per week"],
  ["hourly", "Per hour"],
] as const;

export default function ProfilePage() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["career-profile"],
    queryFn: () => api.get<CareerProfile>("/profile"),
  });

  const [form, setForm] = useState<CareerProfile | null>(null);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const save = useMutation({
    mutationFn: (body: Partial<CareerProfile>) => api.patch<CareerProfile>("/profile", body),
    onSuccess: (updated) => {
      queryClient.setQueryData(["career-profile"], updated);
      toast.success("Profile saved");
    },
    onError: (e) =>
      toast.error("Couldn't save", e instanceof ApiError ? e.message : undefined),
  });

  if (isLoading || !form) return <PageLoader label="Loading your profile…" />;

  function set<K extends keyof CareerProfile>(key: K, value: CareerProfile[K]) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  function onSave() {
    // Send everything; empty strings become null server-side where appropriate.
    save.mutate({
      ...form,
      // URL fields must be null (not "") to pass the HttpUrl validator.
      linkedin_url: form!.linkedin_url || null,
      github_url: form!.github_url || null,
      portfolio_url: form!.portfolio_url || null,
      website_url: form!.website_url || null,
    });
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Career profile</h1>
          <p className="mt-1 text-sm text-muted">
            Your reusable details and job-search preferences. This seeds new résumés
            and, later, job matching.
          </p>
        </div>
        <button onClick={onSave} disabled={save.isPending} className="btn-primary">
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
      </div>

      <Section title="Basics">
        <Field label="Professional headline">
          <input className="input" value={form.headline ?? ""} onChange={(e) => set("headline", e.target.value)} placeholder="Backend Engineer focused on distributed systems" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone"><PhoneInput value={form.phone} onChange={(v) => set("phone", v)} /></Field>
          <Field label="Location"><input className="input" value={form.location ?? ""} onChange={(e) => set("location", e.target.value)} placeholder="Los Angeles, CA" /></Field>
        </div>
      </Section>

      <Section title="Links">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="LinkedIn"><input className="input" value={form.linkedin_url ?? ""} onChange={(e) => set("linkedin_url", e.target.value)} placeholder="https://linkedin.com/in/…" /></Field>
          <Field label="GitHub"><input className="input" value={form.github_url ?? ""} onChange={(e) => set("github_url", e.target.value)} placeholder="https://github.com/…" /></Field>
          <Field label="Portfolio"><input className="input" value={form.portfolio_url ?? ""} onChange={(e) => set("portfolio_url", e.target.value)} /></Field>
          <Field label="Website"><input className="input" value={form.website_url ?? ""} onChange={(e) => set("website_url", e.target.value)} /></Field>
        </div>
      </Section>

      <Section title="Eligibility">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Work authorization">
            <select className="input" value={form.work_authorization ?? ""} onChange={(e) => set("work_authorization", e.target.value || null)}>
              <option value="">Select…</option>
              {WORK_AUTH.map((o) => <option key={o} value={o} className="bg-surface">{o}</option>)}
            </select>
          </Field>
          <Field label="Visa status">
            <select className="input" value={form.visa_status ?? ""} onChange={(e) => set("visa_status", e.target.value || null)}>
              <option value="">Select…</option>
              {VISA_STATUS.map((o) => <option key={o} value={o} className="bg-surface">{o}</option>)}
            </select>
          </Field>
          <Field label="Years of experience"><input type="number" min={0} className="input" value={form.years_experience ?? ""} onChange={(e) => set("years_experience", e.target.value ? Number(e.target.value) : null)} /></Field>
        </div>
      </Section>

      <Section title="Preferences">
        <Field label="Preferred roles">
          <TagInput value={form.preferred_roles} onChange={(v) => set("preferred_roles", v)} placeholder="Add a role and press Enter" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Preferred industries"><TagInput value={form.preferred_industries} onChange={(v) => set("preferred_industries", v)} placeholder="e.g. Fintech" /></Field>
          <Field label="Preferred locations"><TagInput value={form.preferred_locations} onChange={(v) => set("preferred_locations", v)} placeholder="e.g. Remote (US)" /></Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={`Salary min (${form.salary_currency})`}><input type="number" min={0} className="input" value={form.salary_min ?? ""} onChange={(e) => set("salary_min", e.target.value ? Number(e.target.value) : null)} /></Field>
          <Field label={`Salary max (${form.salary_currency})`}><input type="number" min={0} className="input" value={form.salary_max ?? ""} onChange={(e) => set("salary_max", e.target.value ? Number(e.target.value) : null)} /></Field>
          <Field label="Pay period">
            <select className="input" value={form.salary_period ?? "yearly"} onChange={(e) => set("salary_period", e.target.value as CareerProfile["salary_period"])}>
              {SALARY_PERIODS.map(([v, label]) => <option key={v} value={v} className="bg-surface">{label}</option>)}
            </select>
          </Field>
          <Field label="Work arrangement">
            <select className="input" value={form.work_arrangement ?? ""} onChange={(e) => set("work_arrangement", (e.target.value || null) as CareerProfile["work_arrangement"])}>
              <option value="">No preference</option>
              {ARRANGEMENTS.map((a) => <option key={a} value={a} className="bg-surface capitalize">{a}</option>)}
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2.5 pt-1 text-sm">
          <input type="checkbox" checked={form.open_to_relocation} onChange={(e) => set("open_to_relocation", e.target.checked)} className="h-4 w-4 rounded border-white/[0.14] bg-surface-3 text-brand-600 focus:ring-brand-500" />
          Open to relocation
        </label>
      </Section>

      <div className="mt-6 flex justify-end">
        <button onClick={onSave} disabled={save.isPending} className="btn-primary">
          {save.isPending ? "Saving…" : "Save changes"}
        </button>
      </div>

      <Section title="Brag bank">
        <BragBank />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card mb-5 p-6">
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  // Wrap the control in the label so it's programmatically associated without
  // threading ids through every call site (clicking the label focuses the input).
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
