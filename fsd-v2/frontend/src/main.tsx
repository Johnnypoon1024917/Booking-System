import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { useAuth } from './hooks/useAuth';
import { api } from './api/client';
import './i18n/config';
import './styles/index.css';

// Register the push service worker once per page-load. Guarded so older
// browsers / insecure contexts don't throw — usePushSubscription handles
// the subscribe handshake on demand.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

// SSO finish handoff: the SAML ACS and OAuth2 callback endpoints both
// redirect back to the SPA with `#token=...` in the fragment. Pick it
// up before React mounts so the rest of the app sees the user as
// already logged in.
(() => {
  const m = window.location.hash.match(/(?:^|&)token=([^&]+)/);
  if (!m) return;
  const token = decodeURIComponent(m[1]);
  history.replaceState({}, '', window.location.pathname + window.location.search);
  localStorage.setItem('fsd_jwt', token);
  api.me().then((u) => useAuth.getState().login(token, u)).catch(() => {});
})();

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
