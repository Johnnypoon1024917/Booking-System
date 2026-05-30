import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// IoT sensor enrolment + recent reading viewer. Enrol returns the
// plaintext secret EXACTLY ONCE — we display it in a one-shot modal
// and force the admin to confirm before closing.
export function AdminSensors() {
  const { t } = useT();
  const [items, setItems] = useState<any[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [enroling, setEnroling] = useState<any | null>(null);
  const [enrolResult, setEnrolResult] = useState<{ deviceId: string; secret: string } | null>(null);
  const [readings, setReadings] = useState<any[] | null>(null);

  useEffect(() => {
    load();
    api.adminResources().then(setResources);
  }, []);
  function load() { api.sensors().then(setItems); }

  async function doEnrol() {
    try {
      const r = await api.enrolSensor(enroling);
      setEnroling(null);
      setEnrolResult({ deviceId: r.sensor.deviceId, secret: r.secret });
      load();
    } catch (e: any) { await alertDialog({ title: t('adminSensors.enrolFailed'), message: e.displayMessage, tone: 'danger' }); }
  }
  async function toggleActive(s: any) {
    await api.updateSensor(s.id, { isActive: !s.isActive });
    load();
  }
  async function remove(s: any) {
    if (!(await confirmDialog({ title: t('adminSensors.confirmDelete', { id: s.deviceId }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    await api.deleteSensor(s.id); load();
  }
  async function showReadings(s: any) {
    if (!s.resourceId) { await alertDialog({ title: t('adminSensors.bindFirst'), tone: 'danger' }); return; }
    setReadings(await api.sensorReadings(s.resourceId, 100));
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminSensors.title')}</h1>
        <button className="btn primary" onClick={() => setEnroling({ deviceId: '', label: '', resourceId: '' })}>+ {t('adminSensors.enrolDevice')}</button>
      </header>

      <table className="data">
        <thead><tr><th>{t('adminSensors.deviceId')}</th><th>{t('adminSensors.label')}</th><th>{t('adminSensors.resource')}</th><th>{t('adminSensors.lastSeen')}</th><th>{t('common.status')}</th><th></th></tr></thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id}>
              <td><code>{s.deviceId}</code></td>
              <td>{s.label || '—'}</td>
              <td>{resources.find((r) => r.id === s.resourceId)?.name || '—'}</td>
              <td>{s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : 'never'}</td>
              <td><span className={`tag ${s.isActive ? 'ok' : 'bad'}`}>{s.isActive ? t('common.active') : t('adminSensors.disabled')}</span></td>
              <td>
                <button className="btn ghost" onClick={() => showReadings(s)}>{t('adminSensors.readings')}</button>
                <button className="btn ghost" onClick={() => toggleActive(s)}>{s.isActive ? t('adminSensors.disable') : t('adminSensors.enable')}</button>
                <button className="btn danger" onClick={() => remove(s)}>{t('common.delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {enroling && (
        <Modal title={t('adminSensors.enrolSensor')} onClose={() => setEnroling(null)}
          footer={<><span className="spacer"/><button className="btn ghost" onClick={() => setEnroling(null)}>{t('common.cancel')}</button><button className="btn primary" onClick={doEnrol}>{t('adminSensors.enrol')}</button></>}>
          <label>{t('adminSensors.deviceId')}<input value={enroling.deviceId} onChange={(e) => setEnroling({ ...enroling, deviceId: e.target.value })} /></label>
          <label>{t('adminSensors.label')}<input value={enroling.label} onChange={(e) => setEnroling({ ...enroling, label: e.target.value })} /></label>
          <label>{t('adminSensors.bindToResource')}
            <select value={enroling.resourceId || ''} onChange={(e) => setEnroling({ ...enroling, resourceId: e.target.value || undefined })}>
              <option value="">{t('adminSensors.none')}</option>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
        </Modal>
      )}

      {enrolResult && (
        <Modal title={t('adminSensors.secretTitle')} onClose={() => setEnrolResult(null)}
          footer={<><span className="spacer"/><button className="btn primary" onClick={() => setEnrolResult(null)}>{t('adminSensors.copiedIt')}</button></>}>
          <p>{t('adminSensors.secretBody')}</p>
          <p>{t('adminSensors.deviceId')}: <code>{enrolResult.deviceId}</code></p>
          <pre style={{ background: 'var(--surface-2)', padding: 8, borderRadius: 4 }}>{enrolResult.secret}</pre>
        </Modal>
      )}

      {readings && (
        <Modal title={t('adminSensors.recentReadings')} onClose={() => setReadings(null)}>
          <table className="data">
            <thead><tr><th>{t('adminSensors.observedAt')}</th><th>{t('adminSensors.occupancy')}</th><th>{t('adminSensors.extra')}</th></tr></thead>
            <tbody>
              {readings.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.observedAt).toLocaleString()}</td>
                  <td>{r.occupancy}</td>
                  <td><code style={{ fontSize: 11 }}>{r.extra ? JSON.stringify(r.extra) : '—'}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  );
}
