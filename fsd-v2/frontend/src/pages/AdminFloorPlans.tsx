import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { confirmDialog } from '../stores/confirm';

// Floor plan editor: pick a plan, upload/swap its background image, then
// drag pins (resource → x/y) onto the canvas. Pin coordinates are
// percentages (0..1) so the layout is image-resolution-independent.
type Pin = { resourceId: string; x: number; y: number; label?: string };

export function AdminFloorPlans() {
  const { t } = useT();
  const [plans, setPlans] = useState<any[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [creating, setCreating] = useState<{ name: string } | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);

  useEffect(() => { load(); api.adminResources().then(setResources); }, []);
  function load() { api.floorPlans().then((rows) => {
    setPlans(rows);
    if (rows.length && !selected) setSelected(rows[0]);
  }); }

  async function createPlan() {
    if (!creating?.name) return;
    const p = await api.createFloorPlan({ name: creating.name, pins: [], shapes: [] });
    setCreating(null);
    setPlans((s) => [...s, p]);
    setSelected(p);
  }
  async function removePlan(p: any) {
    if (!(await confirmDialog({ title: t('adminFloorPlans.confirmDelete', { name: p.name }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    await api.deleteFloorPlan(p.id);
    setSelected(null);
    load();
  }
  async function setDefault(p: any) {
    await api.setDefaultFloorPlan(p.id);
    load();
  }
  async function persist(patch: Partial<any>) {
    if (!selected) return;
    const updated = await api.updateFloorPlan(selected.id, { ...selected, ...patch });
    setSelected(updated);
    setPlans((rows) => rows.map((r) => (r.id === updated.id ? updated : r)));
  }

  // Image upload — turned into a data URL. Real deployments will swap
  // this for an /uploads endpoint, but data URLs keep the demo offline.
  async function onImageChosen(f: File) {
    const buf = await f.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const url = `data:${f.type};base64,${b64}`;
    await persist({ imageUrl: url });
  }

  // Drop a resource onto the canvas: appends a new pin at the click
  // coordinates (normalised 0..1).
  function onCanvasClickAdd(e: React.MouseEvent, resourceId: string) {
    if (!canvasRef.current || !selected) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const r = resources.find((rr) => rr.id === resourceId);
    const next: Pin[] = [...(selected.pins ?? []), { resourceId, x, y, label: r?.name }];
    persist({ pins: next });
  }
  function onPinMouseDown(idx: number) { setDraggingIdx(idx); }
  function onPinMouseMove(e: React.MouseEvent) {
    if (draggingIdx === null || !canvasRef.current || !selected) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    const next: Pin[] = (selected.pins ?? []).map((p: Pin, i: number) =>
      i === draggingIdx ? { ...p, x, y } : p,
    );
    setSelected({ ...selected, pins: next });
  }
  function onPinMouseUp() {
    if (draggingIdx !== null) persist({ pins: selected.pins });
    setDraggingIdx(null);
  }
  function removePin(idx: number) {
    if (!selected) return;
    const next = (selected.pins ?? []).filter((_: any, i: number) => i !== idx);
    persist({ pins: next });
  }

  const placedIds = new Set<string>((selected?.pins ?? []).map((p: Pin) => p.resourceId));
  const placeable = resources.filter((r) => !placedIds.has(r.id));

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminFloorPlans.title')}</h1>
        <button className="btn primary" onClick={() => setCreating({ name: '' })}>{t('adminFloorPlans.newPlan')}</button>
      </header>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 220px', gap: 12 }}>
        <aside>
          <h3>{t('adminFloorPlans.plans')}</h3>
          {plans.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 6,
              background: selected?.id === p.id ? 'var(--surface-2)' : 'transparent', borderRadius: 6 }}>
              <button className="btn ghost" style={{ flex: 1, textAlign: 'left' }} onClick={() => setSelected(p)}>
                {p.name} {p.isDefault && <span className="tag ok">{t('adminFloorPlans.default')}</span>}
              </button>
            </div>
          ))}
        </aside>

        <main>
          {selected ? (
            <>
              <div className="row" style={{ gap: 8, marginBottom: 6 }}>
                <strong>{selected.name}</strong>
                <span className="spacer"/>
                <label className="btn ghost">
                  {t('adminFloorPlans.uploadImage')}
                  <input type="file" accept="image/*" style={{ display: 'none' }}
                    onChange={(e) => e.target.files?.[0] && onImageChosen(e.target.files[0])} />
                </label>
                <button className="btn ghost" onClick={() => setDefault(selected)} disabled={selected.isDefault}>{t('adminFloorPlans.makeDefault')}</button>
                <button className="btn danger" onClick={() => removePlan(selected)}>{t('common.delete')}</button>
              </div>
              <div ref={canvasRef}
                style={{
                  position: 'relative', border: '1px solid var(--border)',
                  background: selected.imageUrl ? `center/contain no-repeat url(${selected.imageUrl})` : '#0d1117',
                  width: '100%', aspectRatio: '16/10', minHeight: 420,
                }}
                onMouseMove={onPinMouseMove} onMouseUp={onPinMouseUp} onMouseLeave={onPinMouseUp}
              >
                {(selected.pins ?? []).map((p: Pin, i: number) => (
                  <div key={i} title={p.label || p.resourceId}
                    onMouseDown={() => onPinMouseDown(i)}
                    onDoubleClick={() => removePin(i)}
                    style={{
                      position: 'absolute', left: `${p.x * 100}%`, top: `${p.y * 100}%`,
                      transform: 'translate(-50%, -100%)',
                      background: '#ef4444', color: '#fff', padding: '4px 8px',
                      borderRadius: 6, fontSize: 12, cursor: 'grab',
                      boxShadow: '0 2px 6px rgba(0,0,0,.4)',
                    }}>
                    {p.label || p.resourceId.slice(0, 6)}
                  </div>
                ))}
              </div>
              <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                {t('adminFloorPlans.pinHelp')}
              </p>
            </>
          ) : <p>{t('adminFloorPlans.selectPlan')}</p>}
        </main>

        <aside>
          <h3>{t('adminFloorPlans.placeRooms')}</h3>
          {placeable.length === 0 && <p style={{ color: 'var(--text-dim)' }}>{t('adminFloorPlans.allPlaced')}</p>}
          {placeable.map((r) => (
            <button key={r.id} className="btn ghost" style={{ display: 'block', width: '100%', textAlign: 'left' }}
              onClick={(e) => onCanvasClickAdd(e, r.id)} title={t('adminFloorPlans.clickToDrop')}>
              + {r.name}
            </button>
          ))}
          <p style={{ color: 'var(--text-dim)', fontSize: 11, marginTop: 8 }}>
            {t('adminFloorPlans.placeHelp')}
          </p>
        </aside>
      </div>

      {creating && (
        <Modal title={t('adminFloorPlans.newPlanTitle')} onClose={() => setCreating(null)}
          footer={<><span className="spacer"/><button className="btn ghost" onClick={() => setCreating(null)}>{t('common.cancel')}</button><button className="btn primary" onClick={createPlan}>{t('adminFloorPlans.create')}</button></>}>
          <label>{t('adminFloorPlans.name')}<input value={creating.name} onChange={(e) => setCreating({ name: e.target.value })} /></label>
        </Modal>
      )}
    </div>
  );
}
