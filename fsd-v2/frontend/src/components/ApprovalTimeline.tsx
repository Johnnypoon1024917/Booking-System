import { useMemo } from 'react';
import { Check, X, Clock, Slash } from 'lucide-react';

interface Step {
  id?: string;
  stepIndex?: number;
  levelName?: string;
  status?: string;
  approverRole?: string;
  decidedBy?: string;
  decisionAt?: string | Date | null;
  dueAt?: string | Date | null;
  reason?: string;
}

interface Props {
  steps: Step[];
  submittedAt?: string | Date | null;
  compact?: boolean;
}

type Cls = 'done' | 'rejected' | 'skipped' | 'current' | 'upcoming';

interface Node {
  title: string;
  cls: Cls;
  actor: string;
  when: string | Date | null;
  reason: string;
  slaText: string;
  overdue: boolean;
}

function human(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
function fmt(d: string | Date | null): string {
  if (!d) return '';
  return new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function ApprovalTimeline({ steps, submittedAt, compact }: Props) {
  // The first pending step is "current" so the UI can animate it; later
  // pending steps stay "upcoming" until their dependencies clear.
  const nodes = useMemo<Node[]>(() => {
    let currentSeen = false;
    return (steps ?? []).map((st) => {
      const status = (st.status ?? 'pending').toLowerCase();
      const role = st.approverRole ?? '';
      const name = st.levelName ?? `Step ${(st.stepIndex ?? 0) + 1}`;
      let cls: Cls = 'upcoming';
      if (status === 'approved') cls = 'done';
      else if (status === 'rejected') cls = 'rejected';
      else if (status === 'skipped') cls = 'skipped';
      else if (!currentSeen) { cls = 'current'; currentSeen = true; }

      let slaText = '', overdue = false;
      if (cls === 'current' && st.dueAt) {
        const ms = new Date(st.dueAt).getTime() - Date.now();
        overdue = ms < 0;
        slaText = overdue
          ? `SLA breached ${human(-ms)} ago`
          : `Awaiting${role ? ' ' + role : ''} · ${human(ms)} left`;
      } else if (cls === 'current') {
        slaText = `Awaiting${role ? ' ' + role : ''}`;
      }

      return {
        title: name,
        cls,
        actor: cls === 'done' || cls === 'rejected' ? (st.decidedBy ?? '—') : '',
        when: st.decisionAt ?? null,
        reason: (cls === 'rejected' || (cls === 'done' && st.reason)) ? (st.reason ?? '') : '',
        slaText, overdue,
      };
    });
  }, [steps]);

  const decided = nodes.filter((n) => n.cls === 'done' || n.cls === 'rejected' || n.cls === 'skipped').length;
  const anyRejected = nodes.some((n) => n.cls === 'rejected');
  const allDone = nodes.length > 0 && nodes.every((n) => n.cls === 'done' || n.cls === 'skipped');
  const resultCls: Cls = anyRejected ? 'rejected' : (allDone ? 'done' : 'upcoming');
  const resultLabel = anyRejected ? 'Rejected' : (allDone ? 'Confirmed' : 'Pending');

  if (compact) {
    return (
      <span className="atl-compact" title={nodes.map((n, i) => `${i + 1}. ${n.title}: ${n.cls}`).join('\n')}>
        <span className="atl-dot done" />
        {nodes.map((n, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <span className={`atl-bar ${n.cls}`} />
            <span className={`atl-dot ${n.cls}`}>
              {n.cls === 'done' ? <Check size={9}/> :
               n.cls === 'rejected' ? <X size={9}/> :
               n.cls === 'skipped' ? <Slash size={9}/> : (i + 1)}
            </span>
          </span>
        ))}
        <span className="atl-meta">{decided}/{nodes.length}</span>
      </span>
    );
  }

  return (
    <div className="atl">
      <div className="atl-node">
        <div className="atl-circle done"><Check size={13}/></div>
        <div className="atl-cap">
          <b>Submitted</b>
          {submittedAt && <small>{fmt(submittedAt)}</small>}
        </div>
      </div>

      {nodes.map((n, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <div className={`atl-link ${n.cls === 'done' || n.cls === 'skipped' ? 'done' : n.cls === 'rejected' ? 'rejected' : ''}`} />
          <div className="atl-node">
            <div className={`atl-circle ${n.cls}`}>
              {n.cls === 'done' ? <Check size={13}/> :
               n.cls === 'rejected' ? <X size={13}/> :
               n.cls === 'skipped' ? <Slash size={13}/> :
               n.cls === 'current' ? <Clock size={13}/> : (i + 1)}
            </div>
            <div className="atl-cap">
              <b>{n.title}</b>
              {n.actor && <small>{n.actor}{n.when && ` · ${fmt(n.when)}`}</small>}
              {!n.actor && n.cls === 'current' && (
                <small className={`atl-sla ${n.overdue ? 'over' : ''}`}>{n.slaText}</small>
              )}
              {n.reason && <div className={`atl-reason ${n.cls === 'rejected' ? 'bad' : ''}`}>“{n.reason}”</div>}
            </div>
          </div>
        </span>
      ))}

      <div className={`atl-link ${resultCls === 'done' ? 'done' : resultCls === 'rejected' ? 'rejected' : ''}`} />
      <div className="atl-node">
        <div className={`atl-circle ${resultCls}`}>
          {resultCls === 'done' ? <Check size={13}/> :
           resultCls === 'rejected' ? <X size={13}/> : '—'}
        </div>
        <div className="atl-cap"><b>{resultLabel}</b></div>
      </div>
    </div>
  );
}
