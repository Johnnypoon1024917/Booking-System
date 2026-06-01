import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCcw, Plus, Calendar, CalendarDays, Clock, Link as LinkIcon,
  Pencil, Trash2, Save, Repeat, Search, ChevronLeft, ChevronRight,
  AlertTriangle, Loader2,
} from 'lucide-react';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { useT } from '../hooks/useT';
import { Skeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { ApprovalTimeline } from '../components/ApprovalTimeline';
import { promptDialog, confirmDialog } from '../stores/confirm';
import { useTimezone } from '../hooks/useTimezone';
import { utcToZonedDatetimeLocal, zonedDatetimeLocalToUtcIso } from '../utils/datetime';

// Direct port of v1's MyBookings.vue: header actions, stat strip, filter
// tabs (Upcoming / Pending / Past) with counts, status-strip cards with
// recurring tag + join-meeting link + inline approval timeline, and an
// edit modal for rescheduling / updating the meeting URL.
type Bucket = 'upcoming' | 'pending' | 'past';

interface EditState {
  id: string;
  title: string;
  start: string;
  end: string;
  meetingUrl: string;
  // Service add-ons (Catering, IT setup, …) — now editable after creation so a
  // booker can add catering days later without cancelling and re-booking.
  services: string[];
  // Recurrence context: when the booking belongs to a series the modal offers a
  // "this occurrence vs entire series" scope choice (Outlook/Teams parity).
  isRecurring: boolean;
  recurrenceId?: string;
  scope: 'single' | 'series';
  // Read-only context shown in the modal header (QA #6).
  resourceName: string;
  status: string;
  startISO: string;
}

// Pre-defined service add-ons — matches BookingModal's create-time list so the
// edit modal offers the same options the booking was created with.
const SERVICE_OPTIONS = ['Catering', 'IT setup', 'AV equipment', 'Whiteboard'];

export function MyBookings() {
  const nav = useNavigate();
  const toast = useToast();
  const { t, i18n } = useT();
  const tz = useTimezone();

  const [items, setItems] = useState<any[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [chains, setChains] = useState<Record<string, any[]>>({});
  // Tracks pending bookings whose approval chain failed to load, so the UI can
  // show "couldn't load" instead of silently hiding the timeline (which made a
  // Pending booking look like it had no approvers).
  const [chainErrors, setChainErrors] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Bucket>('upcoming');
  const [editing, setEditing] = useState<EditState | null>(null);
  // Local search + pagination keep the Past tab usable: the backend caps the
  // list at 200, but rendering 200 heavy cards at once lags the DOM and buries
  // the booking the user actually wants. Filter by title/room, then page in 10s.
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const [list, res] = await Promise.all([
        api.myBookings(),
        api.resources().catch(() => []),
      ]);
      setItems(list || []);
      setResources(res || []);
      // Pull chain progress for anything still awaiting approval so the
      // requester can see exactly where it is stuck.
      const next: Record<string, any[]> = {};
      const errs: Record<string, boolean> = {};
      await Promise.all((list || [])
        .filter((b: any) => b.status === 'Pending Approval')
        .map(async (b: any) => {
          // Distinguish a genuinely empty chain from a failed fetch: on error
          // flag it so the card can say so rather than render nothing.
          try { next[b.id] = (await api.approvalChain(b.id)) || []; }
          catch { errs[b.id] = true; }
        }));
      setChains(next);
      setChainErrors(errs);
    } catch (e: any) {
      toast.error('Could not load', e.displayMessage || e.message);
    } finally { setLoading(false); }
  }

  const resourceMap = useMemo(
    () => Object.fromEntries(resources.map((r) => [r.id, r])),
    [resources],
  );

  const counts = useMemo(() => {
    const c = { total: items.length, upcoming: 0, pending: 0, past: 0 };
    for (const b of items) c[bucket(b)]++;
    return c;
  }, [items]);

  const tabs: { key: Bucket; label: string; count: number }[] = [
    { key: 'upcoming', label: t('myBookings.upcoming'), count: counts.upcoming },
    { key: 'pending', label: t('myBookings.pending'), count: counts.pending },
    { key: 'past', label: t('myBookings.past'), count: counts.past },
  ];

  const filtered = useMemo(
    () => items.filter((b) => bucket(b) === filter),
    [items, filter],
  );

  // Case-insensitive match on title or resource name. resourceName() is hoisted
  // (function declaration) so it's safe to call here.
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return filtered;
    return filtered.filter((b) =>
      (b.title || '').toLowerCase().includes(q) || resourceName(b).toLowerCase().includes(q));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, query, resourceMap]);

  const pageCount = Math.max(1, Math.ceil(searched.length / PAGE_SIZE));
  // Reset to the first page on filter/search change, and clamp if the list
  // shrank under us (e.g. a cancellation removed the last item on this page).
  useEffect(() => { setPage(1); }, [filter, query]);
  useEffect(() => { if (page > pageCount) setPage(pageCount); }, [page, pageCount]);
  const pageItems = useMemo(
    () => searched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [searched, page],
  );

  async function save() {
    if (!editing) return;
    // Client-side guards mirror what Teams/Outlook enforce before "Save" is even
    // clickable, so we don't round-trip an obviously-invalid edit just to bounce
    // off the backend 409 with a red toast.
    if (!editing.title.trim()) { toast.warning(t('bookingModal.titleRequired')); return; }
    // start/end are fixed-width 'YYYY-MM-DDTHH:mm' tenant-zone wall-clock, so a
    // lexicographic compare is a valid chronological compare.
    if (editing.start >= editing.end) { toast.warning(t('myBookings.endAfterStart')); return; }

    setBusy(true);
    try {
      const payload = {
        title: editing.title,
        // editing.start/end are wall-clock 'YYYY-MM-DDTHH:mm' in the TENANT
        // zone (see the edit button) — convert back through the same zone, not
        // the browser's, so the saved instant matches what the user edited.
        startTime: zonedDatetimeLocalToUtcIso(editing.start, tz.tz),
        endTime: zonedDatetimeLocalToUtcIso(editing.end, tz.tz),
        meetingUrl: editing.meetingUrl,
        services: editing.services,
      };
      if (editing.isRecurring && editing.scope === 'series') {
        // Edit the whole series: future, non-settled occurrences shift by the
        // same delta and pick up the new title/URL/services. Per-occurrence
        // clashes are skipped and reported rather than aborting the batch.
        const r = await api.updateBookingSeries(editing.id, payload);
        if (r?.skipped?.length) {
          toast.warning(
            t('bookingModal.seriesUpdated', { count: r.updated ?? 0 }),
            t('bookingModal.seriesUpdateSkipped', { count: r.skipped.length }),
          );
        } else {
          toast.success(t('bookingModal.seriesUpdated', { count: r?.updated ?? 0 }));
        }
      } else {
        await api.updateBooking(editing.id, payload);
        toast.success(t('common.saved'));
      }
      setEditing(null);
      load();
    } catch (e: any) {
      toast.error('Update failed', e.displayMessage || e.message);
    } finally { setBusy(false); }
  }

  async function onCancel(b: any) {
    // Recurring bookings need a scope choice first (Outlook/Teams parity): a
    // bare "Cancel" on a series instance must not silently delete just one day
    // when the user meant the whole series — or vice-versa. The reason prompt
    // that follows still lets them back out entirely (returns null).
    let series = false;
    if (b.isRecurring && b.recurrenceId) {
      series = await confirmDialog({
        title: t('myBookings.recurringCancelTitle'),
        message: t('myBookings.recurringCancelMessage'),
        confirmText: t('myBookings.cancelSeries'),
        cancelText: t('myBookings.cancelOccurrence'),
        tone: 'danger',
      });
    }
    const reason = await promptDialog({
      title: t('myBookings.cancelReason'),
      inputLabel: t('approvals.reason'),
      placeholder: 'e.g. No longer needed',
      multiline: true,
      confirmText: t('myBookings.cancelReason'),
      cancelText: t('common.cancel'),
      tone: 'danger',
    });
    if (reason === null) return;
    try {
      if (series) {
        await api.cancelRecurringSeries(b.recurrenceId, reason || 'cancelled by user');
      } else {
        await api.cancelBooking(b.id, reason || 'cancelled by user');
      }
      toast.success(t('myBookings.cancelled'));
      load();
    } catch (e: any) {
      toast.error('Cancel failed', e.displayMessage || e.message);
    }
  }

  // Re-queue a booking whose calendar (Outlook/Google) push permanently failed.
  // Optimistically flip the card to "syncing" then reload so the warning clears
  // once the outbox drains. id-keyed busy flag so only the clicked row spins.
  const [retrying, setRetrying] = useState<Record<string, boolean>>({});
  async function retrySync(b: any) {
    setRetrying((m) => ({ ...m, [b.id]: true }));
    try {
      await api.retryBookingSync(b.id);
      toast.success(t('myBookings.syncRetrying', { defaultValue: 'Re-syncing to your calendar…' }));
      // Reflect the optimistic 'pending' immediately; a later load() confirms.
      setItems((arr) => arr.map((x) => (x.id === b.id ? { ...x, syncStatus: 'pending' } : x)));
    } catch (e: any) {
      toast.error(t('myBookings.syncRetryFailed', { defaultValue: 'Could not retry sync' }), e.displayMessage || e.message);
    } finally {
      setRetrying((m) => ({ ...m, [b.id]: false }));
    }
  }

  // The step a pending booking is currently waiting on, for the status-badge
  // tooltip ("Waiting on Step 1: Security Admin").
  function pendingTooltip(b: any): string | undefined {
    if (b.status !== 'Pending Approval') return undefined;
    const steps = chains[b.id] || [];
    const pending = steps.find((s: any) => (s.status ?? 'pending') === 'pending');
    if (!pending) return undefined;
    const who = pending.approverRole || pending.levelName || '';
    const step = (pending.stepIndex ?? 0) + 1;
    return t('myBookings.waitingOnStep', {
      step, who,
      defaultValue: who ? `Waiting on Step ${step}: ${who}` : `Waiting on Step ${step}`,
    });
  }

  // Prefer the resource name the API now denormalises onto the booking, then
  // the locally-loaded catalogue. Never fall back to the raw resource UUID —
  // an officer who cannot list every resource would otherwise see a
  // meaningless GUID as the booking heading (QA #7).
  function resourceName(b: any) {
    return b.resourceName || resourceMap[b.resourceId]?.name || t('booking.untitled');
  }
  function formatDate(d: string) {
    return new Date(d).toLocaleDateString(i18n.language, {
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    });
  }
  // Render booking times in the tenant's zone with an explicit offset suffix,
  // not the browser's zone — a viewer in a different region must see the
  // room's local time, clearly labelled.
  function formatTime(d: string) {
    return tz.formatTime(d);
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{t('myBookings.title')}</h1>
          <p className="muted">{t('myBookings.subtitle')}</p>
        </div>
        <div className="row gap-sm">
          <button className="btn-fsd ghost" onClick={load}><RefreshCcw size={14}/> {t('common.refresh')}</button>
          <button className="btn-fsd" onClick={() => nav('/search')}><Plus size={14}/> {t('dashboard.newBooking')}</button>
        </div>
      </div>

      {!loading && items.length > 0 && (
        <div className="stat-strip">
          <div className="stat"><small>{t('myBookings.total')}</small><b>{counts.total}</b></div>
          <div className="stat"><small>{t('myBookings.upcoming')}</small><b>{counts.upcoming}</b></div>
          <div className="stat"><small>{t('myBookings.pending')}</small><b>{counts.pending}</b></div>
          <div className="stat"><small>{t('myBookings.past')}</small><b>{counts.past}</b></div>
        </div>
      )}

      <div className="row gap-sm mybk-toolbar" style={{ margin: '14px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        {tabs.map((tb) => (
          <button key={tb.key} className={`btn-fsd ${filter === tb.key ? '' : 'ghost'}`}
                  onClick={() => setFilter(tb.key)}>
            {tb.label} <span className="muted" style={{ marginLeft: 6 }}>{tb.count}</span>
          </button>
        ))}
        <div className="mybk-search">
          <Search size={14} className="muted" />
          <input value={query} onChange={(e) => setQuery(e.target.value)}
                 placeholder={t('myBookings.searchPlaceholder')} aria-label={t('myBookings.searchPlaceholder')} />
        </div>
      </div>

      {loading && (
        <div>
          {[0, 1, 2, 3].map((n) => (
            <div key={n} className="fsd-card" style={{ marginBottom: 12 }}><Skeleton height="60px"/></div>
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <EmptyState icon={Calendar} title={t('myBookings.empty')}
          actions={<button className="btn-fsd" onClick={() => nav('/search')}>{t('dashboard.createFirst')}</button>}
        />
      )}

      {/* Bookings exist in this bucket but the search filtered them all out. */}
      {!loading && filtered.length > 0 && searched.length === 0 && (
        <p className="muted" style={{ marginTop: 16 }}>{t('myBookings.noMatches')}</p>
      )}

      {!loading && pageItems.map((b) => {
        const canMutate = b.status !== 'Cancelled' && b.status !== 'No Show' && new Date(b.endTime) > new Date();
        const steps = chains[b.id] || [];
        const chainFailed = !!chainErrors[b.id];
        return (
          <article key={b.id} className="fsd-card my-card">
            <div className="strip" style={{ background: stripColor(b.status) }} />
            <div style={{ minWidth: 0 }}>
              <div className="row gap-sm" style={{ alignItems: 'baseline' }}>
                <h3 className="truncate">{resourceName(b)}</h3>
                <span className={`tag ${statusClass(b.status)}`} title={pendingTooltip(b)}>{b.status}</span>
                {b.isRecurring && <span className="tag info"><Repeat size={11}/> {t('myBookings.recurring')}</span>}
              </div>
              <div className="muted text-sm row gap-sm" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                <span><CalendarDays size={11}/> {formatDate(b.startTime)}</span>
                <span><Clock size={11}/> {formatTime(b.startTime)} – {formatTime(b.endTime)}</span>
                {b.redirectUrl && (
                  <span><LinkIcon size={11}/> <a href={b.redirectUrl} target="_blank" rel="noreferrer">{t('myBookings.joinMeeting')}</a></span>
                )}
              </div>
              {steps.length > 0 && (
                <div style={{ marginTop: 8 }}><ApprovalTimeline compact steps={steps}/></div>
              )}
              {/* Calendar-sync failure: the booking is Confirmed in our DB but
                  the push to Outlook/Google permanently failed (e.g. the room
                  mailbox rejected it), so it will never appear on the user's
                  Outlook calendar. Surface it loudly with a one-click retry,
                  rather than burying it in a backend log (enterprise #1). */}
              {b.syncStatus === 'failed' && (
                <div className="row gap-sm" style={{ marginTop: 8, alignItems: 'center', color: 'var(--danger)' }}>
                  <AlertTriangle size={14} />
                  <span className="text-sm">{t('myBookings.syncFailed', { defaultValue: 'Failed to sync to Outlook/Google.' })}</span>
                  <button className="btn-fsd ghost" style={{ padding: '2px 8px' }}
                          disabled={!!retrying[b.id]} onClick={() => retrySync(b)}>
                    {retrying[b.id] ? <Loader2 size={12} className="spin" /> : <RefreshCcw size={12} />}
                    {' '}{t('myBookings.syncRetry', { defaultValue: 'Retry' })}
                  </button>
                </div>
              )}
              {b.status === 'Pending Approval' && steps.length === 0 && chainFailed && (
                <div className="muted text-sm" style={{ marginTop: 8 }}>
                  <button className="btn-fsd ghost" style={{ padding: '2px 8px' }} onClick={() => load()}>
                    {t('myBookings.approvalLoadFailed')}
                  </button>
                </div>
              )}
            </div>
            <div className="row gap-sm" style={{ flexShrink: 0 }}>
              {canMutate && (
                <button className="btn-fsd ghost" aria-label={t('myBookings.edit')} title={t('myBookings.edit')} onClick={() => setEditing({
                  id: b.id, title: b.title || '',
                  start: utcToZonedDatetimeLocal(b.startTime, tz.tz), end: utcToZonedDatetimeLocal(b.endTime, tz.tz), meetingUrl: b.meetingUrl || '',
                  services: Array.isArray(b.services) ? b.services : [],
                  isRecurring: !!b.isRecurring, recurrenceId: b.recurrenceId, scope: 'single',
                  resourceName: resourceName(b), status: b.status, startISO: b.startTime,
                })}><Pencil size={13}/></button>
              )}
              {canMutate && (
                <button className="btn-fsd ghost danger" aria-label={t('common.cancel')} title={t('common.cancel')} onClick={() => onCancel(b)}><Trash2 size={13}/></button>
              )}
            </div>
          </article>
        );
      })}

      {!loading && pageCount > 1 && (
        <div className="row gap-sm mybk-pager" style={{ justifyContent: 'center', alignItems: 'center', marginTop: 16 }}>
          <button className="btn-fsd ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-label={t('common.prev')}><ChevronLeft size={14} /></button>
          <span className="muted text-sm">{t('myBookings.pageOf', { page, total: pageCount })}</span>
          <button className="btn-fsd ghost" disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                  aria-label={t('common.next')}><ChevronRight size={14} /></button>
        </div>
      )}

      {editing && (
        <Modal title={t('myBookings.edit')} onClose={() => setEditing(null)} footer={<>
          <button className="btn-fsd ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
          <button className="btn-fsd" disabled={busy} onClick={save}>
            {busy ? <Loader2 size={13} className="spin"/> : <Save size={13}/>} {t('common.save')}
          </button>
        </>}>
          {/* Read-only context so the edit modal isn't a bare date/URL form
              with no indication of what's being edited (QA #6). */}
          <div className="muted text-sm" style={{ marginBottom: 12 }}>
            <div><strong>{editing.resourceName}</strong></div>
            <div className="row gap-sm" style={{ flexWrap: 'wrap', marginTop: 4 }}>
              <span><CalendarDays size={11}/> {formatDate(editing.startISO)}</span>
              <span className={`tag ${statusClass(editing.status)}`}>{editing.status}</span>
            </div>
          </div>

          {/* Recurring-series scope (Outlook/Teams "this event vs entire
              series"). Drives whether save() hits updateBooking or
              updateBookingSeries. */}
          {editing.isRecurring && (
            <div className="field bm-box" style={{ marginBottom: 12 }}>
              <div className="row gap-sm" style={{ alignItems: 'center' }}>
                <Repeat size={13}/>
                <span className="text-sm">{t('bookingModal.editScopeLabel')}</span>
              </div>
              <div className="seg" role="radiogroup" aria-label={t('bookingModal.editScopeLabel')} style={{ marginTop: 6 }}>
                <button type="button" className={`seg-btn${editing.scope === 'single' ? ' active' : ''}`}
                        role="radio" aria-checked={editing.scope === 'single'}
                        onClick={() => setEditing({ ...editing, scope: 'single' })}>
                  {t('bookingModal.editScopeThis')}
                </button>
                <button type="button" className={`seg-btn${editing.scope === 'series' ? ' active' : ''}`}
                        role="radio" aria-checked={editing.scope === 'series'}
                        onClick={() => setEditing({ ...editing, scope: 'series' })}>
                  {t('bookingModal.editScopeSeries')}
                </button>
              </div>
              {editing.scope === 'series' && (
                <small className="muted" style={{ display: 'block', marginTop: 6 }}>
                  {t('bookingModal.editScopeSeriesHint')}
                </small>
              )}
            </div>
          )}

          <label>{t('booking.title')}
            <input value={editing.title} placeholder="e.g. Weekly Team Sync"
                   onChange={(e) => setEditing({ ...editing, title: e.target.value })}/>
          </label>
          <div className="grid-2" style={{ marginTop: 12 }}>
            <label>{t('search.start')}
              <input type="datetime-local" value={editing.start}
                     onChange={(e) => setEditing({ ...editing, start: e.target.value })}/>
            </label>
            <label>{t('search.end')}
              <input type="datetime-local" value={editing.end}
                     onChange={(e) => setEditing({ ...editing, end: e.target.value })}/>
            </label>
          </div>
          <label style={{ marginTop: 12 }}>{t('booking.meetingURL')}
            <input value={editing.meetingUrl} placeholder="https://teams.microsoft.com/…"
                   onChange={(e) => setEditing({ ...editing, meetingUrl: e.target.value })}/>
          </label>

          {/* Service add-ons are now editable post-creation — add Catering days
              later without cancelling and re-booking the room (QA: enterprise
              gap #2). */}
          <div className="field" style={{ marginTop: 12 }}>
            <label>{t('bookingModal.services')}</label>
            <div className="chip-grid">
              {SERVICE_OPTIONS.map((opt) => (
                <label key={opt} className="dep-chip">
                  <input type="checkbox" checked={editing.services.includes(opt)}
                         onChange={() => setEditing({
                           ...editing,
                           services: editing.services.includes(opt)
                             ? editing.services.filter((s) => s !== opt)
                             : [...editing.services, opt],
                         })}/>
                  {opt}
                </label>
              ))}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function bucket(b: any): Bucket {
  // Cancelled / No Show bookings are inactive — they must never count as
  // "upcoming" even when their slot is still in the future. Group them with
  // past/historical so the Upcoming tab only shows actionable reservations.
  if (b.status === 'Cancelled' || b.status === 'No Show') return 'past';
  // Evaluate expiration BEFORE the Pending check: a request whose slot has
  // already elapsed is dead, not actionable, so it belongs in Past — otherwise
  // un-actioned approvals pile up in the Pending tab forever ("zombie" bookings).
  if (new Date(b.endTime) < new Date()) return 'past';
  if (b.status === 'Pending Approval') return 'pending';
  return 'upcoming';
}
function statusClass(s: string) {
  if (s === 'Confirmed' || s === 'Checked In') return 'success';
  if (s === 'Pending Approval') return 'warning';
  if (s === 'No Show' || s === 'Cancelled') return 'danger';
  return '';
}
function stripColor(s: string) {
  if (s === 'Confirmed' || s === 'Checked In') return 'var(--success)';
  if (s === 'Pending Approval') return 'var(--warning)';
  if (s === 'Cancelled' || s === 'No Show') return 'var(--text-muted)';
  return 'var(--brand-primary)';
}
