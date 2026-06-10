import { useEffect, useMemo, useState } from 'react';
import { BarChart3, PieChart, CheckCircle2, Calendar, Clock, CloudSun, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../api/client';
import { Skeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { useTenant } from '../stores/tenant';
import { useToast } from '../stores/toast';
import { useRealtime } from '../hooks/useRealtime';
import { useRealtimeStore } from '../stores/realtime';
import { useT } from '../hooks/useT';

// Port of v1's Dashboard.vue. Same SVG bar chart, pie chart, stat box,
// "no show" table — wrapped in the v1 .fsd-card containers so the look
// matches the Vue SPA. Functional logic mirrors v1 directly.

function pad2(n: number) { return String(n).padStart(2, '0'); }
function iso(d: Date) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }

// `offset` shifts the window by whole periods relative to now: 0 = current,
// -1 = previous week/month/quarter, +1 = next. Lets a manager review last
// month's utilisation or last quarter's no-shows instead of being pinned to
// the current period (QA #5). Date() math rolls month/quarter underflow into
// the previous year automatically.
function rangePeriod(range: string, offset = 0) {
  const now = new Date();
  if (range === 'week') {
    const s = new Date(now); s.setDate(now.getDate() - now.getDay() + offset * 7);
    const e = new Date(s);   e.setDate(s.getDate() + 6);
    return { start: iso(s), end: iso(e) };
  }
  if (range === 'month') {
    const s = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const e = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
    return { start: iso(s), end: iso(e) };
  }
  const q = Math.floor(now.getMonth() / 3) + offset;
  const s = new Date(now.getFullYear(), q * 3, 1);
  const e = new Date(now.getFullYear(), q * 3 + 3, 0);
  return { start: iso(s), end: iso(e) };
}

const PALETTE = ['#059669', '#2563eb', '#dc2626', '#d97706', '#7c3aed', '#0891b2', '#65a30d', '#db2777'];

export function Dashboard() {
  const { t } = useT();
  const toast = useToast();
  const [range, setRange] = useState<'week' | 'month' | 'quarter'>('week');
  // How many whole periods back/forward from now the dashboard is showing
  // (0 = current). Driven by the ◀ ▶ controls next to the range picker.
  const [periodOffset, setPeriodOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [util, setUtil] = useState<{ name: string; short: string; count: number }[]>([]);
  const [byDept, setByDept] = useState<{ name: string; count: number }[]>([]);
  const [noShow, setNoShow] = useState<any[]>([]);
  const [scope, setScope] = useState<'mine' | 'region' | 'all'>('all');
  const [weather, setWeather] = useState<any | null>(null);
  // Region / location filter for the whole dashboard (QA: filter utilisation).
  const [resources, setResources] = useState<any[]>([]);
  const [region, setRegion] = useState('');
  const [location, setLocation] = useState('');
  const [stats, setStats] = useState({
    total: 0, avgMin: 0, checkInPct: 0, cancelPct: 0, noShowPct: 0, activePct: 0, walkInPct: 0, nonOfficePct: 0,
  });

  // Admin-curated dashboard layout — empty/absent list shows everything,
  // otherwise a panel renders only if its key is in dashboard_widgets.
  const customization = useTenant((s) => s.customization) || {};
  const widgets: string[] = customization.dashboard_widgets || [];
  const hasWidget = (k: string) => !widgets.length || widgets.includes(k);

  // Live refresh: any booking lifecycle event reloads the aggregates.
  const { lastEvent } = useRealtime();
  useEffect(() => {
    if (lastEvent?.type?.startsWith('booking.')) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent]);

  // Recompute the aggregates after an SSE reconnect, catching up on bookings
  // that changed while the stream was down.
  const reconnectNonce = useRealtimeStore((s) => s.reconnectNonce);
  useEffect(() => {
    if (reconnectNonce > 0) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectNonce]);

  const scopeTitle = { mine: t('dashboard.scopeTitleMine'), region: t('dashboard.scopeTitleRegion'), all: t('dashboard.scopeTitleAll') }[scope] || t('dashboard.scopeTitleAll');
  const scopeSubtitle = {
    mine: t('dashboard.scopeSubtitleMine'),
    region: t('dashboard.scopeSubtitleRegion'),
    all: t('dashboard.scopeSubtitleAll'),
  }[scope] || '';

  const rangeLabel = useMemo(() => ({ week: t('dashboard.rangeWeek'), month: t('dashboard.rangeMonth'), quarter: t('dashboard.rangeQuarter') }[range]), [range, t]);

  // Resolved start/end of the currently-viewed period, shown between the
  // ◀ ▶ controls so the user always knows which window the figures cover.
  const periodDates = useMemo(() => rangePeriod(range, periodOffset), [range, periodOffset]);

  useEffect(() => { load(); }, [range, periodOffset, region, location]);
  useEffect(() => { api.weather().then((w) => setWeather(w?.enabled ? w : null)).catch(() => undefined); }, []);
  useEffect(() => { api.resources().then(setResources).catch(() => setResources([])); }, []);

  // Distinct regions / locations for the filter dropdowns, derived from the
  // resource catalogue. Locations narrow to the chosen region.
  const regionOptions = useMemo(
    () => [...new Set(resources.map((r) => r.region).filter(Boolean))].sort(),
    [resources],
  );
  const locationOptions = useMemo(
    () => [...new Set(resources.filter((r) => !region || r.region === region).map((r) => r.location).filter(Boolean))].sort(),
    [resources, region],
  );

  const wxUpdated = weather?.updatedAt
    ? new Date(weather.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  async function load() {
    setLoading(true);
    try {
      const { start, end } = rangePeriod(range, periodOffset);
      const d: any = await api.dashboard(start, end, region, location);
      setScope(d.scope || 'all');
      setUtil((d.roomUtilisation || []).map((x: any) => ({
        name: x.name,
        short: x.name && x.name.length > 10 ? x.name.slice(0, 9) + '…' : x.name,
        count: x.count,
      })));
      setByDept(d.byDepartment || []);
      setNoShow(d.noShow || []);
      setStats({
        total: d.stats?.total || 0,
        avgMin: d.stats?.avgMin || 0,
        checkInPct: d.stats?.checkInPct || 0,
        cancelPct: d.stats?.cancelPct || 0,
        noShowPct: d.stats?.noShowPct || 0,
        activePct: d.stats?.activePct || 0,
        walkInPct: d.stats?.walkInPct || 0,
        nonOfficePct: d.stats?.nonOfficePct || 0,
      });
    } catch { /* surfaced via toast elsewhere */ }
    finally { setLoading(false); }
  }

  // Room utilisation renders as a VERTICAL bar chart inside a horizontally-
  // scrollable track: every room gets a fixed-width column (so all rooms show,
  // scroll for the overflow), the value sits on top of each bar, and the name
  // sits beneath it wrapping to two lines with a full-name tooltip — no
  // truncated/rotated x-axis labels.
  const maxCount = Math.max(1, util.reduce((m, u) => Math.max(m, u.count || 0), 0));

  // Pie slices.
  const pieSlices = useMemo(() => {
    const total = byDept.reduce((s, d) => s + d.count, 0);
    if (total === 0 || byDept.length <= 1) return [] as { d: string }[];
    let a0 = -Math.PI / 2;
    return byDept.map((d) => {
      const a1 = a0 + (d.count / total) * Math.PI * 2;
      const x0 = 60 + 54 * Math.cos(a0), y0 = 60 + 54 * Math.sin(a0);
      const x1 = 60 + 54 * Math.cos(a1), y1 = 60 + 54 * Math.sin(a1);
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const d2 = `M60,60 L${x0.toFixed(2)},${y0.toFixed(2)} A54,54 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z`;
      a0 = a1;
      return { d: d2 };
    });
  }, [byDept]);

  return (
    <div>
      <div className="row mb" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 className="fsd-page-title" style={{ marginBottom: 4 }}>{scopeTitle}</h1>
          <p className="muted text-sm" style={{ margin: 0 }}>{scopeSubtitle}</p>
        </div>
        <div className="row gap-sm" style={{ alignItems: 'center' }}>
          {weather && (
            <div className="wx-chip" title={`HK Observatory · updated ${wxUpdated}`}>
              <CloudSun size={15} />
              <b>{weather.tempC}°C</b>
              {(weather.signals || []).map((s: any) => (
                <span key={s.code} className={`wx-sig${s.severity >= 8 ? ' hot' : ''}`}>{s.code}</span>
              ))}
            </div>
          )}
          <select className="range-sel" aria-label={t('dashboard.allRegions')} value={region}
                  onChange={(e) => { setRegion(e.target.value); setLocation(''); }}>
            <option value="">{t('dashboard.allRegions')}</option>
            {regionOptions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select className="range-sel" aria-label={t('dashboard.allLocations')} value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">{t('dashboard.allLocations')}</option>
            {locationOptions.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
          <select className="range-sel" aria-label={t('dashboard.roomUtilization')} value={range}
                  onChange={(e) => { setRange(e.target.value as any); setPeriodOffset(0); }}>
            <option value="week">{t('dashboard.rangeWeek')}</option>
            <option value="month">{t('dashboard.rangeMonth')}</option>
            <option value="quarter">{t('dashboard.rangeQuarter')}</option>
          </select>
          {/* Period navigation — step the window back/forward (QA #5). */}
          <div className="row gap-sm" style={{ alignItems: 'center' }}>
            <button className="iconbtn" aria-label={t('dashboard.prevPeriod')} title={t('dashboard.prevPeriod')}
                    onClick={() => setPeriodOffset((o) => o - 1)}>
              <ChevronLeft size={16} />
            </button>
            <span className="muted text-sm" style={{ whiteSpace: 'nowrap' }}>
              {periodDates.start} → {periodDates.end}
            </span>
            <button className="iconbtn" aria-label={t('dashboard.nextPeriod')} title={t('dashboard.nextPeriod')}
                    disabled={periodOffset >= 0} onClick={() => setPeriodOffset((o) => Math.min(0, o + 1))}>
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </div>

      {hasWidget('room-utilisation') && (
      <div className="fsd-card">
        <div className="fsd-card-title">{t('dashboard.roomUtilization')} <span className="picker">{rangeLabel}</span></div>
        {loading ? <Skeleton height="240px" />
          : util.length === 0 ? <EmptyState icon={BarChart3} title={t('dashboard.noBookingsPeriod')} />
          : (
            <div className="vbar-scroll" tabIndex={0} role="group" aria-label={t('dashboard.roomUtilization')}>
              <div className="vbar-chart">
                {util.map((b) => {
                  // Native `title` only reveals on hover, so touch users (iPad /
                  // iPhone) can never read a truncated room name. Make the column
                  // tap/Enter-activate to surface the full name + count in a toast
                  // that works on any input device (QA #6).
                  const reveal = () => toast.info(b.name, t('dashboard.bookingsCount', { count: b.count }));
                  return (
                  <div className="vbar-col" key={b.name} title={`${b.name} — ${b.count} booking(s)`}
                       role="button" tabIndex={0} onClick={reveal}
                       onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reveal(); } }}>
                    <div className="vbar-plot">
                      <div className="vbar-bar" style={{ height: `${b.count === 0 ? 0 : Math.max(2, Math.round((b.count / maxCount) * 100))}%` }}>
                        <span className="vbar-val">{b.count}</span>
                      </div>
                    </div>
                    <span className="vbar-label">{b.name}</span>
                  </div>
                  );
                })}
              </div>
            </div>
          )}
      </div>
      )}

      <div className="dash-2col">
        {hasWidget('usage-by-dept') && (
        <div className="fsd-card">
          <div className="fsd-card-title">{t('dashboard.utilizationByDept')} <span className="picker">{rangeLabel}</span></div>
          {loading ? <Skeleton height="180px" />
            : byDept.length === 0 ? <EmptyState icon={PieChart} title={t('dashboard.noDeptData')} />
            : (
              <div className="pie-wrap">
                <svg viewBox="0 0 120 120" className="pie">
                  {byDept.length === 1 && <circle cx={60} cy={60} r={54} fill={PALETTE[0]} />}
                  {pieSlices.map((s, i) => <path key={i} d={s.d} fill={PALETTE[i % PALETTE.length]} />)}
                </svg>
                <ul className="legend">
                  {byDept.map((d, i) => (
                    <li key={d.name}>
                      <span className="sw" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="space">{d.name}</span>
                      <b>{d.count}</b>
                    </li>
                  ))}
                </ul>
              </div>
            )}
        </div>
        )}

        {hasWidget('core-indicators') && (
        <div className="fsd-card">
          <div className="fsd-card-title">{t('dashboard.statBox')} <span className="picker">{rangeLabel}</span></div>
          <div className="fsd-bigstats">
            <div className="item"><Calendar size={22} color="#337ab7" /><strong>{stats.total}</strong><span>{t('dashboard.bookings')}</span></div>
            <div className="item"><Clock size={22} color="#337ab7" /><strong>{stats.avgMin} {t('dashboard.mins')}</strong><span>{t('dashboard.avgMeetingDuration')}</span></div>
          </div>
          {/* Segment widths track each outcome's share of EVERY booking in the
              period (not just the terminal-outcome subset), so a lone
              cancellation among 5 bookings reads as "20% Cancelled / 80% Active"
              rather than a misleading full-width "100% Cancelled" (QA #13).
              .fsd-seg defaults to flex:1, so each width is driven from its
              percentage and 0% segments drop out; a single grey bar shows when
              the period has no bookings at all. */}
          <div className="fsd-segrow">
            {stats.total === 0 ? (
              <div className="fsd-seg grey" style={{ flex: 1 }}>{t('dashboard.noBookingsPeriod')}</div>
            ) : (
              [
                { cls: 'blue',   pct: stats.activePct,  label: t('dashboard.active') },
                { cls: 'green',  pct: stats.checkInPct, label: t('dashboard.checkIn') },
                { cls: 'orange', pct: stats.cancelPct,  label: t('dashboard.cancelled') },
                { cls: 'red',    pct: stats.noShowPct,  label: t('dashboard.noShow') },
              ].filter((s) => s.pct > 0).map((s) => (
                <div key={s.cls} className={`fsd-seg ${s.cls}`} style={{ flex: s.pct, minWidth: 0 }}>
                  <span className="pct">{s.pct}%</span>{s.label}
                </div>
              ))
            )}
          </div>
        </div>
        )}
      </div>

      {hasWidget('activity-log') && (
      <div className="fsd-card">
        <div className="fsd-card-title">{t('dashboard.noShow')} <span className="picker">{rangeLabel}</span></div>
        {loading ? <Skeleton height="160px" />
          : noShow.length === 0 ? <EmptyState icon={CheckCircle2} title={t('dashboard.noNoShows')} />
          : (
            <table className="dt">
              <thead><tr>
                <th>{t('dashboard.colName')} <span className="caret">▲▼</span></th>
                <th>{t('dashboard.colDepartment')} <span className="caret">▲▼</span></th>
                <th>{t('dashboard.colRoom')} <span className="caret">▲▼</span></th>
                <th>{t('dashboard.colDateTime')} <span className="caret">▲▼</span></th>
              </tr></thead>
              <tbody>
                {noShow.map((a, i) => (
                  <tr key={i}><td>{a.name}</td><td>{a.dept}</td><td>{a.room}</td><td>{a.when}</td></tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
      )}
    </div>
  );
}
