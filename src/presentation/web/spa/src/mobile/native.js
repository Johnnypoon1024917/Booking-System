// Native-app glue. Loaded by the SPA bootstrap; no-op when running in
// the browser (Capacitor.isNativePlatform() returns false).
//
// Currently wires:
//   • OS push tokens (APNs / FCM) into the existing /api/v1/me/push
//     endpoint so the server can fan booking notifications out via the
//     same code path as Web Push.
//   • Biometric prompt as the MFA second factor when the user has TOTP
//     enrolled — saves them typing the 6-digit code on a phone.
//
// Everything here is best-effort: a thrown error is logged but never
// blocks the SPA from starting.

let cap = null;
try {
  cap = await import('@capacitor/core');
} catch (e) { /* not bundled in the web build */ }

export function isNative() {
  return cap && cap.Capacitor && cap.Capacitor.isNativePlatform();
}

export async function registerNativePush(api) {
  if (!isNative()) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive !== 'granted') {
      perm = await PushNotifications.requestPermissions();
    }
    if (perm.receive !== 'granted') return;
    await PushNotifications.register();
    PushNotifications.addListener('registration', async (token) => {
      // The server side accepts the same shape Web Push subscriptions use.
      // For native we put the OS token in the `endpoint` slot and tag it
      // so the dispatcher can route to APNs/FCM later.
      const platform = cap.Capacitor.getPlatform();
      await api.post('/api/v1/me/push', {
        endpoint: `native:${platform}:${token.value}`,
        keys: { p256dh: 'native', auth: 'native' },
      });
    });
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const url = action?.notification?.data?.url;
      if (url) window.location.hash = url;
    });
  } catch (e) {
    console.warn('native push registration failed', e);
  }
}

export async function biometricPrompt(reason) {
  if (!isNative()) return false;
  try {
    const { NativeBiometric } = await import('@capgo/capacitor-native-biometric');
    const available = await NativeBiometric.isAvailable();
    if (!available.isAvailable) return false;
    await NativeBiometric.verifyIdentity({
      reason: reason || 'Confirm your identity',
      title: 'FSD MRBS',
      subtitle: 'Biometric verification',
    });
    return true;
  } catch (e) {
    console.warn('biometric prompt failed', e);
    return false;
  }
}
