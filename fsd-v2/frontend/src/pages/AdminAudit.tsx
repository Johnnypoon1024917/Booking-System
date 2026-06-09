import { Fragment, useEffect, useMemo, useState } from 'react';
import { ScrollText, RefreshCcw, ShieldAlert, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import { useT } from '../hooks/useT';

// Admin audit log viewer. Reads the system-wide trail written by the global
// AuditInterceptor (every mutation + sensitive read) plus the rich per-handler
// and auth events. Filter by user/action/outcome/date, expand any row for the
// before/after diff and the originating device.

interface AuditEntry {
  id: string;
  username: string;
  userId?: string;
  action: string;
  severity: string;
  outcome: string;
  targetEntity?: string;
  targetId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  ip?: string;
  userAgent?: string;
  previous?: Record<string, any>;
  next?: Record<string, any>;
  createdAt: string;
}

const OUTCOMES = ['success', 'denied', 'failure'] as const;

export function AdminAudit() {
  const { t } = useT();
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  useEffect(() => { load(); loadActions(); /* eslint-disable-next-line */ }, []);

  async function load() {
    setLoading(true);
    try {
      setRows(await api.auditLog({
        q: q || undefined, action: action || undefined, outcome: outcome || undefined,
        from: from || undefined, to: to ? `${to}T23:59:59` : undefined, limit: 500,
      }));
    } finally { setLoading(false); }
  }

  async function loadActions() {
    try { setActions(await api.auditActions()); } catch { /* dropdown stays empty */ }
  }

  function reset() {
    setQ(''); setAction(''); setOutcome(''); setFrom(''); setTo('');
    // Reload with cleared filters on the next tick.
    setTimeout(() => load(), 0);
  }

  const hasFilters = useMemo(() => !!(q || action || outcome || from || to), [q, action, outcome, from, to]);

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminAudit.title')}</h1>
        <span className="muted small">{t('adminAudit.subtitle')}</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={load}><RefreshCcw size={14} /> {t('common.refresh')}</button>
      </header>

      <div className="filter-bar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <label>{t('adminAudit.search')}
          <input value={q} onChange={(e) => setQ(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && load()}
                 placeholder={t('adminAudit.searchPh')} />
        </label>
        <label>{t('adminAudit.action')}
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">{t('adminAudit.allActions')}</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label>{t('adminAudit.outcome')}
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            <option value="">{t('adminAudit.allOutcomes')}</option>
            {OUTCOMES.map((o) => <option key={o} value={o}>{t(`adminAudit.outcome_${o}`)}</option>)}
          </select>
        </label>
        <label>{t('adminAudit.from')}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>{t('adminAudit.to')}
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="btn primary" onClick={load}>{t('adminAudit.apply')}</button>
        {hasFilters && <button className="btn ghost" onClick={reset}>{t('adminAudit.clear')}</button>}
      </div>

      {loading ? <p className="muted">{t('common.loading')}</p>
       : rows.length === 0 ? (
        <div className="empty">
          <ScrollText size={32} />
          <p>{t('adminAudit.empty')}</p>
        </div>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 24 }}></th>
              <th>{t('adminAudit.colTime')}</th>
              <th>{t('adminAudit.colUser')}</th>
              <th>{t('adminAudit.colAction')}</th>
              <th>{t('adminAudit.colTarget')}</th>
              <th>{t('adminAudit.colOutcome')}</th>
              <th>{t('adminAudit.colIp')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const open = expanded === r.id;
              const hasDetail = !!(r.previous || r.next || r.userAgent || r.path);
              return (
                <Fragment key={r.id}>
                  <tr className={open ? 'expanded-row' : ''}
                      style={{ cursor: hasDetail ? 'pointer' : 'default' }}
                      onClick={() => hasDetail && setExpanded(open ? null : r.id)}>
                    <td>{hasDetail && (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}</td>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>{new Date(r.createdAt).toLocaleString()}</td>
                    <td>{r.username || <span className="muted">—</span>}</td>
                    <td><code className="small">{r.action}</code></td>
                    <td className="small muted">
                      {r.targetEntity ? `${r.targetEntity}${r.targetId ? ` · ${shortId(r.targetId)}` : ''}` : '—'}
                    </td>
                    <td><OutcomeBadge outcome={r.outcome} t={t} /></td>
                    <td className="small muted">{r.ip || '—'}</td>
                  </tr>
                  {open && (
                    <tr className="detail-row">
                      <td></td>
                      <td colSpan={6}>
                        <div className="audit-detail" style={{ display: 'grid', gap: 8, padding: '6px 0' }}>
                          {(r.method || r.path) && (
                            <div className="small">
                              <b>{t('adminAudit.request')}:</b> <code>{r.method} {r.path}</code>
                              {r.statusCode ? <span className="muted"> → {r.statusCode}</span> : null}
                            </div>
                          )}
                          {r.userAgent && (
                            <div className="small muted"><b>{t('adminAudit.device')}:</b> {r.userAgent}</div>
                          )}
                          {(r.previous || r.next) && (
                            <ChangeTable previous={r.previous} next={r.next} t={t} />
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OutcomeBadge({ outcome, t }: { outcome: string; t: (k: string) => string }) {
  const tone = outcome === 'success' ? '#1c8a4d'
    : outcome === 'denied' ? '#b8860b' : '#c0392b';
  const Icon = outcome === 'success' ? null : ShieldAlert;
  return (
    <span className="pill small" style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      color: tone, border: `1px solid ${tone}`, borderRadius: 999, padding: '1px 8px',
    }}>
      {Icon && <Icon size={11} />}
      {t(`adminAudit.outcome_${outcome}`) || outcome}
    </span>
  );
}

// Field-level change view: one row per column that moved, showing the exact
// before → after value. This is the government-facing "what changed" detail —
// the per-field diff written by the backend AuditSubscriber. Falls back to a
// single before/after pair for non-field payloads (e.g. an export descriptor).
function ChangeTable(
  { previous, next, t }:
  { previous?: Record<string, any>; next?: Record<string, any>; t: (k: string) => string },
) {
  const keys = Array.from(new Set([
    ...Object.keys(previous ?? {}),
    ...Object.keys(next ?? {}),
  ]));
  if (!keys.length) return null;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="data small" style={{ width: 'auto', minWidth: 320 }}>
        <thead>
          <tr>
            <th>{t('adminAudit.field') || 'Field'}</th>
            <th>{t('adminAudit.before')}</th>
            <th>{t('adminAudit.after')}</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const before = fmtVal(previous?.[k]);
            const after = fmtVal(next?.[k]);
            const changed = before !== after;
            return (
              <tr key={k}>
                <td><code className="small">{k}</code></td>
                <td className="small" style={{ color: changed ? '#c0392b' : undefined, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{before || <span className="muted">—</span>}</td>
                <td className="small" style={{ color: changed ? '#1c8a4d' : undefined, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{after || <span className="muted">—</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function fmtVal(v: any): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
