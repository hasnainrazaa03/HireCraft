/**
 * Structured résumé builder — edit a Master Resume with forms instead of raw
 * JSON. Covers the high-value sections (basics, experience, education, projects,
 * skills) with add/remove/reorder. Rarer sections (certifications, awards,
 * publications) round-trip untouched through the JSON mode on the Resumes page.
 *
 * Works on a plain content object so it can load a parsed-import result or an
 * existing résumé's content, and emits the same shape back for saving. Each
 * section is a collapsible card; long-form fields (summary, bullets) grow to
 * fit their text so nothing is clipped.
 */
import { useLayoutEffect, useRef, useState } from "react";

import { api, type ProfileIntroResponse } from "../lib/api";
import { TagInput } from "./TagInput";
import { IconChevronDown, IconPlus, IconSparkles, IconTrash } from "./icons";

// The résumé content is loosely typed here; the backend validates it strictly
// against the Master Resume schema on save.
export type ResumeContent = Record<string, any>;

export function ResumeBuilder({
  value,
  onChange,
}: {
  value: ResumeContent;
  onChange: (next: ResumeContent) => void;
}) {
  const basics = value.basics ?? {};

  function patch(next: Partial<ResumeContent>) {
    onChange({ ...value, ...next });
  }
  function setBasics(next: Record<string, any>) {
    patch({ basics: { ...basics, ...next } });
  }
  function setList(key: string, list: any[]) {
    patch({ [key]: list });
  }

  return (
    <div className="space-y-4">
      {/* Basics */}
      <Collapsible title="Basics">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Full name" value={basics.name} onChange={(v) => setBasics({ name: v })} required />
          <Input label="Email" value={basics.email} onChange={(v) => setBasics({ email: v })} required />
          <Input label="Phone" value={basics.phone} onChange={(v) => setBasics({ phone: v })} />
          <Input label="Location" value={basics.location} onChange={(v) => setBasics({ location: v })} />
          <Input label="LinkedIn" value={basics.linkedin} onChange={(v) => setBasics({ linkedin: v })} placeholder="https://…" />
          <Input label="GitHub" value={basics.github} onChange={(v) => setBasics({ github: v })} placeholder="https://…" />
        </div>

        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.07] bg-surface-2 px-3.5 py-2.5">
          <div className="min-w-0">
            <p className="text-sm font-medium">Headline &amp; summary</p>
            <p className="text-xs text-subtle">Let AI draft these from your experience — you can edit after.</p>
          </div>
          <IntroGenerator
            content={value}
            onResult={(headline, summary) =>
              setBasics({
                ...(headline ? { headline } : {}),
                ...(summary ? { summary } : {}),
              })
            }
          />
        </div>

        <Input label="Headline" value={basics.headline} onChange={(v) => setBasics({ headline: v })} placeholder="Backend Engineer focused on distributed systems" />
        <Field label="Summary">
          <AutoTextarea value={basics.summary} onChange={(v) => setBasics({ summary: v })} minRows={3} placeholder="2–4 sentences on what you do and your strongest, most relevant experience." />
        </Field>
      </Collapsible>

      {/* Experience */}
      <EntryList
        title="Experience"
        entries={value.experience ?? []}
        onChange={(list) => setList("experience", list)}
        blank={{ company: "", title: "", start_date: "", end_date: "", location: "", highlights: [""], technologies: [] }}
        addLabel="Add experience"
        label={(e) => e.title || e.company}
        render={(e, up) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Company" value={e.company} onChange={(v) => up({ company: v })} required />
              <Input label="Title" value={e.title} onChange={(v) => up({ title: v })} required />
              <Input label="Start (YYYY or YYYY-MM)" value={e.start_date} onChange={(v) => up({ start_date: v })} />
              <Input label="End (or 'Present')" value={e.end_date} onChange={(v) => up({ end_date: v })} />
            </div>
            <Input label="Location" value={e.location} onChange={(v) => up({ location: v })} />
            <BulletEditor label="Highlights" items={e.highlights ?? []} onChange={(v) => up({ highlights: v })} />
            <Field label="Technologies">
              <TagInput value={e.technologies ?? []} onChange={(v) => up({ technologies: v })} placeholder="Python, React…" />
            </Field>
          </>
        )}
      />

      {/* Education */}
      <EntryList
        title="Education"
        entries={value.education ?? []}
        onChange={(list) => setList("education", list)}
        blank={{ institution: "", degree: "", field_of_study: "", start_date: "", end_date: "", gpa: "", coursework: [], highlights: [] }}
        addLabel="Add education"
        label={(e) => e.institution || e.degree}
        render={(e, up) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Institution" value={e.institution} onChange={(v) => up({ institution: v })} required />
              <Input label="Degree" value={e.degree} onChange={(v) => up({ degree: v })} required />
              <Input label="Field of study" value={e.field_of_study} onChange={(v) => up({ field_of_study: v })} />
              <Input label="GPA" value={e.gpa} onChange={(v) => up({ gpa: v })} />
              <Input label="Start" value={e.start_date} onChange={(v) => up({ start_date: v })} />
              <Input label="End" value={e.end_date} onChange={(v) => up({ end_date: v })} />
            </div>
            <Field label="Relevant coursework">
              <TagInput value={e.coursework ?? []} onChange={(v) => up({ coursework: v })} placeholder="Operating Systems…" />
            </Field>
          </>
        )}
      />

      {/* Projects */}
      <EntryList
        title="Projects"
        entries={value.projects ?? []}
        onChange={(list) => setList("projects", list)}
        blank={{ name: "", description: "", url: "", start_date: "", end_date: "", highlights: [""], technologies: [] }}
        addLabel="Add project"
        label={(e) => e.name}
        render={(e, up) => (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Name" value={e.name} onChange={(v) => up({ name: v })} required />
              <Input label="URL" value={e.url} onChange={(v) => up({ url: v })} placeholder="https://…" />
            </div>
            <Input label="Description" value={e.description} onChange={(v) => up({ description: v })} />
            <BulletEditor label="Highlights" items={e.highlights ?? []} onChange={(v) => up({ highlights: v })} />
            <Field label="Built with">
              <TagInput value={e.technologies ?? []} onChange={(v) => up({ technologies: v })} placeholder="TypeScript…" />
            </Field>
          </>
        )}
      />

      {/* Skills */}
      <EntryList
        title="Skills"
        entries={value.skills ?? []}
        onChange={(list) => setList("skills", list)}
        blank={{ category: "", items: [] }}
        addLabel="Add skill group"
        label={(e) => e.category}
        render={(e, up) => (
          <>
            <Input label="Category" value={e.category} onChange={(v) => up({ category: v })} placeholder="Languages" required />
            <Field label="Items">
              <TagInput value={e.items ?? []} onChange={(v) => up({ items: v })} placeholder="Python, SQL…" />
            </Field>
          </>
        )}
      />
    </div>
  );
}

// --- building blocks ---------------------------------------------------------

/** A collapsible section card. Optional header count badge + right-aligned action. */
function Collapsible({
  title,
  badge,
  action,
  defaultOpen = true,
  children,
}: {
  title: string;
  badge?: number;
  action?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card overflow-hidden p-0">
      <div className="flex items-center gap-2 pr-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-2.5 px-5 py-3.5 text-left"
        >
          <IconChevronDown className={`h-4 w-4 shrink-0 text-subtle transition-transform duration-200 ${open ? "" : "-rotate-90"}`} />
          <h3 className="text-base font-semibold">{title}</h3>
          {badge != null && (
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs font-medium text-subtle">{badge}</span>
          )}
        </button>
        {action}
      </div>
      {open && <div className="space-y-3 border-t border-white/[0.06] px-5 py-4">{children}</div>}
    </div>
  );
}

function EntryList({
  title,
  entries,
  onChange,
  blank,
  addLabel,
  label,
  render,
}: {
  title: string;
  entries: any[];
  onChange: (list: any[]) => void;
  blank: Record<string, any>;
  addLabel: string;
  label?: (entry: any) => string | undefined;
  render: (entry: any, update: (patch: Record<string, any>) => void) => React.ReactNode;
}) {
  function update(i: number, patch: Record<string, any>) {
    onChange(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }
  function remove(i: number) {
    onChange(entries.filter((_, idx) => idx !== i));
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= entries.length) return;
    const next = [...entries];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }

  const addButton = (
    <button onClick={() => onChange([...entries, { ...blank }])} className="btn-secondary btn-sm shrink-0">
      <IconPlus className="h-4 w-4" /> {addLabel}
    </button>
  );

  return (
    <Collapsible title={title} badge={entries.length} action={addButton}>
      {entries.length === 0 ? (
        <p className="text-sm text-subtle">None yet.</p>
      ) : (
        <div className="space-y-4">
          {entries.map((entry, i) => (
            <div key={i} className="rounded-xl border border-white/[0.07] bg-surface-2 p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-xs font-medium text-subtle">
                  #{i + 1}
                  {label?.(entry) ? <span className="text-fg/80"> · {label(entry)}</span> : null}
                </span>
                <div className="flex shrink-0 gap-1">
                  <IconBtn onClick={() => move(i, -1)} disabled={i === 0} label="Move up">↑</IconBtn>
                  <IconBtn onClick={() => move(i, 1)} disabled={i === entries.length - 1} label="Move down">↓</IconBtn>
                  <button onClick={() => remove(i)} className="btn-ghost btn-sm text-danger hover:bg-danger/10" aria-label="Remove">
                    <IconTrash className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="space-y-3">{render(entry, (patch) => update(i, patch))}</div>
            </div>
          ))}
        </div>
      )}
    </Collapsible>
  );
}

function BulletEditor({ label, items, onChange }: { label: string; items: string[]; onChange: (v: string[]) => void }) {
  return (
    <Field label={label}>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-start gap-2">
            <AutoTextarea
              value={item}
              onChange={(v) => onChange(items.map((t, idx) => (idx === i ? v : t)))}
              placeholder="Describe an accomplishment with a real metric"
            />
            <button onClick={() => onChange(items.filter((_, idx) => idx !== i))} className="btn-ghost btn-sm mt-0.5 shrink-0 text-danger hover:bg-danger/10" aria-label="Remove bullet">
              <IconTrash className="h-4 w-4" />
            </button>
          </div>
        ))}
        <button onClick={() => onChange([...items, ""])} className="btn-ghost btn-sm">
          <IconPlus className="h-4 w-4" /> Add bullet
        </button>
      </div>
    </Field>
  );
}

/** AI-drafts a truthful headline + summary from the rest of the résumé. */
function IntroGenerator({
  content,
  onResult,
}: {
  content: ResumeContent;
  onResult: (headline: string, summary: string) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post<ProfileIntroResponse>("/resumes/generate-intro", content);
      onResult(res.headline, res.summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't generate — try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-2.5">
      {error && <span className="max-w-[16rem] text-xs text-danger">{error}</span>}
      <button type="button" onClick={run} disabled={loading} className="btn-secondary btn-sm shrink-0">
        <IconSparkles className="h-4 w-4" /> {loading ? "Writing…" : "Generate with AI"}
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
    </div>
  );
}

function Input({ label, value, onChange, placeholder, required }: { label: string; value?: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <Field label={required ? `${label} *` : label}>
      <input className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
    </Field>
  );
}

/** A textarea that grows to fit its content, so long bullets are never clipped. */
function AutoTextarea({
  value,
  onChange,
  placeholder,
  minRows = 1,
}: {
  value?: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="input flex-1 resize-none overflow-hidden py-2 leading-relaxed"
      rows={minRows}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

function IconBtn({ onClick, disabled, label, children }: { onClick: () => void; disabled?: boolean; label: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} className="btn-ghost btn-sm px-2 disabled:opacity-30" aria-label={label}>
      {children}
    </button>
  );
}

/**
 * Strip the placeholder rows the builder creates.
 *
 * "Add bullet" inserts an empty string and "Add" inserts a blank entry, but the
 * Master Resume schema requires non-empty bullets and non-empty company/title/
 * name. So a half-finished row the user never got round to filling made the
 * whole save fail with a generic "Validation failed", pointing at nothing. Drop
 * what's empty on the way out instead: the row the user is actively typing into
 * is preserved, only the untouched ones disappear.
 */
export function pruneEmpty(content: ResumeContent): ResumeContent {
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : v);
  const bullets = (list: unknown) =>
    Array.isArray(list) ? list.map(text).filter((b) => typeof b === "string" && b) : list;

  const next: ResumeContent = { ...content };

  for (const key of ["experience", "education", "projects"]) {
    const entries = next[key];
    if (!Array.isArray(entries)) continue;
    next[key] = entries
      .map((entry: Record<string, any>) => {
        const cleaned: Record<string, any> = { ...entry };
        for (const listKey of ["highlights", "technologies", "coursework", "honors"]) {
          if (listKey in cleaned) cleaned[listKey] = bullets(cleaned[listKey]);
        }
        return cleaned;
      })
      // An entry counts as blank only when every field the user could have
      // filled is still empty — never drop one that has real content but is
      // merely missing a required field, or their work vanishes without a word.
      .filter((entry: Record<string, any>) =>
        Object.entries(entry).some(([k, v]) =>
          k === "id" ? false : Array.isArray(v) ? v.length > 0 : Boolean(text(v)),
        ),
      );
  }

  if (Array.isArray(next.skills)) {
    next.skills = next.skills
      .map((group: Record<string, any>) => ({ ...group, items: bullets(group.items) }))
      .filter((group: Record<string, any>) => group.items?.length);
  }

  return next;
}
