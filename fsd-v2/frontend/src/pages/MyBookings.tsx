import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCcw, Plus, Calendar, CalendarDays, Clock, Link as LinkIcon,
  Pencil, Trash2, Save, Repeat,
} from 'lucide-react';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { useT } from '../hooks/useT';
import { Skeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { ApprovalTimeline } from '../components/ApprovalTimeline';
import { promptDialog } from '../stores/confirm';

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
  // Read-only context shown in the modal header (QA #6).
  resourceName: string;
  status: string;
  startISO: string;
}

export function MyBookings() {
  const nav = useNavigate();
  const toast = useToast();
  const { t, i18n } = useT();

  const [items, setItems] = useState<any[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [chains, setChains] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Bucket>('upcoming');
  const [editing, setEditing] = useState<EditState | null>(null);

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
      await Promise.all((list || [])
        .filter((b: any) => b.status === 'Pending Approval')
        .map(async (b: any) => {
          try { next[b.id] = (await api.approvalChain(b.id)) || []; }
          catch { next[b.id] = []; }
        }));
      setChains(next);
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

  async function save() {
    if (!editing) return;
    setBusy(true);
    try {
      await api.updateBooking(editing.id, {
        title: editing.title,
        startTime: new Date(editing.start).toISOString(),
        endTime: new Date(editing.end).toISOString(),
        meetingUrl: editing.meetingUrl,
      });
      toast.success(t('common.saved'));
      setEditing(null);
      load();
    } catch (e: any) {
      toast.error('Update failed', e.displayMessage || e.message);
    } finally { setBusy(false); }
  }

  async function onCancel(b: any) {
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
      await api.cancelBooking(b.id, reason || 'cancelled by user');
      toast.success(t('myBookings.cancelled'));
      load();
    } catch (e: any) {
      toast.error('Cancel failed', e.displayMessage || e.message);
    }
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
  function formatTime(d: string) {
    return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

      <div className="row gap-sm" style={{ margin: '14px 0' }}>
        {tabs.map((tb) => (
          <button key={tb.key} className={`btn-fsd ${filter === tb.key ? '' : 'ghost'}`}
                  onClick={() => setFilter(tb.key)}>
            {tb.label} <span className="muted" style={{ marginLeft: 6 }}>{tb.count}</span>
          </button>
        ))}
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

      {!loading && filtered.map((b) => {
        const canMutate = b.status !== 'Cancelled' && b.status !== 'No Show' && new Date(b.endTime) > new Date();
        const steps = chains[b.id] || [];
        return (
          <article key={b.id} className="fsd-card my-card">
            <div className="strip" style={{ background: stripColor(b.status) }} />
            <div style={{ minWidth: 0 }}>
              <div className="row gap-sm" style={{ alignItems: 'baseline' }}>
                <h3 className="truncate">{resourceName(b)}</h3>
                <span className={`tag ${statusClass(b.status)}`}>{b.status}</span>
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
            </div>
            <div className="row gap-sm" style={{ flexShrink: 0 }}>
              {canMutate && (
                <button className="btn-fsd ghost" aria-label={t('myBookings.edit')} title={t('myBookings.edit')} onClick={() => setEditing({
                  id: b.id, title: b.title || '',
                  start: toLocal(b.startTime), end: toLocal(b.endTime), meetingUrl: b.meetingUrl || '',
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

      {editing && (
        <Modal title={t('myBookings.edit')} onClose={() => setEditing(null)} footer={<>
          <button className="btn-fsd ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
          <button className="btn-fsd" disabled={busy} onClick={save}><Save size={13}/> {t('common.save')}</button>
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
  if (b.status === 'Pending Approval') return 'pending';
  if (new Date(b.endTime) < new Date()) return 'past';
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
function toLocal(iso: string) {
  const d = new Date(iso);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 16);
}
