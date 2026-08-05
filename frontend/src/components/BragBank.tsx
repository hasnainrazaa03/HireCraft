/**
 * Brag bank editor — the candidate's supplemental, attested evidence.
 *
 * These grounded facts widen what tailoring may honestly draw on: a number or
 * tool captured here becomes valid provenance, so the engine can surface it
 * without flagging it as fabrication. Grouped by the role/project label so the
 * list reads like a portfolio of what you've actually done.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, ApiError, type EvidenceItem, type EvidenceKind } from "../lib/api";
import { useToast } from "../lib/toast";
import { Spinner } from "./ui";
import { IconPlus, IconTrash, IconPen } from "./icons";

const KINDS: { value: EvidenceKind; label: string; badge: string }[] = [
  { value: "impact", label: "Impact", badge: "badge-emerald" },
  { value: "scope", label: "Scope / scale", badge: "badge-blue" },
  { value: "skill", label: "Skill used", badge: "badge-brand" },
  { value: "achievement", label: "Achievement", badge: "badge-coral" },
  { value: "context", label: "Context", badge: "badge-muted" },
  { value: "other", label: "Other", badge: "badge-muted" },
];
const BADGE: Record<EvidenceKind, string> = Object.fromEntries(
  KINDS.map((k) => [k.value, k.badge]),
) as Record<EvidenceKind, string>;
const KIND_LABEL: Record<EvidenceKind, string> = Object.fromEntries(
  KINDS.map((k) => [k.value, k.label]),
) as Record<EvidenceKind, string>;

export function BragBank() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["evidence"],
    queryFn: () => api.get<EvidenceItem[]>("/evidence"),
  });

  const [editing, setEditing] = useState<EvidenceItem | null>(null);
  const [adding, setAdding] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["evidence"] });
  const onErr = (e: unknown) =>
    toast.error("Couldn't save", e instanceof ApiError ? e.message : undefined);

  const create = useMutation({
    mutationFn: (body: Partial<EvidenceItem>) => api.post<EvidenceItem>("/evidence", body),
    onSuccess: () => { invalidate(); setAdding(false); },
    onError: onErr,
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<EvidenceItem> }) =>
      api.patch<EvidenceItem>(`/evidence/${id}`, body),
    onSuccess: () => { invalidate(); setEditing(null); },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/evidence/${id}`),
    onSuccess: invalidate,
    onError: onErr,
  });

  // Group by label (role/project); untagged fall under "General".
  const groups = useMemo(() => {
    const map = new Map<string, EvidenceItem[]>();
    for (const it of items) {
      const key = it.label?.trim() || "General";
      (map.get(key) ?? map.set(key, []).get(key)!).push(it);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [items]);

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <p className="text-sm text-muted">
          True facts about your work — scope, impact, tools, wins — that your résumé
          compresses away. Tailoring draws on these to sell you honestly: anything here
          becomes fair game to surface, so the more you add, the stronger and more
          grounded every résumé and letter gets.
          <span className="mt-1 block text-xs text-subtle">
            Each fact saves on its own as you add, edit, or delete it — the "Save changes" button above is only for the profile fields.
          </span>
        </p>
        <button onClick={() => { setAdding(true); setEditing(null); }} className="btn-secondary btn-sm shrink-0">
          <IconPlus className="h-4 w-4" /> Add fact
        </button>
      </div>

      {adding && (
        <EvidenceForm
          onCancel={() => setAdding(false)}
          onSubmit={(body) => create.mutate(body)}
          pending={create.isPending}
        />
      )}

      {isLoading ? (
        <div className="py-6 text-center"><Spinner className="mx-auto h-5 w-5" /></div>
      ) : items.length === 0 && !adding ? (
        <div className="rounded-xl border border-dashed border-white/[0.1] p-6 text-center text-sm text-subtle">
          No evidence yet. Add facts about your real work — the engine can only sell what it knows.
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map(([label, groupItems]) => (
            <div key={label}>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold">{label}</h3>
                <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-xs text-subtle">
                  {groupItems.length}
                </span>
              </div>
              <div className="space-y-2">
                {groupItems.map((it) =>
                  editing?.id === it.id ? (
                    <EvidenceForm
                      key={it.id}
                      initial={it}
                      onCancel={() => setEditing(null)}
                      onSubmit={(body) => update.mutate({ id: it.id, body })}
                      pending={update.isPending}
                    />
                  ) : (
                    <div key={it.id} className="group flex items-start gap-3 rounded-xl border border-white/[0.07] bg-surface-2 px-3.5 py-2.5">
                      <span className={`${BADGE[it.kind]} mt-0.5 shrink-0 text-[10px]`}>
                        {KIND_LABEL[it.kind]}
                      </span>
                      <p className="flex-1 text-sm leading-relaxed text-content">{it.text}</p>
                      <div className="flex shrink-0 gap-1 opacity-100 transition focus-within:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                        <button onClick={() => { setEditing(it); setAdding(false); }} className="btn-ghost btn-sm px-2" aria-label="Edit">
                          <IconPen className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => remove.mutate(it.id)} className="btn-ghost btn-sm px-2 text-danger hover:bg-danger/10" aria-label="Delete">
                          <IconTrash className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EvidenceForm({
  initial,
  onCancel,
  onSubmit,
  pending,
}: {
  initial?: EvidenceItem;
  onCancel: () => void;
  onSubmit: (body: Partial<EvidenceItem>) => void;
  pending: boolean;
}) {
  const [kind, setKind] = useState<EvidenceKind>(initial?.kind ?? "impact");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [text, setText] = useState(initial?.text ?? "");

  function submit() {
    if (text.trim().length < 3) return;
    onSubmit({ kind, label: label.trim() || null, text: text.trim() });
  }

  return (
    <div className="rounded-xl border border-brand-500/40 bg-brand-500/[0.05] p-3.5">
      <div className="mb-2 grid grid-cols-2 gap-2">
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value as EvidenceKind)}>
          {KINDS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
        <input
          className="input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Role / project (e.g. Deloitte)"
        />
      </div>
      <textarea
        className="input min-h-[70px] leading-relaxed"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="A true fact about your work — a number, an outcome, a tool you used, a hard constraint you handled…"
        autoFocus
      />
      <div className="mt-2 flex justify-end gap-2">
        <button onClick={onCancel} className="btn-ghost btn-sm">Cancel</button>
        <button onClick={submit} disabled={pending || text.trim().length < 3} className="btn-primary btn-sm">
          {pending ? "Saving…" : initial ? "Save" : "Add"}
        </button>
      </div>
    </div>
  );
}
