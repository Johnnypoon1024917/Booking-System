import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import { useT } from '../hooks/useT';
import { useIdleTimer } from '../hooks/useIdleTimer';

// Walk-away idle window for the shared tablet. After this long with no touch we
// discard any transient state and return to the clean default screen so the
// next person never inherits the previous user's session.
const KIOSK_IDLE_MS = 45_000;

// Kiosk display — full-screen, no app shell. Designed for a wall-mounted
// tablet outside the meeting room. Auto-refreshes every 30s. Polls the
// public /kiosk/:id/state endpoint and shows current/next bookings plus
// a Walk-in button that calls quick-book on the public endpoint.
//
// Auth: optional X-Kiosk-Token header. Operators set it once via
// localStorage('fsd_kiosk_token') on the device.

function fmtTime(d: string | Date) {
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function Kiosk() {
  const { t } = useT();
  const { resourceId } = useParams<{ resourceId: string }>();
  const [state, setState] = useState<any | null>(null);
  const [now, setNow] = useState(new Date());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!resourceId) return;
    function tick() { api.kioskState(resourceId!).then(setState).catch(() => setState(null)); }
    tick();
    const id1 = setInterval(tick, 30_000);
    const id2 = setInterval(() => setNow(new Date()), 1_000);
    return () => { clearInterval(id1); clearInterval(id2); };
  }, [resourceId]);

  // Shared-device reset: after 45s of no interaction, drop any lingering
  // walk-in confirmation/error and re-pull a fresh state so the screen returns
  // to its default available/in-use view for the next person (QA: kiosk
  // "walk-away" leak). The kiosk has no half-filled form to discard, so clearing
  // the transient message and refreshing state is the full reset here.
  useIdleTimer(KIOSK_IDLE_MS, () => {
    setMsg(null);
    setBusy(false);
    if (resourceId) api.kioskState(resourceId).then(setState).catch(() => {});
  });

  async function walkIn(minutes: number) {
    if (!resourceId) return;
    setBusy(true); setMsg(null);
    try {
      await api.kioskQuickBook(resourceId, { durationMinutes: minutes, title: 'Walk-in' });
      setMsg(t('kiosk.bookedForMinutes', { minutes }));
      const s = await api.kioskState(resourceId);
      setState(s);
    } catch (e: any) {
      setMsg(e.displayMessage || t('kiosk.couldNotBook'));
    } finally { setBusy(false); }
  }

  if (!state) {
    return <div style={shellStyle}><div>{t('common.loading')}</div></div>;
  }
  const inUse = !!state.current;

  return (
    <div style={{ ...shellStyle, background: inUse ? '#7f1d1d' : '#14532d' }}>
      <div style={{ position: 'absolute', top: 24, right: 32, fontSize: 28, opacity: .8 }}>
        {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </div>
      <div style={{ position: 'absolute', top: 24, left: 32, fontSize: 22, opacity: .8 }}>
        {state.resource.location || ''}
      </div>

      <div style={{ textAlign: 'center', maxWidth: 920 }}>
        <h1 style={{ fontSize: 96, margin: 0, letterSpacing: -2 }}>{state.resource.name}</h1>
        <p style={{ fontSize: 28, opacity: .8 }}>{t('common.capacity')} {state.resource.capacity}</p>
        <h2 style={{ fontSize: 72, margin: '24px 0' }}>{inUse ? t('kiosk.inUse') : t('kiosk.available')}</h2>

        {inUse && state.current && (
          <p style={{ fontSize: 32 }}>{t('kiosk.untilTime', { time: fmtTime(state.current.end) })}</p>
        )}
        {!inUse && state.next && (
          <p style={{ fontSize: 32 }}>{t('kiosk.nextBookingAt', { time: fmtTime(state.next.start) })}</p>
        )}

        {!inUse && (
          <div style={{ marginTop: 48, display: 'flex', gap: 16, justifyContent: 'center' }}>
            {[15, 30, 60].map((m) => (
              <button key={m} disabled={busy}
                onClick={() => walkIn(m)}
                style={kioskBtnStyle}>
                {t('kiosk.bookMin', { minutes: m })}
              </button>
            ))}
          </div>
        )}

        {msg && <p style={{ marginTop: 32, fontSize: 22 }}>{msg}</p>}
      </div>

      <div style={{ position: 'absolute', bottom: 24, left: 32, right: 32, opacity: .7 }}>
        <strong>{t('common.today')}</strong>{' '}
        {state.agenda.length === 0 ? <em>{t('kiosk.noBookings')}</em> :
          state.agenda.map((e: any, i: number) =>
            <span key={i} style={{ marginRight: 16 }}>{fmtTime(e.start)} – {fmtTime(e.end)}</span>)}
      </div>
    </div>
  );
}

const shellStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, display: 'flex',
  alignItems: 'center', justifyContent: 'center',
  color: '#fff', fontFamily: 'system-ui, sans-serif',
  background: '#0f172a',
};
const kioskBtnStyle: React.CSSProperties = {
  fontSize: 28, padding: '20px 36px', border: 'none',
  borderRadius: 12, background: '#fff', color: '#111',
  cursor: 'pointer', boxShadow: '0 6px 12px rgba(0,0,0,.3)',
};
