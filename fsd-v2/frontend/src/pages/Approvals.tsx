import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCcw, Check, X, Clock, CalendarDays, User, UserCog, GitBranch, Search } from 'lucide-react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { ApprovalTimeline } from '../components/ApprovalTimeline';
import { useT } from '../hooks/useT';
import { useToast } from '../stores/toast';

// Async typeahead for the delegate picker. Queries the directory search
// endpoint (capped, server-side) instead of rendering every user as a DOM
// <option> — a full <select> of a 5,000-employee tenant freezes the tab.
function ApproverSearch({ onSelect, placeholder }: { onSelect: (id: string) => void; placeholder: string }) {
  const { t } = useT();
  const [text, setText] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="typeahead" ref={boxRef}>
      <div className="typeahead-input">
        <Search size={14} className="muted" />
        <input
          value={text}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          // Editing after a pick invalidates the selection so a stale id can't
          // be submitted under a different visible name.
          onChange={(e) => { setText(e.target.value); onSelect(''); setOpen(true); }}
        />
      </div>
      {open && (
        <div className="typeahead-menu">
          {loading && <div className="typeahead-empty muted text-sm">{t('common.loading')}</div>}
          {!loading && results.length === 0 && <div className="typeahead-empty muted text-sm">{t('approvals.noMatches')}</div>}
          {!loading && results.map((u) => (
            <button type="button" key={u.id} className="typeahead-item" onClick={() => pick(u)}>
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

      {sorted.map((b) => {
        const steps = chains[b.id] ?? [];
        const r = resourceMap[b.resourceId];
        return (
          <article key={b.id} className="fsd-card approval-card">
            <div className="thumb"><Clock size={18} color="white"/></div>
            <div className="approval-info">
              <div className="row gap-sm" style={{ alignItems: 'baseline' }}>
                <h3 className="truncate">{r?.name || b.resourceId}</h3>
                <span className="tag warning">{b.status}</span>
                {steps.length > 0 && (
                  <span className="tag info">
                    <GitBranch size={11}/> {t('approvals.chainStep', { current: currentStep(b.id), total: steps.length })}
                  </span>
                )}
              </div>
              <div className="muted text-sm row gap-sm" style={{ flexWrap: 'wrap' }}>
                <span><CalendarDays size={11}/> {new Date(b.startTime).toLocaleDateString()}</span>
                <span><Clock size={11}/> {new Date(b.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} – {new Date(b.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                <span><User size={11}/> {b.userName || b.userId}</span>
              </div>
              {steps.length > 0 && <div style={{ marginTop: 8 }}><ApprovalTimeline steps={steps} submittedAt={b.createdAt}/></div>}
            </div>
            <div className="row gap-sm approval-actions">
              <button className="btn-fsd ghost" disabled={busyId === b.id}
                      onClick={() => { setDelegating(b); setDelegateTo(''); setDelegateReason(''); }}>
                <UserCog size={13}/> {t('approvals.delegate')}
              </button>
              <button className="btn-fsd danger" disabled={busyId === b.id}
                      onClick={() => { setRejecting(b); setRejectReason(''); }}>
                <X size={13}/> {t('approvals.reject')}
              </button>
              <button className="btn-fsd" style={{ background: 'var(--fsd-success)', borderColor: 'var(--fsd-success)' }}
                      disabled={busyId === b.id} onClick={() => onApprove(b)}>
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
    </div>
  );
}
