import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration for the FSD MRBS mobile shell.
 *
 * The mobile app is the same Vite PWA bundle wrapped in a native shell
 * so we can:
 *   • surface OS-native push notifications (Capacitor Push Notifications
 *     plugin connects to APNs on iOS and FCM on Android; the existing
 *     /api/v1/me/push endpoint accepts the token from either)
 *   • use the device's biometric prompt for the MFA step-up
 *   • scan QR codes for visitor check-in without the camera permission
 *     prompts the browser surfaces every session
 *   • participate in iOS calendar / focus / Live Activities later
 *
 * Build flow: `npm run build` produces dist/, then `npx cap sync` pushes
 * the new web assets into ios/ and android/. The native projects live
 * outside this folder so they can be code-signed independently.
 */
const config: CapacitorConfig = {
  appId: 'hk.gov.fsd.mrbs',
  appName: 'FSD MRBS',
  webDir: 'dist',
  bundledWebRuntime: false,
  server: {
    androidScheme: 'https',
    // For development against a local API:
    //   url: 'http://10.0.2.2:8080',
    //   cleartext: true,
    // For production these MUST be unset so the bundled web assets win.
  },
  ios: {
    contentInset: 'always',
    backgroundColor: '#0C4A3E',
    limitsNavigationsToAppBoundDomains: true,
    // App-bound domains are listed in ios/App/App/Info.plist under
    // WKAppBoundDomains. Only mrbs.fsd.gov.hk + login.microsoftonline.com
    // (for SSO) should appear there.
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    // Set TLS pinning at the OkHttp layer in MainActivity — Capacitor
    // does not expose a JS API for it. See android/app/src/main/.../
    // network_security_config.xml.
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    LocalNotifications: {
      iconColor: '#0C4A3E',
    },
    SplashScreen: {
      launchAutoHide: true,
      launchFadeOutDuration: 200,
      backgroundColor: '#0C4A3E',
    },
    Keyboard: {
      resize: 'native',
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#0C4A3E',
    },
  },
};

export default config;
