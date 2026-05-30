import { useEffect, useMemo, useState } from 'react';
import { Calendar, RefreshCcw, Search as SearchIcon, X } from 'lucide-react';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { promptDialog } from '../stores/confirm';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { useT } from '../hooks/useT';

// Admin "all bookings" view — table of every booking in a date range,
// filtered by resource / status / free-text. Multi-select drives bulk
// actions (cancel, mark no-show, mark attended) which fan out to the
// per-booking endpoints so each one creates its own audit entry. This
// replaces v1's much heavier AdminBookings.vue but keeps the same
// status colour vocabulary so admins recognise the screen.
const STATUSES = ['Confirmed', 'Pending Approval', 'Cancelled', 'Checked In', 'No Show', 'Attended'];

function statusTagClass(s: string) {
  switch (s) {
    case 'Confirmed':
    case 'Attended':
      return 'ok';
    case 'Pending Approval':
      return 'warn';
    case 'Cancelled':
    case 'No Show':
      return 'bad';
    case 'Checked In':
      return 'brand';
    default:
      return '';
  }
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
function plusDays(d: string, days: number) {
  const dt = new Date(d + 'T00:00:00');
  dt.setDate(dt.getDate() + days);
  return dt.toISOString().slice(0, 10);
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function AdminBookings() {
  const { t } = useT();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [bookings, setBookings] = useState<any[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);

  const [rangeStart, setRangeStart] = useState(todayStr());
  const [rangeEnd, setRangeEnd] = useState(plusDays(todayStr(), 7));
  const [q, setQ] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => { load(); }, [rangeStart, rangeEnd]);

  async function load() {
    setLoading(true);
    setSelected(new Set());
    try {
      const startIso = new Date(rangeStart + 'T00:00:00').toISOString();
      const endIso   = new Date(rangeEnd   + 'T23:59:59').toISOString();
      const [bs, rs, us] = await Promise.all([
        api.adminBookings(startIso, endIso),
        api.adminResources().catch(() => []),
        api.users().catch(() => []),
      ]);
      setBookings(bs || []);
      setResources(rs || []);
      setUsers(us || []);
    } catch (e: any) {
      toast.error(t('adminBookings.loadFailed'), e.displayMessage || e.message);
    } finally { setLoading(false); }
  }

  const resourceById = useMemo(() => {
    const m: Record<string, any> = {};
    for (const r of resources) m[r.id || r.ID] = r;
    return m;
  }, [resources]);
  const userById = useMemo(() => {
    const m: Record<string, any> = {};
    for (const u of users) m[u.id || u.ID] = u;
    return m;
  }, [users]);

  function resourceName(id: string) {
    const r = resourceById[id];
    return r?.name || r?.Name || id || '—';
  }
  function userDisplay(id: string) {
    const u = userById[id];
    if (!u) return id || '—';
    return u.username || u.email || `${u.firstName || ''} ${u.lastName || ''}`.trim() || id;
  }

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return bookings.filter((b) => {
      const rId = b.resourceId || b.ResourceID;
      const uId = b.userId     || b.UserID;
      const st  = b.status     || b.Status;
      if (resourceFilter && rId !== resourceFilter) return false;
      if (statusFilter && st !== statusFilter) return false;
      if (query) {
        const hay = [
          b.title || b.Title || '',
          resourceName(rId).toLowerCase(),
          userDisplay(uId).toLowerCase(),
        ].join(' ');
        if (!hay.toLowerCase().includes(query)) return false;
      }
      return true;
    });
  }, [bookings, q, resourceFilter, statusFilter, resourceById, userById]);

  function toggleSelect(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  function toggleSelectAll() {
    setSelected((s) => (s.size === filtered.length
      ? new Set()
      : new Set(filtered.map((b) => b.id || b.ID))));
  }

  async function bulkCancel() {
    if (!selected.size) return;
    const reason = await promptDialog({
      title: t('adminBookings.cancelPrompt'),
      inputLabel: t('approvals.reason'),
      defaultValue: 'Admin bulk cancel',
      multiline: true,
      confirmText: t('adminBookings.cancelPrompt'),
      cancelText: t('common.cancel'),
      tone: 'danger',
    });
    if (reason === null) return;
    try {
      await api.bulkCancelBookings([...selected], reason || undefined);
      toast.success(t('adminBookings.cancelled', { n: selected.size }));
      load();
    } catch (e: any) { toast.error(t('adminBookings.bulkCancelFailed'), e.displayMessage || e.message); }
  }

  async function bulkNoShow() {
    if (!selected.size) return;
    const reason = await promptDialog({
      title: t('adminBookings.noShowPrompt'),
      inputLabel: t('approvals.reason'),
      defaultValue: 'No-show after grace period',
      multiline: true,
      confirmText: t('adminBookings.noShowPrompt'),
      cancelText: t('common.cancel'),
      tone: 'danger',
    });
    if (reason === null) return;
    try {
      for (const id of selected) await api.markBookingNoShow(id, reason);
      toast.success(t('adminBookings.markedNoShow', { n: selected.size }));
      load();
    } catch (e: any) { toast.error(t('adminBookings.bulkNoShowFailed'), e.displayMessage || e.message); }
  }

  async function bulkAttended() {
    if (!selected.size) return;
    try {
      for (const id of selected) await api.markBookingAttended(id);
      toast.success(t('adminBookings.markedAttended', { n: selected.size }));
      load();
    } catch (e: any) { toast.error(t('adminBookings.bulkAttendedFailed'), e.displayMessage || e.message); }
  }

  const STATUS_KEY: Record<string, string> = {
    'Confirmed': 'statusConfirmed',
    'Pending Approval': 'statusPending',
    'Cancelled': 'statusCancelled',
    'Checked In': 'statusCheckedIn',
    'No Show': 'statusNoShow',
    'Attended': 'statusAttended',
  };
  function statusLabel(s: string) {
    const k = STATUS_KEY[s];
    return k ? t(`adminBookings.${k}`) : s;
  }

  const allChecked = filtered.length > 0 && selected.size === filtered.length;

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>{t('adminBookings.title')}</h1>
          <p className="muted small">{t('adminBookings.subtitle')}</p>
        </div>
        <button className="btn ghost" onClick={load}><RefreshCcw size={14} /> {t('common.refresh')}</button>
      </header>

      <div className="card" style={{ padding: 12, marginBottom: 12 }}>
        <div className="row gap" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="row" style={{ gap: 6 }}>{t('adminBookings.from')}
            <input type="date" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} />
          </label>
          <label className="row" style={{ gap: 6 }}>{t('adminBookings.to')}
            <input type="date" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} />
          </label>
          <label className="row" style={{ gap: 6, flex: 1, minWidth: 200 }}>
            <SearchIcon size={14} className="muted" />
            <input placeholder={t('adminBookings.searchPh')}
                   value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
          </label>
          <select aria-label={t('adminBookings.allRooms')} value={resourceFilter} onChange={(e) => setResourceFilter(e.target.value)}>
            <option value="">{t('adminBookings.allRooms')}</option>
            {resources.map((r) => <option key={r.id || r.ID} value={r.id || r.ID}>{r.name || r.Name}</option>)}
          </select>
          <select aria-label={t('adminBookings.allStatuses')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">{t('adminBookings.allStatuses')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
          </select>
        </div>

        {selected.size > 0 && (
          <div className="row gap mt" style={{ alignItems: 'center', padding: '8px 0 0' }}>
            <b>{t('adminBookings.selected', { n: selected.size })}</b>
            <span className="spacer" />
            <button className="btn ghost" onClick={() => setSelected(new Set())}>
              <X size={13} /> {t('adminBookings.clear')}
            </button>
            <button className="btn" onClick={bulkAttended}>{t('adminBookings.markAttended')}</button>
            <button className="btn" onClick={bulkNoShow}>{t('adminBookings.markNoShow')}</button>
            <button className="btn danger" onClick={bulkCancel}>{t('adminBookings.cancelSelected')}</button>
          </div>
        )}
      </div>

      {loading ? (
        <div>
          {[1, 2, 3, 4, 5].map((n) => (
            <div key={n} className="card" style={{ padding: 12, marginBottom: 6 }}>
              <Skeleton height="32px" />
            </div>
          ))}
        </div>
      ) : !filtered.length ? (
        <EmptyState icon={Calendar} title={t('adminBookings.empty')}
                    description={t('adminBookings.emptyDesc')} />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 28 }}>
                <input type="checkbox" aria-label={t('adminBookings.selectAll')} checked={allChecked} onChange={toggleSelectAll} />
              </th>
              <th>{t('adminBookings.colTitle')}</th>
              <th>{t('adminBookings.colRoom')}</th>
              <th>{t('adminBookings.colUser')}</th>
              <th>{t('adminBookings.colStart')}</th>
              <th>{t('adminBookings.colEnd')}</th>
              <th>{t('common.status')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((b) => {
              const id  = b.id || b.ID;
              const rId = b.resourceId || b.ResourceID;
              const uId = b.userId     || b.UserID;
              const st  = b.status     || b.Status;
              return (
                <tr key={id} className={selected.has(id) ? 'row-selected' : ''}>
                  <td><input type="checkbox" aria-label={t('adminBookings.selectRow')} checked={selected.has(id)} onChange={() => toggleSelect(id)} /></td>
                  <td>{b.title || b.Title || <span className="muted">{t('adminBookings.untitled')}</span>}</td>
                  <td>{resourceName(rId)}</td>
                  <td>{userDisplay(uId)}</td>
                  <td>{fmtTime(b.startTime || b.StartTime)}</td>
                  <td>{fmtTime(b.endTime || b.EndTime)}</td>
                  <td><span className={`tag ${statusTagClass(st)}`}>{statusLabel(st)}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
