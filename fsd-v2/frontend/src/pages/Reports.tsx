import { useState } from 'react';
import { api } from '../api/client';
import { useT } from '../hooks/useT';

// Mirrors v1's Reports.vue.

interface ReportTable {
  type: string;
  headers: string[];
  rows: string[][];
  totalHours?: number;
  generatedAt: string;
  start: string;
  end: string;
}

const TYPES: { value: string; labelKey: string }[] = [
  { value: 'summary', labelKey: 'reports.typeSummary' },
  { value: 'usage',   labelKey: 'reports.typeUsage' },
  { value: 'staff',   labelKey: 'reports.typeStaff' },
  { value: 'noshow',  labelKey: 'reports.typeNoShow' },
  { value: 'audit',   labelKey: 'reports.typeAudit' },
  { value: 'medical', labelKey: 'reports.typeMedical' },
  { value: 'addl',    labelKey: 'reports.typeAddl' },
];

function lastNDays(n: number) {
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const end = new Date();
  const start = new Date(); start.setDate(end.getDate() - n);
  return { start: iso(start), end: iso(end) };
}

function filenameFromHeaders(headers: any, fallback: string): string {
  const cd = String(headers['content-disposition'] || '');
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return m ? decodeURIComponent(m[1]) : fallback;
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Reports() {
  const { t } = useT();
  const init = lastNDays(30);
  const [type, setType]   = useState<string>('summary');
  const [start, setStart] = useState<string>(init.start);
  const [end, setEnd]     = useState<string>(init.end);
  const [table, setTable] = useState<ReportTable | null>(null);
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState<string | null>(null);

  async function loadTable() {
    setBusy(true); setErr(null);
    try { setTable(await api.reportTable(type, start, end)); }
    catch (e: any) { setErr(e?.displayMessage || t('reports.loadFailed')); setTable(null); }
    finally { setBusy(false); }
  }

  async function download(format: 'csv' | 'xlsx') {
    setBusy(true); setErr(null);
    try {
      const res = await api.exportReport(type, format, start, end);
      const fallback = `${type}_report.${format}`;
      triggerDownload(res.data as Blob, filenameFromHeaders(res.headers, fallback));
    } catch (e: any) { setErr(e?.displayMessage || t('reports.exportFailed')); }
    finally { setBusy(false); }
  }

  async function downloadMyData() {
    setBusy(true); setErr(null);
    try {
      const res = await api.dsarExportMe();
      triggerDownload(res.data as Blob, filenameFromHeaders(res.headers, 'my-data.json'));
    } catch (e: any) { setErr(e?.displayMessage || t('reports.dsarFailed')); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <h1 className="fsd-page-title">{t('reports.title')} <small>{t('reports.pageSubtitle')}</small></h1>

      <div className="fsd-card fsd-form">
        <div className="fsd-card-title">{t('reports.generateReport')}</div>
        <div className="fld-grid-3">
          <div className="fld">
            <label>{t('reports.report')}</label>
            <select aria-label={t('reports.report')} value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((rt) => <option key={rt.value} value={rt.value}>{t(rt.labelKey)}</option>)}
            </select>
          </div>
          <div className="fld">
            <label>{t('reports.start')}</label>
            <input type="date" aria-label={t('reports.start')} value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="fld">
            <label>{t('reports.end')}</label>
            <input type="date" aria-label={t('reports.end')} value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <div className="btn-row">
          <button className="btn-fsd" onClick={loadTable} disabled={busy}>{t('reports.viewTable')}</button>
          <button className="btn-fsd ghost" onClick={() => download('csv')} disabled={busy}>{t('reports.exportCsv')}</button>
          <button className="btn-fsd ghost" onClick={() => download('xlsx')} disabled={busy}>{t('reports.exportXlsx')}</button>
        </div>
        {err && <div className="fsd-alert danger" style={{ marginTop: 10 }}>{err}</div>}
      </div>

      {table && (
        <div className="fsd-card">
          <div className="fsd-card-title">
            {(() => { const rt = TYPES.find((x) => x.value === table.type); return rt ? t(rt.labelKey) : table.type; })()}
            <span className="picker">{table.start} → {table.end}</span>
          </div>
          {!table.rows.length && <p className="muted">{t('reports.noRows')}</p>}
          {!!table.rows.length && (
            <div style={{ overflowX: 'auto' }}>
              <table className="dt">
                <thead><tr>{table.headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
                <tbody>
                  {table.rows.map((r, i) => (
                    <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
                  ))}
                </tbody>
                {table.totalHours !== undefined && (
                  <tfoot>
                    <tr>
                      <td colSpan={table.headers.length - 1}><strong>{t('reports.totalHours')}</strong></td>
                      <td><strong>{table.totalHours.toFixed(1)}</strong></td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          <p className="muted text-sm" style={{ marginTop: 8 }}>
            {t('reports.rowCount', { count: table.rows.length })} · {t('reports.generated', { time: new Date(table.generatedAt).toLocaleString() })}
          </p>
        </div>
      )}

      <div className="fsd-card">
        <div className="fsd-card-title">{t('reports.dsarTitle')}</div>
        <p className="muted text-sm">
          {t('reports.dsarHelp')}
        </p>
        <button className="btn-fsd" onClick={downloadMyData} disabled={busy}>{t('reports.dsarDownload')}</button>
      </div>
    </div>
  );
}
