import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { RefreshCcw, Check, X, Clock, CalendarDays, User, UserCog, GitBranch, Search, CalendarClock, AlertTriangle, Building2 } from 'lucide-react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { ApprovalTimeline } from '../components/ApprovalTimeline';
import { useT } from '../hooks/useT';
import { useToast } from '../stores/toast';
import { tip } from '../stores/tooltip';

// Async typeahead for the delegate picker. Queries the directory search
// endpoint (capped, server-side) instead of rendering every user as a DOM
// <option> — a full <select> of a 5,000-employee tenant freezes the tab.
function ApproverSearch({ onSelect, placeholder }: { onSelect: (id: string) => void; placeholder: string }) {
  const { t } = useT();
  const [text, setText] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // Highlighted row for keyboard navigation (-1 = nothing highlighted).
  const [active, setActive] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Debounced search — empty query returns the first page so the menu is
  // never blank on focus.
  useEffect(() => {
    let active = true;
    setLoading(true);
    const h = setTimeout(async () => {
      try { const r = await api.searchApprovers(text); if (active) setResults(r || []); }
      catch { if (active) setResults([]); }
      finally { if (active) setLoading(false); }
    }, 250);
    return () => { active = false; clearTimeout(h); };
  }, [text]);

  // Reset the highlight whenever the result set changes so the arrow keys start
  // from the top of the fresh list rather than a now-invalid index.
  useEffect(() => { setActive(-1); }, [results]);

  useEffect(() => {
    function onDoc(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function pick(u: any) {
    setText(`${u.username}${u.role ? ` — ${u.role}` : ''}`);
    onSelect(u.id);
    setOpen(false);
  }

  // Keyboard support: ↑/↓ move the highlight, Enter confirms it, Escape closes.
  // Executives drive this from the keyboard, so the menu has to be operable
  // without the mouse.
  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && active < results.length) {
        e.preventDefault();
        pick(results[active]);
      }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); }
    }
  }

  // Keep the highlighted row scrolled into view as the user arrows past the
  // visible window of the (scrollable) menu.
  useEffect(() => {
    if (active < 0 || !menuRef.current) return;
    const el = menuRef.current.querySelectorAll('.typeahead-item')[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="typeahead" ref={boxRef}>
      <div className="typeahead-input">
        <Search size={14} className="muted" />
        <input
          value={text}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-controls="approver-typeahead-menu"
          aria-activedescendant={active >= 0 && results[active] ? `approver-opt-${results[active].id}` : undefined}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          // Editing after a pick invalidates the selection so a stale id can't
          // be submitted under a different visible name.
          onChange={(e) => { setText(e.target.value); onSelect(''); setOpen(true); }}
        />
      </div>
      {open && (
        <div className="typeahead-menu" ref={menuRef} id="approver-typeahead-menu" role="listbox">
          {loading && <div className="typeahead-empty muted text-sm">{t('common.loading')}</div>}
          {!loading && results.length === 0 && <div className="typeahead-empty muted text-sm">{t('approvals.noMatches')}</div>}
          {!loading && results.map((u, i) => (
            <button type="button" key={u.id} id={`approver-opt-${u.id}`} role="option"
                    aria-selected={i === active}
                    className={`typeahead-item${i === active ? ' active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(u)}>
              <b>{u.username}</b>
              {u.role && <span className="muted"> — {u.role}</span>}
              {u.grade && <span className="muted"> · {u.grade}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ymd(d: Date) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function hm(d: Date) { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

// "View Schedule Context" slide-out — a read-only mini day-timeline for the
// room a pending booking targets, so an approver can decide in context instead
// of opening the calendar in another tab. Shows the requested slot against the
// day's other bookings, flags overlaps, and reports the buffer before/after.
function ScheduleContext({ booking, resourceName, onClose }: { booking: any; resourceName: string; onClose: () => void }) {
  const { t } = useT();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const reqStart = useMemo(() => new Date(booking.startTime), [booking.startTime]);
  const reqEnd = useMemo(() => new Date(booking.endTime), [booking.endTime]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    const day = new Date(reqStart); day.setHours(0, 0, 0, 0);
    const next = new Date(day); next.setDate(day.getDate() + 1);
    api.bookingsRange(ymd(day), ymd(next))
      .then((list: any[]) => {
        if (!active) return;
        // Same room, same day, still live, and not the request we're judging.
        setRows((list || []).filter((b) =>
          b.resourceId === booking.resourceId && b.status !== 'Cancelled' && b.id !== booking.id));
      })
      .catch(() => { if (active) setRows([]); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [booking.id, booking.resourceId, reqStart]);

  // Close on Escape — drawer convention.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const blocks = useMemo(() => rows.map((b) => {
    const start = new Date(b.startTime);
    const end = new Date(b.endTime);
    return {
      id: b.id, start, end,
      title: b.subjectHidden ? '🔒 Private' : (b.title || resourceName),
      conflict: start < reqEnd && end > reqStart, // overlaps the requested slot
    };
  }).sort((a, b) => a.start.getTime() - b.start.getTime()), [rows, reqStart, reqEnd, resourceName]);

  // Side-by-side lane layout for overlapping bookings. Without this, two
  // bookings on the same room/day (a pre-validation double-book, or parallel
  // shared-desk slots) draw on top of each other and the lower one is invisible.
  // We split each overlap cluster into greedy columns (FullCalendar-style) and
  // hand back, per booking, its column index and the cluster's column count so
  // the render can size width/left. Non-overlapping bookings stay full width.
  const lanes = useMemo(() => {
    const sorted = [...blocks].sort((a, b) =>
      a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
    const out = new Map<string, { col: number; cols: number }>();
    let cluster: typeof sorted = [];
    let clusterEnd = -Infinity;
    const flush = () => {
      if (!cluster.length) return;
      const colEnds: number[] = []; // last end-time placed in each column
      const colOf = new Map<string, number>();
      for (const b of cluster) {
        let col = colEnds.findIndex((end) => end <= b.start.getTime());
        if (col === -1) { col = colEnds.length; colEnds.push(0); }
        colEnds[col] = b.end.getTime();
        colOf.set(b.id, col);
      }
      const cols = colEnds.length;
      for (const b of cluster) out.set(b.id, { col: colOf.get(b.id)!, cols });
      cluster = [];
    };
    for (const b of sorted) {
      if (cluster.length && b.start.getTime() >= clusterEnd) flush();
      cluster.push(b);
      clusterEnd = cluster.length === 1 ? b.end.getTime() : Math.max(clusterEnd, b.end.getTime());
    }
    flush();
    return out;
  }, [blocks]);

  const conflicts = blocks.filter((b) => b.conflict);
  // Tightest gap to an adjacent (non-overlapping) booking, in minutes.
  const bufferBefore = blocks.filter((b) => b.end <= reqStart)
    .reduce((m, b) => Math.min(m, (reqStart.getTime() - b.end.getTime()) / 60000), Infinity);
  const bufferAfter = blocks.filter((b) => b.start >= reqEnd)
    .reduce((m, b) => Math.min(m, (b.start.getTime() - reqEnd.getTime()) / 60000), Infinity);

  // Proportional timeline window: 08:00–18:00 by default, widened to fit any
  // booking (and the request) that falls outside it.
  const PX_PER_HOUR = 46;
  const all = [...blocks.flatMap((b) => [b.start, b.end]), reqStart, reqEnd];
  const startH = Math.max(0, Math.min(8, ...all.map((d) => d.getHours())));
  const endH = Math.min(24, Math.max(18, ...all.map((d) => d.getHours() + (d.getMinutes() > 0 || d.getSeconds() > 0 ? 1 : 0))));
  const windowStart = new Date(reqStart); windowStart.setHours(startH, 0, 0, 0);
  const trackH = (endH - startH) * PX_PER_HOUR;
  const topFor = (d: Date) => ((d.getTime() - windowStart.getTime()) / 3600000) * PX_PER_HOUR;
  const heightFor = (s: Date, e: Date) => Math.max(16, ((e.getTime() - s.getTime()) / 3600000) * PX_PER_HOUR);
  const hours = Array.from({ length: endH - startH + 1 }, (_, i) => startH + i);

  const fmtGap = (m: number) => (m === Infinity ? t('approvals.ctxNoAdjacent')
    : m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${Math.round(m % 60)}m` : ''}` : `${Math.round(m)}m`);

  return (
    <div className="sched-drawer-wrap" role="dialog" aria-modal="true" aria-label={t('approvals.ctxTitle')}>
      <div className="sched-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="sched-drawer open">
        <header className="sched-drawer-head">
          <div style={{ minWidth: 0 }}>
            <h3 className="truncate">{resourceName}</h3>
            <span className="muted text-sm">{reqStart.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('common.close')}><X size={18} /></button>
        </header>

        {/* Verdict summary so the decision is one glance, not a chart-reading
            exercise. */}
        {conflicts.length > 0 ? (
          <div className="sched-verdict danger">
            <AlertTriangle size={15} />
            <span>{t('approvals.ctxConflicts', { count: conflicts.length })}</span>
          </div>
        ) : (
          <div className="sched-verdict ok">
            <Check size={15} />
            <span>{t('approvals.ctxClear')}</span>
          </div>
        )}
        <div className="sched-buffers muted text-sm">
          <span>{t('approvals.ctxBufferBefore')}: <b>{fmtGap(bufferBefore)}</b></span>
          <span>{t('approvals.ctxBufferAfter')}: <b>{fmtGap(bufferAfter)}</b></span>
        </div>

        <div className="sched-body">
          {loading ? (
            <p className="muted text-sm">{t('common.loading')}</p>
          ) : (
            <div className="sched-timeline" style={{ height: trackH }}>
              {hours.map((h) => (
                <div key={h} className="sched-hour" style={{ top: (h - startH) * PX_PER_HOUR }}>
                  <span className="sched-hour-label">{String(h).padStart(2, '0')}:00</span>
                </div>
              ))}
              {/* Existing bookings — width/left split into lanes when they overlap. */}
              {blocks.map((b) => {
                const lane = lanes.get(b.id) ?? { col: 0, cols: 1 };
                const w = 100 / lane.cols;
                return (
                  <div key={b.id} className={`sched-evt${b.conflict ? ' conflict' : ''}`}
                       style={{
                         top: topFor(b.start), height: heightFor(b.start, b.end),
                         left: `calc(${lane.col * w}% + 3px)`,
                         width: `calc(${w}% - 6px)`,
                         right: 'auto',
                       }}
                       {...tip(`${hm(b.start)}–${hm(b.end)} · ${b.title}`)}>
                    <b className="truncate">{b.title}</b>
                    <small>{hm(b.start)}–{hm(b.end)}</small>
                  </div>
                );
              })}
              {/* The slot under review — drawn on top so it's unmistakable. */}
              <div className="sched-evt requested"
                   style={{ top: topFor(reqStart), height: heightFor(reqStart, reqEnd) }}
                   {...tip(`${hm(reqStart)}–${hm(reqEnd)} · ${t('approvals.ctxRequested')}`)}>
                <b className="truncate">{t('approvals.ctxRequested')}</b>
                <small>{hm(reqStart)}–{hm(reqEnd)}</small>
              </div>
            </div>
          )}
          {!loading && blocks.length === 0 && (
            <p className="muted text-sm" style={{ marginTop: 10 }}>{t('approvals.ctxEmpty')}</p>
          )}
        </div>
      </aside>
    </div>
  );
}

export function Approvals() {
  const { t } = useT();
  const toast = useToast();
  const [rows, setRows] = useState<any[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [chains, setChains] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [rejecting, setRejecting] = useState<any | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [delegating, setDelegating] = useState<any | null>(null);
  const [delegateTo, setDelegateTo] = useState('');
  const [delegateReason, setDelegateReason] = useState('');
  // The booking whose room schedule is shown in the slide-out context panel.
  const [contextFor, setContextFor] = useState<any | null>(null);
  // Bulk approvals: a manager back from leave with 40 pending rooms shouldn't
  // click Approve 40 times. Track the selected booking ids and approve them in
  // one sweep.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      // Requester names now ride along on the approvals payload (b.userName),
      // so there's no full-directory fetch here — only the bounded resource list.
      const [list, res] = await Promise.all([
        api.listApprovals(),
        api.resources().catch(() => []),
      ]);
      setRows(list || []);
      setResources(res || []);
      // Best-effort fetch chain per row — failures are silent because
      // single-level bookings have no chain.
      const next: Record<string, any[]> = {};
      await Promise.all((list || []).map(async (b: any) => {
        try { next[b.id] = await api.approvalChain(b.id) ?? []; }
        catch { next[b.id] = []; }
      }));
      setChains(next);
    } finally { setLoading(false); }
  }

  const resourceMap = useMemo(() => Object.fromEntries(resources.map((r) => [r.id, r])), [resources]);

  // Earliest pending-step due time, used to sort closest-to-breach first.
  function dueFor(b: any): number {
    for (const s of chains[b.id] ?? []) {
      if ((s.status ?? '').toLowerCase() === 'pending' && s.dueAt) return new Date(s.dueAt).getTime();
    }
    return Infinity;
  }
  const sorted = useMemo(() => [...rows].sort((a, b) => dueFor(a) - dueFor(b)), [rows, chains]);

  const stats = useMemo(() => {
    const now = new Date();
    const todayStr = now.toDateString();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    let chained = 0, today = 0, week = 0;
    for (const b of rows) {
      if ((chains[b.id] ?? []).length > 0) chained++;
      const start = new Date(b.startTime);
      if (start.toDateString() === todayStr) today++;
      if (start >= weekAgo) week++;
    }
    return { pending: rows.length, chained, today, week };
  }, [rows, chains]);

  function currentStep(id: string): number {
    const steps = chains[id] ?? [];
    for (let i = 0; i < steps.length; i++) if ((steps[i].status ?? '').toLowerCase() === 'pending') return i + 1;
    return steps.length;
  }

  // Drop ids that no longer correspond to a pending row (after a reload) so a
  // stale selection can't linger or be re-approved.
  useEffect(() => {
    setSelected((prev) => {
      const live = new Set(rows.map((r) => r.id));
      const next = new Set([...prev].filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const allSelected = sorted.length > 0 && selected.size === sorted.length;
  function toggleSelectAll() {
    setSelected(allSelected ? new Set() : new Set(sorted.map((b) => b.id)));
  }

  // Approve every selected booking in sequence. Sequential (not parallel) so the
  // server processes one chain transition at a time and a mid-batch failure
  // reports an accurate count instead of a thundering herd.
  async function approveSelected() {
    const ids = sorted.filter((b) => selected.has(b.id)).map((b) => b.id);
    if (!ids.length) return;
    setBulkBusy(true);
    let ok = 0; const failed: string[] = [];
    for (const id of ids) {
      try { await api.approveBooking(id, ''); ok++; }
      catch { failed.push(id); }
    }
    setBulkBusy(false);
    setSelected(new Set());
    if (failed.length) {
      toast.error(
        t('approvals.bulkPartial', { ok, fail: failed.length, defaultValue: `${ok} approved, ${failed.length} failed` }),
      );
    } else {
      toast.success(t('approvals.bulkApproved', { count: ok, defaultValue: `${ok} bookings approved` }));
    }
    await load();
  }

  async function onApprove(b: any) {
    setBusyId(b.id);
    try {
      await api.approveBooking(b.id, '');
      // If chain → reload to show progress; if single-level → drop the row.
      if ((chains[b.id] ?? []).length > 0) await load();
      else setRows((r) => r.filter((x) => x.id !== b.id));
    } catch (e: any) { toast.error(t('approvals.approvalFailed'), e.displayMessage); }
    finally { setBusyId(null); }
  }

  async function confirmReject() {
    if (!rejecting || !rejectReason.trim()) return;
    setBusyId(rejecting.id);
    try {
      await api.rejectBooking(rejecting.id, rejectReason);
      setRows((r) => r.filter((x) => x.id !== rejecting.id));
      setRejecting(null); setRejectReason('');
    } catch (e: any) { toast.error(t('approvals.rejectFailed'), e.displayMessage); }
    finally { setBusyId(null); }
  }

  async function confirmDelegate() {
    if (!delegating || !delegateTo) return;
    setBusyId(delegating.id);
    try {
      await api.delegateBooking(delegating.id, delegateTo, delegateReason);
      setDelegating(null); setDelegateTo(''); setDelegateReason('');
      await load();
    } catch (e: any) { toast.error(t('approvals.delegateFailed'), e.displayMessage); }
    finally { setBusyId(null); }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{t('approvals.title')}</h1>
          <p className="muted">{t('approvals.pendingDecision')}</p>
        </div>
        <button className="btn-fsd ghost" onClick={load}><RefreshCcw size={14}/> {t('common.refresh')}</button>
      </div>

      {!loading && rows.length > 0 && (
        <div className="stat-strip">
          <div className="stat"><small>{t('approvals.statPending')}</small><b>{stats.pending}</b></div>
          <div className="stat"><small>{t('approvals.statChains')}</small><b>{stats.chained}</b></div>
          <div className="stat"><small>{t('common.today')}</small><b>{stats.today}</b></div>
          <div className="stat"><small>{t('approvals.statThisWeek')}</small><b>{stats.week}</b></div>
        </div>
      )}

      {loading && <p className="muted">{t('common.loading')}</p>}
      {!loading && rows.length === 0 && <p className="muted">{t('approvals.nonePending')}</p>}

      {!loading && rows.length > 0 && (
        <div className="bulk-bar">
          <label className="bulk-select-all">
            <input type="checkbox" checked={allSelected}
                   ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected; }}
                   onChange={toggleSelectAll} disabled={bulkBusy} />
            <span>{selected.size > 0
              ? t('approvals.selectedCount', { count: selected.size, defaultValue: `${selected.size} selected` })
              : t('approvals.selectAll', { defaultValue: 'Select all' })}</span>
          </label>
          {selected.size > 0 && (
            <button className="btn-fsd" disabled={bulkBusy}
                    style={{ background: 'var(--fsd-success)', borderColor: 'var(--fsd-success)' }}
                    onClick={approveSelected}>
              <Check size={14}/> {t('approvals.approveSelected', { count: selected.size, defaultValue: `Approve ${selected.size} selected` })}
            </button>
          )}
        </div>
      )}

      {sorted.map((b) => {
        const steps = chains[b.id] ?? [];
        const r = resourceMap[b.resourceId];
        return (
          <article key={b.id} className={`fsd-card approval-card${selected.has(b.id) ? ' selected' : ''}`}>
            <label className="approval-check" aria-label={t('approvals.selectOne', { defaultValue: 'Select booking' })}>
              <input type="checkbox" checked={selected.has(b.id)}
                     onChange={() => toggleSelect(b.id)} disabled={bulkBusy} />
            </label>
            <div className="thumb"><Clock size={18} color="white"/></div>
            <div className="approval-info">
              <div className="row gap-sm" style={{ alignItems: 'baseline' }}>
                {/* The booking request title is the headline — an approver judges
                    "what is this meeting", not just which room. The room name moves
                    into the meta row below (it was the only thing shown before, so
                    the title was missing entirely — QA #12). */}
                <h3 className="truncate">{b.title || r?.name || b.resourceId}</h3>
                <span className="tag warning">{b.status}</span>
                {steps.length > 0 && (
                  <span className="tag info">
                    <GitBranch size={11}/> {t('approvals.chainStep', { current: currentStep(b.id), total: steps.length })}
                  </span>
                )}
              </div>
              <div className="muted text-sm row gap-sm" style={{ flexWrap: 'wrap' }}>
                <span><Building2 size={11}/> {r?.name || b.resourceId}</span>
                <span><CalendarDays size={11}/> {new Date(b.startTime).toLocaleDateString()}</span>
                <span><Clock size={11}/> {new Date(b.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – {new Date(b.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span><User size={11}/> {b.userName || b.userId}</span>
                {b.delegatedToName && (
                  <span className="tag info" {...tip(t('approvals.delegatedToHelp', { defaultValue: 'This approval has been delegated.' }))}>
                    <UserCog size={11}/> {t('approvals.delegatedTo', { name: b.delegatedToName, defaultValue: `Delegated to ${b.delegatedToName}` })}
                  </span>
                )}
              </div>
              {steps.length > 0 && <div style={{ marginTop: 8 }}><ApprovalTimeline steps={steps} submittedAt={b.createdAt}/></div>}
            </div>
            <div className="row gap-sm approval-actions">
              <button className="btn-fsd ghost" disabled={busyId === b.id || bulkBusy}
                      onClick={() => setContextFor(b)}>
                <CalendarClock size={13}/> {t('approvals.viewContext')}
              </button>
              <button className="btn-fsd ghost" disabled={busyId === b.id || bulkBusy}
                      onClick={() => { setDelegating(b); setDelegateTo(''); setDelegateReason(''); }}>
                <UserCog size={13}/> {t('approvals.delegate')}
              </button>
              <button className="btn-fsd danger" disabled={busyId === b.id || bulkBusy}
                      onClick={() => { setRejecting(b); setRejectReason(''); }}>
                <X size={13}/> {t('approvals.reject')}
              </button>
              <button className="btn-fsd" style={{ background: 'var(--fsd-success)', borderColor: 'var(--fsd-success)' }}
                      disabled={busyId === b.id || bulkBusy} onClick={() => onApprove(b)}>
                <Check size={13}/> {t('approvals.approve')}
              </button>
            </div>
          </article>
        );
      })}

      {rejecting && (
        <Modal title={t('approvals.rejectBooking')} onClose={() => setRejecting(null)} footer={<>
          <button className="btn-fsd ghost" onClick={() => setRejecting(null)}>{t('common.cancel')}</button>
          <button className="btn-fsd danger" disabled={!rejectReason.trim()} onClick={confirmReject}>
            <X size={13}/> {t('approvals.reject')}
          </button>
        </>}>
          <p className="muted text-sm">{t('approvals.reasonRequired')}</p>
          <label>{t('approvals.reason')}
            <textarea rows={3} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="e.g. Room reserved for board meeting"/>
          </label>
        </Modal>
      )}

      {delegating && (
        <Modal title={t('approvals.delegateApproval')} onClose={() => setDelegating(null)} footer={<>
          <button className="btn-fsd ghost" onClick={() => setDelegating(null)}>{t('common.cancel')}</button>
          <button className="btn-fsd" disabled={!delegateTo} onClick={confirmDelegate}>
            <UserCog size={13}/> {t('approvals.delegate')}
          </button>
        </>}>
          <p className="muted text-sm">{t('approvals.delegateHelp')}</p>
          <label>{t('approvals.delegateTo')}
            <ApproverSearch onSelect={setDelegateTo} placeholder={t('approvals.selectApprover')} />
          </label>
          <label>{t('approvals.reasonOptional')}
            <textarea rows={2} value={delegateReason} onChange={(e) => setDelegateReason(e.target.value)}
                      placeholder="e.g. On leave — please cover"/>
          </label>
        </Modal>
      )}

      {contextFor && (
        <ScheduleContext
          booking={contextFor}
          resourceName={resourceMap[contextFor.resourceId]?.name || contextFor.resourceId}
          onClose={() => setContextFor(null)}
        />
      )}
    </div>
  );
}
