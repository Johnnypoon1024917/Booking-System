import { useEffect, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import {
  Palette, Languages, LayoutGrid, GitBranch, ListChecks, Plug, CalendarDays,
  RefreshCcw, RotateCcw, Save, Plus, Trash2, X, CloudRain, Calendar, Mail, MessageSquare, Video, Eye,
} from 'lucide-react';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { confirmDialog } from '../stores/confirm';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { Switch } from '../components/Switch';

// Tenant Studio — full port of v1's Admin.vue: 7 tabs (branding, locale,
// layout, workflow, fields, integrations, holidays) plus a live preview
// pane. Dirty-tracked against a JSON baseline; Save persists the whole
// customization document.
const TABS = [
  { key: 'branding', label: 'Branding', icon: Palette },
  { key: 'locale', label: 'Locale', icon: Languages },
  { key: 'layout', label: 'Layout', icon: LayoutGrid },
  { key: 'workflow', label: 'Workflow', icon: GitBranch },
  { key: 'fields', label: 'Custom fields', icon: ListChecks },
  { key: 'integrations', label: 'Integrations', icon: Plug },
  { key: 'holidays', label: 'Holidays', icon: CalendarDays },
] as const;

const ALL_MODULES = ['dashboard', 'calendar', 'search', 'my-bookings', 'reports', 'admin'];
const ALL_WIDGETS = ['room-utilisation', 'usage-by-dept', 'core-indicators', 'activity-log'];
const ALL_RECURRENCE = ['daily', 'weekly', 'bi-weekly', 'monthly'];
const ALL_REPORTS = [
  { key: 'usage', label: 'Usage' }, { key: 'staff', label: 'Staff' },
  { key: 'noshow', label: 'No-show' }, { key: 'addl', label: 'Additional services' },
  { key: 'audit', label: 'Audit' }, { key: 'summary', label: 'Summary' },
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Stable per-row id for custom fields. Using the array index as a React key
// bleeds DOM state (focus / unsaved typing) between rows when one is deleted,
// so each field carries a local-only `_id` (stripped before save).
function fieldId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `f_${Math.random().toString(36).slice(2)}_${Date.now()}`);
}
function withFieldIds(d: any): any {
  if (!d || !Array.isArray(d.custom_fields)) return d;
  return { ...d, custom_fields: d.custom_fields.map((f: any) => (f._id ? f : { ...f, _id: fieldId() })) };
}

// The native <input type="color"> only accepts a strict 6-digit hex; anything
// else snaps it to its fallback, desyncing it from the text twin ("tug-of-war").
// Expand a 3-digit shorthand (#abc → #aabbcc) and pass through a valid 6-digit
// value so what the admin types is what the swatch shows. Returns '' when the
// text isn't yet a parseable hex, so the caller can apply its own fallback.
function normalizeHex(v: string): string {
  const s = (v || '').trim();
  const m3 = /^#?([0-9a-fA-F]{3})$/.exec(s);
  if (m3) { const [r, g, b] = m3[1].split(''); return `#${r}${r}${g}${g}${b}${b}`.toLowerCase(); }
  const m6 = /^#?([0-9a-fA-F]{6})$/.exec(s);
  if (m6) return `#${m6[1]}`.toLowerCase();
  return '';
}

export function TenantStudio() {
  const toast = useToast();
  const [c, setC] = useState<any | null>(null);
  const [baseline, setBaseline] = useState('');
  const [tab, setTab] = useState<typeof TABS[number]['key']>('branding');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // Holiday list shown inside the Holidays tab — loaded lazily the first time
  // the tab is opened (and refreshed after a sync).
  const [holidays, setHolidays] = useState<any[] | null>(null);
  // Distinct resource regions, for the gov.hk holiday-scope picker. Regions are
  // free-form on resources (no enum), so the options come from what's in use.
  const [regions, setRegions] = useState<string[]>([]);

  useEffect(() => {
    api.customization().then((d) => { const wf = withFieldIds(d); setC(wf); setBaseline(JSON.stringify(wf)); });
  }, []);

  useEffect(() => {
    if (tab === 'holidays' && holidays === null) { loadHolidays(); loadRegions(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function loadHolidays() {
    setHolidays(null); // show the loading state instead of flickering stale rows
    try { setHolidays(await api.listHolidays()); }
    catch { setHolidays([]); }
  }

  async function loadRegions() {
    try {
      const res: Array<{ region?: string }> = await api.adminResources();
      setRegions([...new Set(res.map((r) => r.region).filter((r): r is string => !!r))].sort());
    } catch { /* leave empty — picker shows the "no regions" hint */ }
  }

  // Arm the unsaved-changes guard BEFORE the early return so the hook order
  // stays stable. An admin can spend many minutes building branding, custom
  // fields, or an auto-release config; a stray sidebar click must not discard
  // it without a prompt.
  const dirty = c !== null && baseline !== JSON.stringify(c);
  useUnsavedGuard(dirty, 'You have unsaved tenant settings. Leave without saving?');

  if (!c) return <p className="muted">Loading…</p>;
  const set = (k: string, v: any) => setC({ ...c, [k]: v });
  const arr = (k: string): any[] => c[k] || [];
  const toggleIn = (k: string, v: any) =>
    set(k, arr(k).includes(v) ? arr(k).filter((x) => x !== v) : [...arr(k), v]);
  // Patch one key inside the nested auto_release config object.
  const auto = c.auto_release || {};
  const setAuto = (k: string, v: any) => set('auto_release', { ...auto, [k]: v });

  // Cross-field validation — inverted ranges silently corrupt the booking UI
  // and reservation logic for every user under the tenant, so block the save.
  function validationError(): string | null {
    const minD = c.min_duration_minutes ?? 15;
    const maxD = c.max_duration_minutes ?? 480;
    if (minD > maxD) return 'Min duration cannot exceed max duration.';
    const sh = c.calendar_start_hour ?? 8;
    const eh = c.calendar_end_hour ?? 20;
    if (sh >= eh) return 'Calendar start hour must be before the end hour.';
    // Custom-field keys become JSONB object keys on every booking, so a
    // duplicate key silently overwrites a sibling field's value before the
    // payload ever reaches the server ({ cc: "A", cc: "B" } → { cc: "B" }).
    // Block the save on any missing or repeated key.
    const fieldKeys = (c.custom_fields || []).map((f: any) => (f.key || '').trim());
    if (fieldKeys.some((k: string) => !k)) {
      return 'Every custom field needs a key.';
    }
    const dupKey = fieldKeys.find((k: string, i: number) => fieldKeys.indexOf(k) !== i);
    if (dupKey) {
      return `Custom field key "${dupKey}" is used more than once — keys must be unique.`;
    }
    return null;
  }

  async function save() {
    const err = validationError();
    if (err) { toast.error('Cannot save', err); return; }
    setBusy(true);
    try {
      // Strip the local-only _id and drop blank custom-field option lines that
      // accumulate while typing.
      const cleaned = { ...c,
        custom_fields: (c.custom_fields || []).map(({ _id, ...f }: any) =>
          f.type === 'select' ? { ...f, options: (f.options || []).filter((o: string) => o.trim()) } : f),
        // Split on commas AND newlines (admins paste "FIN-001, MKT-204"), then
        // trim + de-dupe + drop blanks so the allow-list the booking flow
        // validates against never holds a single mega-code.
        cost_centers: [...new Set((c.cost_centers || [])
          .flatMap((s: string) => String(s ?? '').split(/[\n,]+/))
          .map((s: string) => s.trim())
          .filter(Boolean))],
      };
      const saved = await api.saveCustomization(cleaned);
      const wf = withFieldIds(saved);
      setC(wf); setBaseline(JSON.stringify(wf));
      toast.success('Customization saved');
    } catch (e: any) {
      // Optimistic-concurrency clash: another admin saved since we loaded. Don't
      // silently overwrite their work — offer to reload the latest (discarding
      // local edits) or keep editing so the admin can copy their changes out.
      if (e?.response?.status === 409) {
        const reload = await confirmDialog({
          title: 'Settings changed elsewhere',
          message: 'Another administrator saved changes since you opened this page. Reload the latest settings? Your unsaved changes here will be lost.',
          confirmText: 'Reload latest',
          cancelText: 'Keep editing',
          tone: 'danger',
        });
        if (reload) {
          const d = await api.customization();
          const wf = withFieldIds(d); setC(wf); setBaseline(JSON.stringify(wf));
        }
        return;
      }
      toast.error('Save failed', e.displayMessage || e.message);
    } finally { setBusy(false); }
  }
  function reset() { setC(JSON.parse(baseline)); }
  async function syncHolidays() {
    setSyncing(true);
    try {
      const r = await api.syncHKHolidays();
      toast.success(`Synced ${r?.count ?? ''} holidays`.trim());
      await loadHolidays();
    }
    catch (e: any) { toast.error('Sync failed', e.displayMessage || e.message); }
    finally { setSyncing(false); }
  }

  // Custom-field helpers
  function addField() {
    set('custom_fields', [...arr('custom_fields'), { _id: fieldId(), key: '', type: 'text', required: false, label: { en: '', 'zh-Hant': '', 'zh-Hans': '' }, options: [] }]);
  }
  function patchField(i: number, patch: any) {
    set('custom_fields', arr('custom_fields').map((f, idx) => idx === i ? { ...f, ...patch } : f));
  }
  function removeField(i: number) { set('custom_fields', arr('custom_fields').filter((_, idx) => idx !== i)); }

  // ---- Live preview ---------------------------------------------------------
  // The preview is tab-aware (Shopify / Okta admin style): it renders whatever
  // the admin is currently editing so they see the effect, not just a static
  // mock. Brand colors run through the same hex expander the picker uses so an
  // in-progress invalid value can't blow up the preview backgrounds.
  const pColor = normalizeHex(c.brand_primary) || '#002147';
  const sColor = normalizeHex(c.brand_secondary) || '#475569';
  const aColor = normalizeHex(c.brand_accent) || '#f59e0b';
  const locale: string = c.default_locale || 'en';
  const localeLabel = (l: string) => (l === 'zh-Hant' ? '繁體中文' : l === 'zh-Hans' ? '简体中文' : 'English');
  const fmtDur = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`);
  const fieldLabel = (f: any) => f.label?.[locale] || f.label?.en || f.key || 'Field';
  const badge: CSSProperties = { padding: '3px 8px', borderRadius: 999, background: 'var(--surface-inset)', border: '1px solid var(--border)', fontSize: 11 };

  function renderPreviewBody() {
    switch (tab) {
      case 'branding':
        return (
          <>
            <div className="preview-card" style={{ borderLeft: `3px solid ${pColor}` }}>
              <small>BOARDROOM A</small>
              <h4 style={{ margin: '2px 0 8px' }}>09:00 – 10:00</h4>
              <div style={{ marginBottom: 8 }}>
                <span style={{ background: aColor, color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 12 }}>Requires approval</span>
              </div>
              <div className="row gap-sm">
                <button style={{ background: pColor, color: '#fff' }}>Reserve</button>
                <button style={{ background: 'transparent', color: sColor, border: `1px solid ${sColor}` }}>Details</button>
              </div>
            </div>
            <div className="row gap-sm" style={{ justifyContent: 'space-around' }}>
              {([['Primary', pColor], ['Secondary', sColor], ['Accent', aColor]] as const).map(([label, col]) => (
                <div key={label} style={{ textAlign: 'center' }}>
                  <div style={{ width: 40, height: 40, borderRadius: 8, background: col, border: '1px solid rgba(0,0,0,0.1)', margin: '0 auto' }} />
                  <small className="muted">{label}</small>
                </div>
              ))}
            </div>
          </>
        );

      case 'locale': {
        let sample = '';
        try {
          sample = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: c.timezone || 'UTC' }).format(new Date());
        } catch { sample = ''; }
        return (
          <div className="preview-card">
            <small className="muted">Default locale</small>
            <h4 style={{ margin: '2px 0 8px' }}>{localeLabel(locale)}</h4>
            <div className="row gap-sm" style={{ flexWrap: 'wrap' }}>
              {(c.available_locales || []).map((l: string) => (
                <span key={l} style={{ ...badge, ...(l === locale ? { background: pColor, color: '#fff', borderColor: pColor } : {}) }}>{localeLabel(l)}</span>
              ))}
            </div>
            {sample && <small className="muted" style={{ display: 'block', marginTop: 10 }}>{sample} · {c.timezone || 'UTC'}</small>}
          </div>
        );
      }

      case 'layout': {
        const widgets = arr('dashboard_widgets').filter((w: string) => w !== 'none');
        const widgetsHidden = arr('dashboard_widgets').includes('none');
        return (
          <div className="preview-card">
            <small className="muted">Sidebar</small>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '6px 0 12px' }}>
              {arr('sidebar_modules').length === 0
                ? <span className="muted small">No modules visible</span>
                : arr('sidebar_modules').map((m: string) => (
                    <div key={m} style={{ padding: '4px 8px', borderRadius: 6, background: 'var(--surface-inset)', fontSize: 13 }}>{m}</div>
                  ))}
            </div>
            <small className="muted">Dashboard widgets</small>
            <div className="row gap-sm" style={{ flexWrap: 'wrap', marginTop: 6 }}>
              {widgetsHidden ? <span className="muted small">All widgets hidden</span>
                : widgets.length === 0 ? <span className="muted small">All widgets shown (default)</span>
                : widgets.map((w: string) => <span key={w} style={badge}>{w}</span>)}
            </div>
          </div>
        );
      }

      case 'workflow': {
        const minD = c.min_duration_minutes ?? 15;
        const maxD = c.max_duration_minutes ?? 480;
        const stepD = Math.max(5, minD);
        const durations: number[] = [];
        for (let d = minD; d <= maxD && durations.length < 16; d += stepD) durations.push(d);
        const startH = c.calendar_start_hour ?? 8;
        const endH = c.calendar_end_hour ?? 20;
        const startTimes: string[] = [];
        for (let h = startH; h <= endH && startTimes.length < 24; h++) startTimes.push(`${String(h).padStart(2, '0')}:00`);
        return (
          <div className="preview-card">
            <small className="muted">New booking</small>
            {/* Mock dropdowns constrained by the live min/max duration + calendar
                hours so the admin sees exactly what bookers will be offered. */}
            <label className="field" style={{ marginTop: 6 }}><span>Start time</span>
              <select defaultValue={startTimes[0]}>{startTimes.map((tm) => <option key={tm}>{tm}</option>)}</select>
            </label>
            <label className="field" style={{ marginTop: 8 }}><span>Duration</span>
              <select defaultValue={durations[0]}>{durations.map((d) => <option key={d} value={d}>{fmtDur(d)}</option>)}</select>
            </label>
            <div className="row gap-sm" style={{ flexWrap: 'wrap', marginTop: 10 }}>
              <span style={badge}>Horizon {c.booking_horizon_days ?? 180}d</span>
              <span style={badge}>Approval {c.approval_window_hours ?? 24}h</span>
              {!!c.weekend_require_approval && <span style={badge}>Weekend → approval</span>}
              {!!c.holiday_blocking && <span style={badge}>Holidays blocked</span>}
            </div>
            <small className="muted" style={{ display: 'block', marginTop: 8 }}>
              Duration {fmtDur(minD)}–{fmtDur(maxD)} · hours {String(startH).padStart(2, '0')}:00–{String(endH).padStart(2, '0')}:00
            </small>
          </div>
        );
      }

      case 'fields': {
        const fields = arr('custom_fields');
        return (
          <div className="preview-card">
            <small className="muted">Booking form fields</small>
            {fields.length === 0
              ? <p className="muted small" style={{ marginTop: 6 }}>No custom fields yet — add some to see the form grow.</p>
              : fields.map((f: any) => {
                  const lbl = `${fieldLabel(f)}${f.required ? ' *' : ''}`;
                  if (f.type === 'checkbox') {
                    return (
                      <label key={f._id} className="toggle" style={{ marginTop: 10 }}>
                        <input type="checkbox" /> <span>{lbl}</span>
                      </label>
                    );
                  }
                  return (
                    <label key={f._id} className="field" style={{ marginTop: 10 }}><span>{lbl}</span>
                      {f.type === 'select'
                        ? <select defaultValue=""><option value="">Choose…</option>{(f.options || []).filter((o: string) => o.trim()).map((o: string) => <option key={o}>{o}</option>)}</select>
                        : <input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} placeholder={f.key} />}
                    </label>
                  );
                })}
          </div>
        );
      }

      case 'integrations': {
        const on = [
          ['HKO weather', c.hko_weather_enabled],
          ['gov.hk holidays', c.govhk_holidays_enabled],
          ['Outlook sync', c.outlook_sync_enabled],
          ['Teams app', c.teams_app_enabled],
          ['Zoom', c.zoom_enabled],
        ].filter(([, en]) => !!en) as [string, boolean][];
        return (
          <div className="preview-card">
            <small className="muted">Active integrations</small>
            <div className="row gap-sm" style={{ flexWrap: 'wrap', marginTop: 8 }}>
              {on.length === 0 ? <span className="muted small">None enabled</span>
                : on.map(([label]) => <span key={label} style={{ ...badge, background: pColor, color: '#fff', borderColor: pColor }}>{label}</span>)}
            </div>
          </div>
        );
      }

      case 'holidays':
        return (
          <div className="preview-card">
            <small className="muted">Holidays</small>
            <p className="small" style={{ marginTop: 6 }}>
              {holidays === null ? 'Loading…' : `${holidays.length} configured`}
              {c.holiday_blocking ? ' · bookings blocked on blocker dates' : ''}
            </p>
          </div>
        );

      default:
        return null;
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Tenant Studio</h1>
          <p className="muted">Branding, locale, layout, workflow, fields, and integrations.</p>
        </div>
        <div className="row gap-sm" style={{ alignItems: 'center' }}>
          {dirty && <span className="dirty-chip">● Unsaved changes</span>}
          {/* Sync holidays lives inside the Holidays tab (contextual) — having a
              second always-on copy here was a duplicate control. */}
          <button className="btn-fsd ghost" onClick={reset} disabled={!dirty}><RotateCcw size={14} /> Reset</button>
          <button className="btn-fsd" onClick={save} disabled={busy || !dirty}><Save size={14} /> {busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>

      <div className="studio-grid">
        <div>
          <nav className="tabs">
            {TABS.map((tb) => (
              <button key={tb.key} className={`tab${tab === tb.key ? ' active' : ''}`} onClick={() => setTab(tb.key)}>
                <tb.icon size={14} /> {tb.label}
              </button>
            ))}
          </nav>

          {tab === 'branding' && (
            <section className="card">
              <div className="grid-2">
                <label className="field"><span>Brand name</span><input value={c.brand_name || ''} onChange={(e) => set('brand_name', e.target.value)} /></label>
                <label className="field"><span>Logo URL</span><input value={c.brand_logo_url || ''} placeholder="https://…/logo.svg" onChange={(e) => set('brand_logo_url', e.target.value)} /></label>
              </div>
              <div className="grid-3" style={{ marginTop: 12 }}>
                {(['brand_primary', 'brand_secondary', 'brand_accent'] as const).map((k, i) => (
                  <label key={k} className="field"><span>{['Primary', 'Secondary', 'Accent'][i]}</span>
                    <div className="row gap-sm">
                      {/* The native color input silently breaks (and desyncs from
                          the text twin) on any value that isn't a strict 6-digit
                          hex. Expand 3-digit shorthand (#abc) and normalise valid
                          input so #fff shows as white instead of snapping to the
                          fallback; only fall back when the text is unparseable. */}
                      <input type="color" value={normalizeHex(c[k]) || '#002147'} onChange={(e) => set(k, e.target.value)} />
                      <input type="text" value={c[k] || ''} maxLength={7} placeholder="#002147"
                        onChange={(e) => {
                          // Keep the leading # so the two controls stay bound.
                          let v = e.target.value.trim();
                          if (v && !v.startsWith('#')) v = '#' + v;
                          set(k, v);
                        }} />
                    </div>
                  </label>
                ))}
              </div>
            </section>
          )}

          {tab === 'locale' && (
            <section className="card">
              <div className="grid-2">
                <label className="field"><span>Default locale</span>
                  <select value={c.default_locale} onChange={(e) => set('default_locale', e.target.value)}>
                    <option value="en">🇬🇧 English</option><option value="zh-Hant">🇭🇰 繁體中文</option><option value="zh-Hans">🇨🇳 简体中文</option>
                  </select>
                </label>
                <label className="field"><span>Timezone</span>
                  <select value={c.timezone} onChange={(e) => set('timezone', e.target.value)}>
                    <option>Asia/Hong_Kong</option><option>Asia/Singapore</option><option>Asia/Tokyo</option><option>UTC</option>
                  </select>
                </label>
              </div>
              <div style={{ marginTop: 16 }}>
                <label className="field"><span>Available locales</span></label>
                <div className="chip-list">
                  {['en', 'zh-Hant', 'zh-Hans'].map((l) => (
                    <label key={l} className={`chip${arr('available_locales').includes(l) ? ' active' : ''}`}>
                      <input type="checkbox" checked={arr('available_locales').includes(l)} onChange={() => toggleIn('available_locales', l)} />
                      {l === 'zh-Hant' ? '繁體中文' : l === 'zh-Hans' ? '简体中文' : 'English'}
                    </label>
                  ))}
                </div>
              </div>
            </section>
          )}

          {tab === 'layout' && (
            <section className="card">
              <label className="field"><span>Dashboard widgets</span></label>
              <p className="text-sm muted">Which panels appear on the dashboard. Add none to show all (the default); remove every panel to hide them all.</p>
              <div className="chip-list">
                {/* 'none' is an internal sentinel meaning "explicitly hide all" —
                    it must never render as a chip. Remove by value (indices
                    shift once 'none' is filtered out). */}
                {arr('dashboard_widgets').filter((w) => w !== 'none').map((w) => (
                  <span key={w} className="chip active">{w}
                    <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => {
                      const next = arr('dashboard_widgets').filter((x) => x !== w && x !== 'none');
                      // Empty array = "show all" (wildcard). When the admin removes
                      // the last panel they mean "show none", so park a sentinel
                      // that keeps the array non-empty without rendering anything.
                      set('dashboard_widgets', next.length === 0 ? ['none'] : next);
                    }} aria-label="remove"><X size={12} /></button>
                  </span>
                ))}
                <select className="chip" value="" onChange={(e) => { if (e.target.value) set('dashboard_widgets', [...arr('dashboard_widgets').filter((w) => w !== 'none'), e.target.value]); }}>
                  <option value="">+ Widget…</option>
                  {ALL_WIDGETS.filter((w) => !arr('dashboard_widgets').includes(w)).map((w) => <option key={w} value={w}>{w}</option>)}
                </select>
              </div>

              <div style={{ marginTop: 20 }}>
                <label className="field"><span>Sidebar modules</span></label>
                <p className="text-sm muted">Which navigation entries are visible.</p>
                <div className="chip-list">
                  {ALL_MODULES.map((m) => (
                    <label key={m} className={`chip${arr('sidebar_modules').includes(m) ? ' active' : ''}`}>
                      <input type="checkbox" checked={arr('sidebar_modules').includes(m)} onChange={() => toggleIn('sidebar_modules', m)} /> {m}
                    </label>
                  ))}
                </div>
              </div>
            </section>
          )}

          {tab === 'workflow' && (
            <section className="card">
              <div className="grid-3">
                <label className="field"><span>Booking horizon (days)</span><input type="number" value={c.booking_horizon_days ?? 180} onChange={(e) => set('booking_horizon_days', +e.target.value)} /></label>
                <label className="field"><span>Min duration (min)</span><input type="number" value={c.min_duration_minutes ?? 15} onChange={(e) => set('min_duration_minutes', +e.target.value)} /></label>
                <label className="field"><span>Max duration (min)</span><input type="number" value={c.max_duration_minutes ?? 480} onChange={(e) => set('max_duration_minutes', +e.target.value)} /></label>
                <label className="field"><span>Grace period (min)</span><input type="number" value={c.grace_period_minutes ?? 15} onChange={(e) => set('grace_period_minutes', +e.target.value)} /></label>
                <label className="field"><span>Approval window (hrs)</span><input type="number" value={c.approval_window_hours ?? 24} onChange={(e) => set('approval_window_hours', +e.target.value)} /></label>
              </div>
              <div style={{ marginTop: 16 }}>
                <label className="field"><span>Weekend days</span></label>
                <div className="chip-list">
                  {WEEKDAYS.map((w, i) => {
                    const d = i + 1;
                    return <label key={w} className={`chip${arr('weekend_days').includes(d) ? ' active' : ''}`}><input type="checkbox" checked={arr('weekend_days').includes(d)} onChange={() => toggleIn('weekend_days', d)} /> {w}</label>;
                  })}
                </div>
              </div>
              <div className="row gap" style={{ marginTop: 16, flexWrap: 'wrap' }}>
                <label className="toggle"><input type="checkbox" checked={!!c.weekend_require_approval} onChange={(e) => set('weekend_require_approval', e.target.checked)} /><span>Weekend bookings require approval</span></label>
                <label className="toggle"><input type="checkbox" checked={!!c.holiday_blocking} onChange={(e) => set('holiday_blocking', e.target.checked)} /><span>Block bookings on public holidays</span></label>
              </div>
              <div className="grid-2" style={{ marginTop: 16 }}>
                <label className="field"><span>Calendar start hour (0–23)</span><input type="number" min={0} max={23} value={c.calendar_start_hour ?? 8} onChange={(e) => set('calendar_start_hour', +e.target.value)} /></label>
                <label className="field"><span>Calendar end hour (1–23)</span><input type="number" min={1} max={23} value={c.calendar_end_hour ?? 20} onChange={(e) => set('calendar_end_hour', +e.target.value)} /></label>
              </div>
              <div style={{ marginTop: 16 }}>
                <label className="field"><span>Report templates</span></label>
                <div className="chip-list">
                  {ALL_REPORTS.map((r) => (
                    <label key={r.key} className={`chip${(!arr('report_types').length || arr('report_types').includes(r.key)) ? ' active' : ''}`}>
                      <input type="checkbox" checked={!arr('report_types').length || arr('report_types').includes(r.key)}
                        onChange={() => {
                          // Empty array = wildcard "all enabled". Naively pushing the
                          // clicked key would invert the selection (unchecking one
                          // would leave only that one). When breaking out of the
                          // wildcard, materialise the full list minus the one just
                          // unticked; otherwise toggle normally.
                          const current = arr('report_types');
                          if (current.length === 0) {
                            set('report_types', ALL_REPORTS.map((x) => x.key).filter((k) => k !== r.key));
                          } else {
                            toggleIn('report_types', r.key);
                          }
                        }} /> {r.label}
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 16 }}>
                <label className="field"><span>Recurrence patterns</span></label>
                <div className="chip-list">
                  {ALL_RECURRENCE.map((p) => (
                    <label key={p} className={`chip${arr('recurrence_patterns').includes(p) ? ' active' : ''}`}>
                      <input type="checkbox" checked={arr('recurrence_patterns').includes(p)} onChange={() => toggleIn('recurrence_patterns', p)} /> {p}
                    </label>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border, #e5e7eb)' }}>
                <label className="field"><span>Auto-release no-shows (ghost bookings)</span></label>
                <p className="text-sm muted">
                  Release a room automatically when nobody checks in within the grace period after the
                  start time, and email the booker. A resource can tighten the grace further in its editor.
                </p>
                <div className="row gap" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label className="toggle"><input type="checkbox" checked={!!auto.enabled} onChange={(e) => setAuto('enabled', e.target.checked)} /><span>Enable auto-release</span></label>
                  <label className="field" style={{ maxWidth: 200 }}><span>Grace period (min)</span>
                    <input type="number" min={1} value={auto.grace_minutes ?? 15} onChange={(e) => setAuto('grace_minutes', +e.target.value)} />
                  </label>
                </div>
              </div>

              <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border, #e5e7eb)' }}>
                <label className="field"><span>Cost centers / chargeback codes</span></label>
                <p className="text-sm muted">
                  One code per line. When any codes are configured, every booking must be billed to one
                  of them (chosen at booking time). Leave empty to disable chargeback codes.
                </p>
                <textarea rows={4} value={(c.cost_centers || []).join('\n')}
                  placeholder={'FIN-001\nMKT-204\nOPS-310'}
                  onChange={(e) => set('cost_centers', e.target.value.split('\n'))} />
              </div>
            </section>
          )}

          {tab === 'fields' && (
            <section className="card">
              {arr('custom_fields').map((f: any, i: number) => (
                <div key={f._id ?? i} className="card" style={{ background: 'var(--surface-inset)', marginBottom: 12 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <h4 style={{ margin: 0 }}>{f.label?.en || f.key || 'New field'}</h4>
                    <button className="btn-fsd ghost danger" onClick={() => removeField(i)}><Trash2 size={13} /> Remove</button>
                  </div>
                  <div className="grid-3" style={{ marginTop: 8 }}>
                    <label className="field"><span>Key</span><input value={f.key} onChange={(e) => patchField(i, { key: e.target.value })} /></label>
                    <label className="field"><span>Type</span>
                      <select value={f.type} onChange={(e) => patchField(i, { type: e.target.value })}>
                        <option>text</option><option>select</option><option>number</option><option>checkbox</option><option>date</option>
                      </select>
                    </label>
                    <label className="toggle" style={{ marginTop: 22 }}><input type="checkbox" checked={!!f.required} onChange={(e) => patchField(i, { required: e.target.checked })} /><span>Required</span></label>
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <label className="field"><span>Labels</span></label>
                    <div className="grid-3">
                      <input value={f.label?.en || ''} placeholder="English" onChange={(e) => patchField(i, { label: { ...f.label, en: e.target.value } })} />
                      <input value={f.label?.['zh-Hant'] || ''} placeholder="繁體中文" onChange={(e) => patchField(i, { label: { ...f.label, 'zh-Hant': e.target.value } })} />
                      <input value={f.label?.['zh-Hans'] || ''} placeholder="简体中文" onChange={(e) => patchField(i, { label: { ...f.label, 'zh-Hans': e.target.value } })} />
                    </div>
                  </div>
                  {f.type === 'select' && (
                    <div style={{ marginTop: 8 }}>
                      <label className="field"><span>Options (one per line)</span></label>
                      <textarea rows={3} value={(f.options || []).join('\n')} onChange={(e) => patchField(i, { options: e.target.value.split('\n') })} />
                    </div>
                  )}
                </div>
              ))}
              <button className="btn-fsd ghost" onClick={addField}><Plus size={14} /> Add field</button>
            </section>
          )}

          {tab === 'integrations' && (
            <section className="card">
              {[
                { icon: CloudRain, key: 'hko_weather_enabled', title: 'HKO weather', help: 'Show the live Hong Kong Observatory signal on the dashboard.' },
                { icon: Calendar, key: 'govhk_holidays_enabled', title: 'gov.hk holidays', help: 'Auto-import Hong Kong public holidays nightly.' },
                { icon: Mail, key: 'outlook_sync_enabled', title: 'Outlook sync', help: 'Microsoft Graph two-way sync to room mailboxes.' },
                { icon: MessageSquare, key: 'teams_app_enabled', title: 'Teams app', help: 'Book and manage rooms from inside Microsoft Teams.' },
                { icon: Video, key: 'zoom_enabled', title: 'Zoom', help: 'Mask Zoom join links through a redirect gateway.' },
              ].map((row) => (
                <div key={row.key} className="integration-row">
                  <row.icon size={20} className="muted" />
                  <div className="space"><b>{row.title}</b><p className="muted text-sm">{row.help}</p></div>
                  <Switch checked={!!c[row.key]} onChange={(v) => set(row.key, v)} label={row.title} />
                </div>
              ))}
              {/* Zoom config only appears once Zoom is enabled — consistent with
                  the toggle-driven model of the other integrations. */}
              {!!c.zoom_enabled && (
                <div style={{ marginTop: 16 }}>
                  <label className="field"><span>Zoom mask base URL</span>
                    <input value={c.zoom_mask_base || ''} placeholder="https://ess.example/redirect" onChange={(e) => set('zoom_mask_base', e.target.value)} />
                  </label>
                </div>
              )}
            </section>
          )}

          {tab === 'holidays' && (
            <section className="card">
              <p className="muted text-sm">Sync from gov.hk or add tenant-specific dates manually.</p>
              <div className="row gap-sm">
                <button className="btn-fsd" onClick={syncHolidays} disabled={syncing}><RefreshCcw size={14} className={syncing ? 'spin' : ''} /> Sync holidays</button>
                <Link className="btn-fsd ghost" to="/admin/holidays"><Plus size={14} /> Add manually</Link>
              </div>

              {/* gov.hk scope. The feed is Hong Kong public holidays; on a
                  multi-region tenant (e.g. HK + Singapore) limit it to the HK
                  regions so it doesn't close offices elsewhere. None selected =
                  tenant-wide. Used by both this Sync button and the nightly cron. */}
              <div style={{ marginTop: 18 }}>
                <label className="field"><span>gov.hk holiday scope</span></label>
                <p className="muted text-sm">Regions that Hong Kong public holidays close. None selected applies tenant-wide (every resource).</p>
                {regions.length === 0 ? (
                  <p className="muted text-sm" style={{ marginTop: 6 }}>No resource regions defined yet — holidays apply tenant-wide.</p>
                ) : (
                  <div className="row gap-sm" style={{ flexWrap: 'wrap', marginTop: 6 }}>
                    {regions.map((r) => (
                      <label key={r} className="row gap-xs" style={{ alignItems: 'center' }}>
                        <input type="checkbox" checked={arr('govhk_holiday_regions').includes(r)}
                               onChange={() => toggleIn('govhk_holiday_regions', r)} />
                        {r}
                      </label>
                    ))}
                  </div>
                )}
                <p className="muted text-sm" style={{ marginTop: 6 }}>Save settings before syncing for a changed scope to take effect.</p>
              </div>

              {/* The configured holidays, mirrored from the dedicated admin page
                  so this tab shows what's actually in effect — not just the
                  sync controls. Manage (edit/delete) still lives on /admin/holidays. */}
              {holidays === null ? (
                <p className="muted text-sm" style={{ marginTop: 14 }}>Loading…</p>
              ) : holidays.length === 0 ? (
                <p className="muted text-sm" style={{ marginTop: 14 }}>No holidays configured yet.</p>
              ) : (
                <table className="data" style={{ marginTop: 14 }}>
                  <thead><tr><th>Date</th><th>Name</th><th>Scope</th><th>Applies to</th><th>Blocks bookings?</th></tr></thead>
                  <tbody>
                    {holidays.map((h) => (
                      <tr key={h.id || `${h.holidayDate}-${h.region || ''}`}>
                        <td>{h.holidayDate}</td>
                        <td>{h.name || <span className="muted">—</span>}</td>
                        <td className="small muted">{h.scope || 'manual'}</td>
                        <td className="small">{h.region || <span className="muted">All regions</span>}</td>
                        <td>{h.isBlocker ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          )}
        </div>

        <aside className="preview">
          <div className="muted small"><Eye size={13} /> LIVE PREVIEW {dirty && <span className="preview-dirty">● unsaved</span>}</div>
          <div className="preview-window">
            {/* Brand bar reflects branding + locale on every tab. Fallbacks so a
                freshly-created tenant that hasn't saved a locale/timezone yet
                doesn't render the literal "UNDEFINED". Color runs through the hex
                expander so a half-typed value doesn't break the bar. */}
            <div className="preview-bar" style={{ background: pColor, color: '#fff' }}>
              <strong>{c.brand_name || 'FSD MRBS'}</strong>
              <small style={{ marginLeft: 8, opacity: 0.7 }}>{c.timezone || 'UTC'} · {(c.default_locale || 'en').toUpperCase()}</small>
            </div>
            {/* Tab-aware body: shows whatever the admin is editing. Scrolls so a
                long custom-field form doesn't push the page. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 440, overflowY: 'auto' }}>
              {renderPreviewBody()}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
