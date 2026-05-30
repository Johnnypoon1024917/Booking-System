import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Palette, Languages, LayoutGrid, GitBranch, ListChecks, Plug, CalendarDays,
  RefreshCcw, RotateCcw, Save, Plus, Trash2, X, CloudRain, Calendar, Mail, MessageSquare, Eye,
} from 'lucide-react';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
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

export function TenantStudio() {
  const toast = useToast();
  const [c, setC] = useState<any | null>(null);
  const [baseline, setBaseline] = useState('');
  const [tab, setTab] = useState<typeof TABS[number]['key']>('branding');
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    api.customization().then((d) => { setC(d); setBaseline(JSON.stringify(d)); });
  }, []);

  if (!c) return <p className="muted">Loading…</p>;
  const dirty = baseline !== JSON.stringify(c);
  const set = (k: string, v: any) => setC({ ...c, [k]: v });
  const arr = (k: string): any[] => c[k] || [];
  const toggleIn = (k: string, v: any) =>
    set(k, arr(k).includes(v) ? arr(k).filter((x) => x !== v) : [...arr(k), v]);

  async function save() {
    setBusy(true);
    try {
      // Drop blank custom-field option lines that accumulate while typing.
      const cleaned = { ...c, custom_fields: (c.custom_fields || []).map((f: any) =>
        f.type === 'select' ? { ...f, options: (f.options || []).filter((o: string) => o.trim()) } : f) };
      const saved = await api.saveCustomization(cleaned);
      setC(saved); setBaseline(JSON.stringify(saved));
      toast.success('Customization saved');
    } catch (e: any) { toast.error('Save failed', e.displayMessage || e.message); }
    finally { setBusy(false); }
  }
  function reset() { setC(JSON.parse(baseline)); }
  async function syncHolidays() {
    setSyncing(true);
    try { const r = await api.syncHKHolidays(); toast.success(`Synced ${r?.count ?? ''} holidays`.trim()); }
    catch (e: any) { toast.error('Sync failed', e.displayMessage || e.message); }
    finally { setSyncing(false); }
  }

  // Custom-field helpers
  function addField() {
    set('custom_fields', [...arr('custom_fields'), { key: '', type: 'text', required: false, label: { en: '', 'zh-Hant': '', 'zh-Hans': '' }, options: [] }]);
  }
  function patchField(i: number, patch: any) {
    set('custom_fields', arr('custom_fields').map((f, idx) => idx === i ? { ...f, ...patch } : f));
  }
  function removeField(i: number) { set('custom_fields', arr('custom_fields').filter((_, idx) => idx !== i)); }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Tenant Studio</h1>
          <p className="muted">Branding, locale, layout, workflow, fields, and integrations.</p>
        </div>
        <div className="row gap-sm" style={{ alignItems: 'center' }}>
          {dirty && <span className="dirty-chip">● Unsaved changes</span>}
          <button className="btn-fsd ghost" onClick={syncHolidays} disabled={syncing}><RefreshCcw size={14} className={syncing ? 'spin' : ''} /> Sync holidays</button>
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
                      <input type="color" value={c[k] || '#002147'} onChange={(e) => set(k, e.target.value)} />
                      <input type="text" value={c[k] || ''} onChange={(e) => set(k, e.target.value)} />
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
              <p className="text-sm muted">Which panels appear on the dashboard (empty = all).</p>
              <div className="chip-list">
                {arr('dashboard_widgets').map((w, i) => (
                  <span key={w} className="chip active">{w}
                    <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => set('dashboard_widgets', arr('dashboard_widgets').filter((_, idx) => idx !== i))} aria-label="remove"><X size={12} /></button>
                  </span>
                ))}
                <select className="chip" value="" onChange={(e) => { if (e.target.value) set('dashboard_widgets', [...arr('dashboard_widgets'), e.target.value]); }}>
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
                      <input type="checkbox" checked={!arr('report_types').length || arr('report_types').includes(r.key)} onChange={() => toggleIn('report_types', r.key)} /> {r.label}
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
            </section>
          )}

          {tab === 'fields' && (
            <section className="card">
              {arr('custom_fields').map((f: any, i: number) => (
                <div key={i} className="card" style={{ background: 'var(--surface-inset)', marginBottom: 12 }}>
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
                { icon: Calendar, key: 'gov_hk_holiday_feed', title: 'gov.hk holidays', help: 'Auto-import Hong Kong public holidays nightly.' },
                { icon: Mail, key: 'outlook_sync_enabled', title: 'Outlook sync', help: 'Microsoft Graph two-way sync to room mailboxes.' },
                { icon: MessageSquare, key: 'teams_app_enabled', title: 'Teams app', help: 'Book and manage rooms from inside Microsoft Teams.' },
              ].map((row) => (
                <div key={row.key} className="integration-row">
                  <row.icon size={20} className="muted" />
                  <div className="space"><b>{row.title}</b><p className="muted text-sm">{row.help}</p></div>
                  <Switch checked={!!c[row.key]} onChange={(v) => set(row.key, v)} label={row.title} />
                </div>
              ))}
              <div style={{ marginTop: 16 }}>
                <label className="field"><span>Zoom mask base URL</span>
                  <input value={c.zoom_mask_base || ''} placeholder="https://ess.example/redirect" onChange={(e) => set('zoom_mask_base', e.target.value)} />
                </label>
              </div>
            </section>
          )}

          {tab === 'holidays' && (
            <section className="card">
              <p className="muted text-sm">Sync from gov.hk or add tenant-specific dates manually.</p>
              <div className="row gap-sm">
                <button className="btn-fsd" onClick={syncHolidays} disabled={syncing}><RefreshCcw size={14} className={syncing ? 'spin' : ''} /> Sync holidays</button>
                <Link className="btn-fsd ghost" to="/admin/holidays"><Plus size={14} /> Add manually</Link>
              </div>
            </section>
          )}
        </div>

        <aside className="preview">
          <div className="muted small"><Eye size={13} /> LIVE PREVIEW {dirty && <span className="preview-dirty">● unsaved</span>}</div>
          <div className="preview-window">
            <div className="preview-bar" style={{ background: c.brand_primary, color: '#fff' }}>
              <strong>{c.brand_name || 'FSD MRBS'}</strong>
              <small style={{ marginLeft: 8, opacity: 0.7 }}>{c.timezone} · {String(c.default_locale).toUpperCase()}</small>
            </div>
            <div className="preview-card" style={{ borderLeft: `3px solid ${c.brand_primary}` }}>
              <small>BOARDROOM A</small>
              <h4>09:00 – 10:00</h4>
              <button style={{ background: c.brand_primary, color: '#fff' }}>Reserve</button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
