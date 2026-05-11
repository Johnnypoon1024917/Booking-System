# SPA — Resource Booking Frontend

Vue 3 + Vite single-page app. Trilingual (EN / 繁體中文 / 简体中文), themable
per tenant, FullCalendar dashboard, QR check-in, kiosk view, real-time
WebSocket updates, PWA-ready.

## Dev

```bash
cd src/presentation/web/spa
npm install
npm run dev          # http://localhost:5173/app/
```

The dev server proxies `/api` and `/api/v1/realtime` to `localhost:8080`,
so run the Go API alongside (`make run-api`).

## Production build

```bash
npm run build        # outputs to dist/
```

The Go API serves `dist/` from `/app/*` automatically (see
`src/cmd/api/main.go`).

## Tenant theming

Brand colors, logo, layout, custom fields, locales, and integration toggles
are loaded from `GET /api/v1/admin/customization` on app boot, then applied
as CSS variables (`--brand-primary`, etc.) and stored in Pinia for any
component to read. The Admin page at `/app/admin` writes the document back.

## Routes

- `/`               → Dashboard (FullCalendar, KPIs, weather banner)
- `/search`         → Resource search & booking
- `/admin`          → Tenant customization (System/Security Admin only)
- `/kiosk/{id}`     → Tablet-at-the-door view (no auth)
