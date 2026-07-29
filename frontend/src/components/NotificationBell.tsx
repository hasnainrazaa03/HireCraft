import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type NotificationList, type NotificationItem } from "../lib/api";
import { IconBell } from "./icons";

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<NotificationList>("/notifications?limit=20"),
    refetchInterval: 60_000, // poll for new reminders
  });

  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });
  const markAll = useMutation({
    mutationFn: () => api.post("/notifications/read-all"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notifications"] }),
  });

  const unread = data?.unread_count ?? 0;
  const items = data?.items ?? [];

  function activate(n: NotificationItem) {
    if (!n.read_at) markRead.mutate(n.id);
    setOpen(false);
    if (n.link) navigate(n.link);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="btn-ghost relative h-9 w-9 !p-0"
        aria-label="Notifications"
      >
        <IconBell className="h-[18px] w-[18px]" />
        {unread > 0 && (
          <span className="pointer-events-none absolute right-1 top-1 flex h-4 min-w-[16px] -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-full bg-hotpink px-1 text-[10px] font-bold leading-none tabular-nums text-white ring-2 ring-canvas">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-80 animate-fade-in overflow-hidden rounded-2xl border border-white/[0.1] bg-canvas-raised shadow-soft">
            <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
              <span className="text-sm font-semibold">Notifications</span>
              {unread > 0 && (
                <button
                  onClick={() => markAll.mutate()}
                  className="text-xs text-brand-300 hover:text-brand-200"
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-[22rem] overflow-y-auto">
              {items.length === 0 ? (
                <p className="px-4 py-8 text-center text-sm text-subtle">You're all caught up.</p>
              ) : (
                items.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => activate(n)}
                    className={`flex w-full gap-2.5 border-b border-white/[0.04] px-4 py-3 text-left transition hover:bg-surface-2 ${
                      n.read_at ? "opacity-70" : ""
                    }`}
                  >
                    {!n.read_at && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-hotpink" />}
                    <span className={n.read_at ? "pl-4" : ""}>
                      <span className="block text-sm font-medium text-content">{n.title}</span>
                      {n.body && <span className="mt-0.5 block text-xs text-subtle">{n.body}</span>}
                      <span className="mt-1 block text-[11px] text-subtle">{timeAgo(n.created_at)}</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
