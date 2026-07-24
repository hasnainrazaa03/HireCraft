/**
 * Structured résumé builder — edit a Master Resume with forms instead of raw
 * JSON. Covers the high-value sections (basics, experience, education, projects,
 * skills) with add/remove/reorder. Rarer sections (certifications, awards,
 * publications) round-trip untouched through the JSON mode on the Resumes page.
 *
 * Works on a plain content object so it can load a parsed-import result or an
 * existing résumé's content, and emits the same shape back for saving.
 */
import { TagInput } from "./TagInput";
import { IconPlus, IconTrash } from "./icons";

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
    <div className="space-y-6">
      {/* Basics */}
      <Section title="Basics">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Full name" value={basics.name} onChange={(v) => setBasics({ name: v })} required />
          <Input label="Email" value={basics.email} onChange={(v) => setBasics({ email: v })} required />
          <Input label="Phone" value={basics.phone} onChange={(v) => setBasics({ phone: v })} />
          <Input label="Location" value={basics.location} onChange={(v) => setBasics({ location: v })} />
          <Input label="LinkedIn" value={basics.linkedin} onChange={(v) => setBasics({ linkedin: v })} placeholder="https://…" />
          <Input label="GitHub" value={basics.github} onChange={(v) => setBasics({ github: v })} placeholder="https://…" />
        </div>
        <Input label="Headline" value={basics.headline} onChange={(v) => setBasics({ headline: v })} placeholder="Backend Engineer focused on distributed systems" />
        <TextArea label="Summary" value={basics.summary} onChange={(v) => setBasics({ summary: v })} />
      </Section>

      {/* Experience */}
      <EntryList
        title="Experience"
        entries={value.experience ?? []}
        onChange={(list) => setList("experience", list)}
        blank={{ company: "", title: "", start_date: "", end_date: "", location: "", highlights: [""], technologies: [] }}
        addLabel="Add experience"
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <h3 className="mb-4 text-base font-semibold">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function EntryList({
  title,
  entries,
  onChange,
  blank,
  addLabel,
  render,
}: {
  title: string;
  entries: any[];
  onChange: (list: any[]) => void;
  blank: Record<string, any>;
  addLabel: string;
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

  return (
    <div className="card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold">{title}</h3>
        <button onClick={() => onChange([...entries, { ...blank }])} className="btn-secondary btn-sm">
          <IconPlus className="h-4 w-4" /> {addLabel}
        </button>
      </div>
      {entries.length === 0 ? (
        <p className="text-sm text-subtle">None yet.</p>
      ) : (
        <div className="space-y-4">
          {entries.map((entry, i) => (
            <div key={i} className="rounded-xl border border-white/[0.07] bg-surface-2 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs font-medium text-subtle">#{i + 1}</span>
                <div className="flex gap-1">
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
    </div>
  );
}

function BulletEditor({ label, items, onChange }: { label: string; items: string[]; onChange: (v: string[]) => void }) {
  return (
    <Field label={label}>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex gap-2">
            <textarea
              className="input min-h-[38px] flex-1 py-2 leading-snug"
              rows={1}
              value={item}
              onChange={(e) => onChange(items.map((t, idx) => (idx === i ? e.target.value : t)))}
              placeholder="Describe an accomplishment with a real metric"
            />
            <button onClick={() => onChange(items.filter((_, idx) => idx !== i))} className="btn-ghost btn-sm shrink-0 text-danger hover:bg-danger/10" aria-label="Remove bullet">
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

function TextArea({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <textarea className="input min-h-[80px] leading-relaxed" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

function IconBtn({ onClick, disabled, label, children }: { onClick: () => void; disabled?: boolean; label: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} disabled={disabled} className="btn-ghost btn-sm px-2 disabled:opacity-30" aria-label={label}>
      {children}
    </button>
  );
}
