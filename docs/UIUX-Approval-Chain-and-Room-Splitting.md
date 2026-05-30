# FSD Room Booking System — UI/UX Design Specification
## Approval Chain Builder & Tracking · Room Splitting (Shared Internal Spaces)

Version 1.0 · Status: Design proposal for review

This document specifies the recommended UI/UX for two areas the FSD system
already has backend primitives for but needs a cohesive front-end design:

1. **Creating an approval chain and tracking approval status.**
   Backend already present: `approval_rules`, `approval_steps`,
   `ApprovalChainUseCase.Materialize`, `/api/v1/admin/approval-rules`,
   `/api/v1/approvals`, `/api/v1/approvals/{id}/chain`.
2. **Room splitting for shared internal spaces.**
   Backend already present: composite parent/child resources
   (`CompositeMode`, `SharedCapacity`, `IsShared()`),
   `POST /api/v1/admin/resources/{id}/split`.
   *Note: this is an internal-use system — there is no pricing,
   billing, or commercial rate anywhere in this design.*

The design follows the established Deep Slate/Navy design system
(`.mrbs` skin, emerald = available/approved, crimson = blocked/rejected,
amber = pending/awaiting).

---

# Part A — Approval Chain: Builder & Status Tracking

## A.1 Problem & goals

An approval chain decides, for a given booking, **who must approve, in what
order, and what happens on timeout**. Admins need to author rules without
reading documentation; approvers need a fast queue; requesters need to see
exactly where their request is stuck and why.

Design goals:

- **Authoring is visual, not form-soup.** A rule reads like a sentence:
  *"When `Training Rooms` are booked by `General User` for `> 2h`,
  route to `Room Admin` → then `Security Admin`, auto-escalate after 24h."*
- **Status is a timeline, not a status word.** Every stakeholder sees the
  same horizontal stepper with timestamps, actor, and SLA countdown.
- **No dead ends.** Every pending state shows the next action and who owns it.

## A.2 Information architecture

```
System Settings
└─ Approvals
   ├─ Rules            (admin: author/orders/conditions)        ← Builder
   ├─ Pending Queue    (approver: act on requests)              ← Inbox
   └─ Request Detail   (everyone: timeline + audit)             ← Tracker
```

## A.3 The Rule Builder (admin)

A rule = **Conditions** (when it applies) + **Chain** (ordered approver
levels) + **Policy** (SLA, escalation, auto-approve fallbacks).

Recommended layout: a two-pane screen — left = rule list, right = the
selected rule rendered as an editable **sentence + chain canvas**.

```
┌ Approval Rules ───────────────────────────────────────────────────────────┐
│ + New rule                                                                 │
│ ┌───────────────┐  ┌──────────────────────────────────────────────────┐   │
│ │ ▸ Training >2h │  │  RULE: "Training Rooms · long bookings"           │   │
│ │ ▸ VIP rooms    │  │  ───────────────────────────────────────────────│   │
│ │ ▸ Weekend      │  │  WHEN  [Resource type ▾ Training Room]           │   │
│ │ ▸ Default      │  │        [Booked by ▾ General User]                │   │
│ │                │  │        [Duration  ▾ greater than ▾ [2] hours]    │   │
│ │                │  │        [+ add condition]                          │   │
│ │                │  │                                                  │   │
│ │                │  │  THEN route through:                              │   │
│ │                │  │   ┌───────┐   ┌───────┐   ┌───────────┐          │   │
│ │                │  │   │ L1    │ → │ L2    │ → │ + add step│          │   │
│ │                │  │   │ Room  │   │ Sec.  │   └───────────┘          │   │
│ │                │  │   │ Admin │   │ Admin │                          │   │
│ │                │  │   │ ⋮ drag│   │ ⋮ drag│                          │   │
│ │                │  │   └───────┘   └───────┘                          │   │
│ │                │  │                                                  │   │
│ │                │  │  POLICY                                          │   │
│ │                │  │   SLA per step: [24] h                           │   │
│ │                │  │   On timeout:  (•) escalate to next              │   │
│ │                │  │                ( ) auto-approve                  │   │
│ │                │  │                ( ) auto-reject                   │   │
│ │                │  │   Any-of at a level: [ ] (1 of N approves)       │   │
│ │                │  │   [ Test with a sample booking ]   [ Save rule ] │   │
│ └───────────────┘  └──────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────┘
```

Key UX decisions:

- **Chain steps are draggable cards** (reorder = change approval order).
  Each card: level number, approver (role *or* named user *or* "the
  requester's line manager" dynamic resolver), and an "any-of / all-of"
  toggle when multiple approvers sit at one level.
- **Conditions are chips**, each `field → operator → value`. Adding the
  first condition switches the rule from "Default (catch-all)" to scoped.
- **Rule precedence is explicit.** The list is ordered; a "Default" rule
  is pinned last and cannot be deleted (guarantees every booking resolves).
  Drag to reorder precedence; show "First matching rule wins" helper text.
- **Test harness.** "Test with a sample booking" opens a mini form
  (resource, requester role, duration); the builder highlights which rule
  matches and renders the resulting chain — removes guesswork before save.
- **Live preview sentence** above the canvas restates the rule in plain
  English so non-technical admins can verify intent.

Map to backend: each Save → `POST/PUT /api/v1/admin/approval-rules` with
`{conditions[], steps[](ordered), sla_hours, on_timeout, match_order}`.

## A.4 The Approver Inbox (approver)

A focused queue, not a generic table. Sorted by **SLA urgency** (closest
to breach first), colour-coded amber→crimson as the deadline approaches.

```
┌ Pending Approvals ─────────────────────────────────────────────────────────┐
│ Filter: [ My level ▾ ] [ Resource ▾ ] [ Overdue only ☐ ]                   │
│ ┌────────────────────────────────────────────────────────────────────────┐ │
│ │ ⏱ 2h left  Training Room 18F · Wong K. · Tue 14:00–17:00              │ │
│ │            Step 1 of 2 — you are L1 (Room Admin)                       │ │
│ │            [ Approve ]  [ Reject ]  [ Delegate ▾ ]  [ View detail ]    │ │
│ ├────────────────────────────────────────────────────────────────────────┤ │
│ │ 🔴 OVERDUE  HQ Boardroom · Chan · Wed 09:00–10:00                      │ │
│ │            Auto-escalates to Security Admin in 12 min                  │ │
│ │            [ Approve ]  [ Reject ]  [ Delegate ▾ ]                     │ │
│ └────────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

- **One-click decide.** Approve/Reject inline; Reject requires a reason
  (textarea appears in-row, blocks submit until filled — rejection reasons
  are mandatory for the audit trail).
- **Delegate** opens a person picker (`approval.delegate` permission);
  delegation is recorded as a chain event, not a silent reassignment.
- **Bulk actions** for low-risk levels: select multiple → Approve all
  (guarded by a confirm count). Never bulk-reject.
- **SLA chip** is the primary signal; the bell/header surfaces a count.

Map to backend: `POST /api/v1/approvals/{id}/approve|reject` with reason;
list from `GET /api/v1/approvals`.

## A.5 Status Tracking (requester + approver + admin)

The single most important component: a **horizontal chain timeline** shown
on the booking detail, the My Bookings row (compact), and the approver
detail. Same component, three densities.

```
 Submitted        L1 · Room Admin        L2 · Security Admin       Result
   ●───────────────●──────────────────────○─────────────────────────○
   ✓ Tue 13:02     ✓ Approved             ⏳ Awaiting               Confirmed
   Wong K.         Lee  · Tue 15:40       SLA 24h · 6h left         —
                   "Capacity OK"
```

State vocabulary & colour:

| State        | Dot      | Colour  | Sub-label                              |
|--------------|----------|---------|----------------------------------------|
| Done         | ✓ filled | emerald | actor + time + optional comment        |
| Current      | ⏳ pulse | amber   | "Awaiting <role>" + SLA countdown      |
| Upcoming     | ○ hollow | grey    | role name only                         |
| Rejected     | ✕ filled | crimson | actor + time + **reason** (always)     |
| Escalated    | ↑ filled | amber   | "Auto-escalated after SLA breach"      |
| Skipped      | ⊘ faint  | grey    | "Not required (rule changed)"          |

Behaviours:

- **Why am I stuck?** Hovering the current step shows the named approvers
  and "nudge" action (sends a reminder; rate-limited, logged).
- **Audit honesty.** Rejected/escalated never disappear; the timeline is
  append-only and matches the `audit_entries` record. Reasons are always
  shown, never truncated behind a tooltip on the detail view.
- **Realtime.** The timeline subscribes to the existing booking WebSocket
  channel; a decision elsewhere updates it without refresh.
- **Compact variant** (My Bookings list): the same stepper at 1-line
  height, dots only, with `3/4` text and the SLA chip.

Map to backend: `GET /api/v1/approvals/{id}/chain` returns the materialised
`approval_steps` with status/actor/decided_at/reason → render directly.

## A.6 Edge cases the UI must handle

- **Rule changed mid-flight.** Show already-decided steps as-is; mark
  newly-irrelevant steps "Skipped (rule changed)" rather than deleting.
- **No approver available** (role has zero users). Builder shows a
  validation error on save; runtime falls back to the policy's
  "on timeout" action and the timeline flags it amber.
- **Self-approval.** If requester ∈ approver set, the UI greys their own
  step and routes to the next eligible approver with a visible note.
- **Cancelled while pending.** Timeline collapses to "Withdrawn by
  requester" — terminal, greyed, audit-preserved.

---

# Part B — Room Splitting (Shared Internal Spaces)

## B.1 Problem & goals

A single physical space is often used at different granularities: a
training hall used whole for a large briefing, partitioned into Hall A /
Hall B for two parallel sessions, or laid out as 12 break-out pods. A
booking of the parent must block the children and vice versa. The system
already models this (`CompositeMode: parent|child`, `SharedCapacity`,
`IsShared()`, split endpoint) — the UX must make the relationship obvious
and prevent the same space being double-booked.

This is an internal departmental system: **there is no pricing, billing,
or commercial rate** — splitting is purely about capacity, equipment and
conflict-free allocation.

Goals:

- Admin can **split a room into sub-rooms** (and merge back) visually.
- Booking UI **always shows the truth**: booking a child greys the
  parent; booking the parent greys all children.
- Capacity and equipment per configuration are visible at decision time.

## B.2 Admin: the Split Designer

Entry: Resource editor → a room → **"Split / combine"** tab.

```
┌ Split Designer — "Training Hall" ─────────────────────────────────────────┐
│ Mode:  ( ) Whole only   (•) Splittable   ( ) Pods (shared capacity)        │
│                                                                            │
│  ┌──────────────────────── Training Hall (cap 300) ───────────────────────┐│
│  │  ┌───────────── Hall A ─────────────┐┌───────── Hall B ──────────────┐ ││
│  │  │ cap 180 · projector, stage       ││ cap 120 · whiteboard          │ ││
│  │  │ [ rename ] [ edit ] [ × remove ] ││ [ rename ] [ edit ] [ × ]     │ ││
│  │  └──────────────────────────────────┘└───────────────────────────────┘ ││
│  │                          [ + add divider / sub-room ]                  ││
│  └────────────────────────────────────────────────────────────────────────┘│
│                                                                            │
│  Combination rules (auto-generated, editable):                             │
│   • Booking "Training Hall"   → blocks Hall A + Hall B                     │
│   • Booking "Hall A"          → blocks Training Hall                       │
│   • Hall A + Hall B together  → suggest booking the whole Training Hall    │
│                                                                            │
│  [ Preview availability grid ]                  [ Cancel ]  [ Save split ] │
└────────────────────────────────────────────────────────────────────────────┘
```

Key UX decisions:

- **Direct-manipulation layout.** The parent is a container; "add
  sub-room" drops a child block inside it. Dragging a divider resizes the
  visual proportion (informational; capacity is the source of truth and is
  edited numerically — never trust pixels for an allocation).
- **Three modes, one control:**
  - *Whole only* — no children (normal exclusive resource).
  - *Splittable* — mutually-exclusive children + parent (the partitioned
    hall case; maps to `CompositeMode parent/child`, exclusive booking
    mode).
  - *Pods* — N identical units allocated by count (`IsShared()` +
    `SharedCapacity`); booking decrements remaining count.
- **Per-child attributes** inherit from parent then override: capacity,
  equipment, restricted flag, approver. Show inherited values greyed with
  an "override" affordance.
- **Auto-generated combination rules** are shown read-only by default with
  an "advanced" toggle to hand-edit exotic venues (e.g. Hall A blocks
  Ballroom but Hall B is independently soundproofed).
- **Guardrails:** cannot save if Σ child capacity is wildly > parent
  (warn, allow with confirm — overflow seating is real but should be
  deliberate). Cannot remove a child that has future bookings — show the
  count and a "reassign/cancel first" path.
- **Merge back** = set mode to *Whole only*; UI warns about existing child
  bookings and offers to migrate them onto the parent.

Map to backend: `POST /api/v1/admin/resources/{id}/split` with
`{children:[{name,capacity,equipment,...}], mode}`; children created
with `CompositeMode=child`, parent flagged `parent`.

## B.3 Booker-facing behaviour (the critical part)

The split must be **invisible until it matters, then unambiguous.**

Search / Calendar result for a splittable space:

```
 Training Hall             300 pax   ▸ can be split        [ Book whole ]
   └ Hall A                180 pax                          [ Book ]
   └ Hall B                120 pax   ✗ booked 14:00–17:00   (unavailable)
```

- **Parent row is expandable** to reveal children; a "▸ can be split"
  badge sets expectation.
- **Cross-locking is shown live.** Because Hall B is booked 14:00–17:00,
  the parent "Training Hall" and "Hall B" render crimson/disabled for
  any overlapping selection; Hall A stays emerald. The reason
  ("blocked by Hall B booking") appears on hover and in the disabled
  tooltip — never a silent grey.
- **On the Calendar grid**, a child booking paints a hatched band across
  the parent column (and siblings it blocks) so schedulers see the
  knock-on instantly; the band is labelled "via Hall B".
- **Whole-room nudge:** if a user selects both Hall A and Hall B for the
  same slot, the booking modal suggests "Book the whole Training Hall
  instead (1 reservation instead of 2)" — accepting swaps the two child
  holds for one parent booking atomically.

## B.4 Conflict & impact feedback at booking time

```
┌ Confirm — Hall A ─────────────────────────────────────────┐
│ Tue 2026-05-26 · 14:00–17:00 (3h)                         │
│ Capacity 180 · Projector, Stage                           │
│ ⚠ Booking Hall A also reserves "Training Hall" for this   │
│    time (the hall is used whole or in halves, not both).  │
│ Conflicts checked: ✓ no overlap                            │
│                              [ Cancel ]  [ Confirm hold ]  │
└────────────────────────────────────────────────────────────┘
```

- The **cross-impact line is mandatory** on any child/parent booking so
  the user consents to the knock-on lock. This single sentence prevents
  the #1 support dispute ("I only booked Hall A, why was the whole hall
  blocked?").
- Server remains the source of truth: `CountConcurrent` for pods,
  `HasConflict` across the parent+children set for splittable — the UI
  mirrors, never replaces, that check.

## B.5 States summary

| Situation                         | Parent      | Children                  |
|-----------------------------------|-------------|---------------------------|
| Nothing booked                    | available   | all available             |
| Child A booked                    | blocked     | A booked, B available     |
| Parent booked                     | booked      | all blocked (via parent)  |
| Pods mode, 8/12 taken             | "4 left"    | n/a (allocated by count)  |
| Child has future bookings, admin merges | warn + migrate flow | — |

---

# Part C — Implementation notes (mapping to this codebase)

- Approval builder → extend `AdminApprovalChain.vue`; persists via
  `api.listApprovalRules / createApprovalRule / updateApprovalRule`.
- Approval timeline → new `<ApprovalTimeline>` component fed by
  `api.approvalChain(bookingId)`; reuse on `MyBookings`, `Approvals`,
  booking detail.
- Split designer → extend `ResourceEditor.vue` with a "Split / combine"
  tab; persists via `api.splitResource(id, body)`.
- Booker cross-lock → `Search.vue` / `CalendarView.vue` already group by
  resource; add parent/child grouping from `CompositeMode` and extend the
  existing conflict colouring (the drag-conflict logic already turns
  selections crimson) to include the parent/child blocking set.
- Reuse existing semantic tokens: `--asl-ok` (approved/available),
  `--asl-bad` (rejected/blocked), `--asl-amber` (pending/awaiting).

## C.1 Recommended build order

1. `<ApprovalTimeline>` (highest visibility, lowest risk, read-only).
2. Approver Inbox actions (approve/reject/delegate with mandatory reason).
3. Rule Builder canvas (conditions chips + draggable steps + test harness).
4. Split Designer (admin) → then booker cross-lock visualisation.

Rationale: tracking/visibility delivers value before authoring complexity;
room-split read-out (cross-lock) must ship with or before the admin split
tool so a split room can never be double-booked.
