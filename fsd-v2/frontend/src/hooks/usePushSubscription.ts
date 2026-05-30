// usePushSubscription — wires the browser Push API to v2's /api/v1/push
// endpoints. Skips silently when the runtime can't support push (older
// browsers, insecure contexts, denied permission) so callers don't need
// to feature-detect themselves.
//
// API:
//   const { supported, subscribed, subscribe, unsubscribe } = usePushSubscription();
//
// `subscribe()` returns a Promise<boolean> indicating success. It will
// prompt the user for Notification permission if it hasn't been granted
// yet.

import { useCallback, useEffect, useState } from 'react';

const VAPID_KEY_URL = '/api/v1/push/vapid-key';
const SUBSCRIBE_URL = '/api/v1/push/subscribe';
const UNSUBSCRIBE_URL = '/api/v1/push/unsubscribe';
const SW_URL = '/sw.js';

// Convert the URL-safe base64 VAPID public key into the Uint8Array the
// PushManager expects. Browsers won't accept the string form.
function urlBase64ToUint8Array(b64: string): Uint8Array {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const normalized = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function authHeaders(): Record<string, string> {
  const tok = localStorage.getItem('fsd_jwt');
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

export interface UsePushSubscriptionResult {
  supported: boolean;
  subscribed: boolean;
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<void>;
}

export function usePushSubscription(): UsePushSubscriptionResult {
  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  const [subscribed, setSubscribed] = useState(false);

  // Reflect the current SW subscription state on mount so the UI can
  // render the right button label.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) setSubscribed(!!sub);
      } catch {
        if (!cancelled) setSubscribed(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supported]);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!supported) return false;
    if (Notification.permission === 'denied') return false;
    if (Notification.permission !== 'granted') {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return false;
    }
    try {
      const reg = await navigator.serviceWorker.register(SW_URL);
      // Pull the VAPID public key from the server — v2 generates and
      // rotates it server-side so we never hard-code it in the SPA.
      const keyResp = await fetch(VAPID_KEY_URL, { headers: authHeaders() });
      if (!keyResp.ok) return false;
      const { publicKey } = await keyResp.json();
      if (!publicKey) return false;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });
      const resp = await fetch(SUBSCRIBE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!resp.ok) return false;
      setSubscribed(true);
      return true;
    } catch {
      return false;
    }
  }, [supported]);

  const unsubscribe = useCallback(async (): Promise<void> => {
    if (!supported) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Tell the server to drop the row first so we don't keep a
        // stale subscription pointing at a now-revoked endpoint.
        await fetch(UNSUBSCRIBE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => undefined);
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch {
      // Swallow — nothing the caller can do, and we don't want to
      // surface an error from a fire-and-forget cleanup.
    }
  }, [supported]);

  return { supported, subscribed, subscribe, unsubscribe };
}

export default usePushSubscription;
