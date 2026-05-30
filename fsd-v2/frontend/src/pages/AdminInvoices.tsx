import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// Monthly charge-back rollup. "Run" materialises Draft invoices for the
// chosen period; admins then Issue (lock for billing) and Mark paid.
function fmtCents(c: number) { return (c / 100).toFixed(2); }
function currentPeriod() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

export function AdminInvoices() {
  const { t } = useT();
  const [items, setItems] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [period, setPeriod] = useState(currentPeriod());
  const [taxRate, setTaxRate] = useState(0);
  const [detail, setDetail] = useState<any | null>(null);

  useEffect(() => { load(); }, [statusFilter]);
  function load() { api.invoices(statusFilter || undefined).then(setItems); }

  async function run() {
    try {
      await api.runInvoices(period, taxRate);
      load();
    } catch (e: any) { await alertDialog({ title: t('adminInvoices.rollupFailed'), message: e.displayMessage, tone: 'danger' }); }
  }
  async function issue(r: any) { await api.issueInvoice(r.id); load(); }
  async function paid(r: any) { await api.markInvoicePaid(r.id); load(); }
  async function cancel(r: any) { await api.cancelInvoice(r.id); load(); }
  async function remove(r: any) {
    if (!(await confirmDialog({ title: t('adminInvoices.confirmDelete', { id: r.id.slice(0, 8) }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    await api.deleteInvoice(r.id); load();
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminInvoices.title')}</h1>
        <div className="row" style={{ gap: 8 }}>
          <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" style={{ width: 100 }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {t('adminInvoices.tax')}<input type="number" step="0.01" min={0} max={1} value={taxRate} onChange={(e) => setTaxRate(+e.target.value)} style={{ width: 80 }} />
          </label>
          <button className="btn primary" onClick={run}>{t('adminInvoices.runRollup')}</button>
        </div>
      </header>

      <div className="row" style={{ gap: 8, marginBottom: 8 }}>
        <select aria-label={t('adminInvoices.allStatuses')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">{t('adminInvoices.allStatuses')}</option>
          <option value="Draft">{t('adminInvoices.statusDraft')}</option><option value="Issued">{t('adminInvoices.statusIssued')}</option><option value="Paid">{t('adminInvoices.statusPaid')}</option><option value="Cancelled">{t('adminInvoices.statusCancelled')}</option>
        </select>
      </div>

      <table className="data">
        <thead><tr><th>{t('adminInvoices.colPeriod')}</th><th>{t('adminInvoices.colDepartment')}</th><th>{t('adminInvoices.colLines')}</th><th>{t('adminInvoices.colSubtotal')}</th><th>{t('adminInvoices.colTax')}</th><th>{t('adminInvoices.colTotal')}</th><th>{t('common.status')}</th><th></th></tr></thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td>{r.period}</td>
              <td><code>{r.departmentId?.slice(0, 8) || '—'}</code></td>
              <td>{Array.isArray(r.lines) ? r.lines.length : 0}</td>
              <td>{fmtCents(r.subtotalCents)}</td>
              <td>{fmtCents(r.taxCents)}</td>
              <td><strong>{fmtCents(r.totalCents)}</strong></td>
              <td><span className="tag">{r.status}</span></td>
              <td>
                <button className="btn ghost" onClick={() => setDetail(r)}>{t('adminInvoices.view')}</button>
                {r.status === 'Draft' && <button className="btn ghost" onClick={() => issue(r)}>{t('adminInvoices.issue')}</button>}
                {r.status === 'Issued' && <button className="btn ghost" onClick={() => paid(r)}>{t('adminInvoices.markPaid')}</button>}
                {(r.status === 'Draft' || r.status === 'Issued') && <button className="btn ghost" onClick={() => cancel(r)}>{t('common.cancel')}</button>}
                <button className="btn danger" onClick={() => remove(r)}>{t('common.delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {detail && (
        <Modal title={t('adminInvoices.detailTitle', { period: detail.period, total: fmtCents(detail.totalCents) })} onClose={() => setDetail(null)}>
          <table className="data">
            <thead><tr><th>{t('adminInvoices.colBooking')}</th><th>{t('adminInvoices.colDescription')}</th><th>{t('adminInvoices.colQty')}</th><th>{t('adminInvoices.colUnit')}</th><th>{t('adminInvoices.colLine')}</th></tr></thead>
            <tbody>
              {(detail.lines as any[]).map((l, i) => (
                <tr key={i}>
                  <td><code>{l.bookingId?.slice(0, 8) ?? '—'}</code></td>
                  <td>{l.description || '—'}</td>
                  <td>{l.quantity}</td>
                  <td>{fmtCents(l.unitCents)}</td>
                  <td>{fmtCents(l.lineCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
