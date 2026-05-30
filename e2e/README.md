# FSD Booking System — E2E + UI/UX quality automation

Playwright suite that treats the running SPA the way an **enterprise QA team**
would before signing off a product-grade booking system. Two layers:

1. **Functional regression guards** — drive the core booking flows and pin the
   QA-reported logic bugs.
2. **UI/UX quality audit** — sweep *every* page for the "look & view" defects:
   blank screens, console/network errors, layout overflow, broken responsive
   behaviour, accessibility violations, and visual regressions (light + dark).

It is **stack-agnostic** — point it at the Node/React stack or the Go/Vue stack
with one env var.

## What it covers

### UI/UX quality (runs against the cached admin session — all pages)

| Spec | What it proves | Defect class it catches |
|------|----------------|-------------------------|
| `ui-smoke.spec.ts` | Every route renders content, no JS/console errors, no failed APIs | Blank "dashboard shows nothing" screens, broken endpoints |
| `layout-overflow.spec.ts` | No page-level horizontal scroll at 1440px; names offending elements | Tables/charts/rows spilling past the viewport |
| `responsive.spec.ts` | User journeys fit phone (375) / tablet (768) / laptop (1440) | Mobile/tablet layout breakage |
| `accessibility.spec.ts` | No serious/critical axe (WCAG 2.1 AA) violations | Contrast, missing labels, ARIA misuse |
| `visual.spec.ts` | Pixel baselines per page in **light + dark** | Unreadable dark-mode sidebar/cards, visual drift |
| `dashboard.spec.ts` | Not blank; vertical bar chart; outcomes sum to 100%; dept total = stat total | The dashboard data/chart cluster |

### Functional regression guards (need a regular-user password — else skipped)

| Spec | Flow | Guards QA bug |
|------|------|---------------|
| `core-booking.spec.ts` | All-day search returns normal-hours rooms | **#2** all-day required 24h |
| `core-booking.spec.ts` | Book a slot → re-search → room no longer offered | **#1** booked slot shown free (timezone overlap) |
| `core-booking.spec.ts` | Recurring booking → My Bookings shows series | **#4** recurrence silently dropped |
| `my-bookings.spec.ts` | Card headings are names, never UUIDs | **#7** raw resource UUID heading |
| `my-bookings.spec.ts` | Upcoming tab/count excludes Cancelled | **#11** cancelled counted as upcoming |

These complement the fast unit tests already in the repo (Go `*_test.go`,
Node `*.spec.ts`).

## Setup

```bash
cd e2e
npm install
npm run install:browsers      # one-time: downloads Chromium
cp .env.example .env          # tweak target/credentials if needed
```

## Choose a target stack

Set `E2E_BASE_URL` in `.env`:

| Target | URL |
|--------|-----|
| **Node/React (docker)** | `http://localhost:5173` |
| Go binary serving the Vue SPA | `http://localhost:8080` |
| Node API serving a built SPA | `http://localhost:3000` |

The backend must be running with a **seeded** tenant (`fsd-v2`: bring it up with
`SEED_DEMO=true`). The UI/UX suite authenticates once as the admin
(`E2E_ADMIN_*`, defaults to the dev `admin/admin`) and caches the session, so
no per-test login. The functional booking specs additionally need
`E2E_USER_PASSWORD`; leave it blank to skip just those.

## Run

```bash
npm test                # everything (auth setup runs first automatically)

npm run smoke           # blank-screen / console / network health sweep
npm run layout          # overflow + responsive breakpoints
npm run a11y            # accessibility (axe WCAG 2.1 AA)
npm run dashboard       # dashboard data-integrity guards
npm run functional      # core booking-flow regressions (needs user password)

npm run visual:update   # FIRST TIME: create the visual baselines
npm run visual          # compare against baselines (light + dark)

npm run test:headed     # watch it drive the browser
npm run test:ui         # Playwright UI mode (pick/replay tests)
npm run report          # open the last HTML report (traces, screenshots, video)
```

### Visual baselines

`visual.spec.ts` has no committed baselines on first run. Generate them once
against a known-good build with `npm run visual:update`, review the images under
`tests/visual.spec.ts-snapshots/`, then commit them. Subsequent `npm run visual`
runs fail on any pixel drift beyond the 2% antialiasing tolerance. Live regions
(clock, weather chip, broadcast ticker) are masked so they don't cause flakiness.

## How it works

- **One login, cached.** `auth.setup.ts` is a Playwright *setup project*: it logs
  in as admin and writes `playwright/.auth/admin.json` (gitignored). The
  `chromium` project depends on it and reuses the storage state — every page is
  reachable without re-authenticating.
- **Real defects only.** `collectHealth()` filters known browser noise (favicons,
  source maps, HMR, ResizeObserver, the optional weather endpoint) so a console
  or network failure in a report is a genuine bug.
- **Triage-friendly failures.** Overflow/responsive failures print the offending
  `<tag class…>` and its right-edge px; a11y failures print the rule + selector.

## Run status / blocker

The suite is complete and compiles (`npx playwright test --list` → **143 tests**).
A full live run has **not yet produced results**: the currently-running Node
container is unhealthy —

```
POST /api/v1/auth/login  →  HTTP 500   (verified by direct curl, every account)
```

Login 500s, so the auth-setup project can't establish the cached session and the
suite can't proceed. This is a **stale / un-reseeded container** (the stack was
last brought down with `docker compose down -v`), not a test defect.

**To unblock and capture the real baseline** (cmd.exe):

```cmd
cd fsd-v2
set SEED_DEMO=true
docker compose up -d --build
```

Verify login returns HTTP 200, then run the sweep:

```bash
cd ../e2e
npm test
```

Results will be recorded here from that first green-stack run. The table is left
empty on purpose rather than filled with estimates:

| Suite | Result |
|-------|--------|
| `ui-smoke` | _pending live run_ |
| `layout-overflow` | _pending live run_ |
| `responsive` | _pending live run_ |
| `accessibility` | _pending live run_ |
| `dashboard` | _pending live run_ |
| `visual` | baseline pending (`npm run visual:update`) |

> Overflow-gate note: the gate samples twice after full settle and requires the
> overflow to *persist*, so it reports real layout defects rather than transient
> mid-load width during data fetches.

## Notes / next steps

- Selectors prefer roles/labels/visible text and the app's stable class hooks
  (`.fsd-*`, `.vbar-*`, `.legend`). As pages gain `data-testid`s, tighten them.
- Suggested additions once green: an **admin approve-a-booking** functional flow,
  keyboard-only navigation, and per-component (not just per-page) visual snapshots.
