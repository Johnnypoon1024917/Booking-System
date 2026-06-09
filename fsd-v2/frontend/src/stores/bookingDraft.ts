import { create } from 'zustand';

// Booking-draft store — lifts the *content* of an in-progress new booking out
// of the ephemeral <BookingModal /> so it survives the modal unmounting.
//
// The problem it fixes (QA enterprise #4): a secretary spends 10 minutes filling
// out custom catering/visitor fields and add-ons, hits Save, and the API returns
// 409 Conflict because someone grabbed the room two seconds earlier. They close
// the dialog to pick a different room — the modal unmounts and every field they
// typed is destroyed. With this store the laborious content (title, add-ons,
// custom-field answers, cost center, recurrence, privacy) is retained, so when
// they reopen the modal on another room it is instantly pre-filled.
//
// Only the content travels — NOT the room or the date/time, which the caller is
// authoritative for on each fresh open (you're booking a specific newly-picked
// room/slot). Custom-field answers are kept keyed by field key; the modal reads
// whichever keys the chosen room defines and only submits those.
//
// The draft lives for the SPA session (in-memory, like the toast store) and is
// cleared once a booking actually succeeds. Edit mode never touches it.
export interface BookingDraft {
  title: string;
  meetingUrl: string;
  isPrivate: boolean;
  recur: boolean;
  pattern: 'daily' | 'weekly' | 'bi-weekly' | 'monthly';
  // Outlook-style recurrence conditionals: repeat interval and (weekly) the
  // selected weekdays (0=Sun..6=Sat), so they survive a conflict-and-retry too.
  interval: number;
  byday: number[];
  count: number;
  until: string;
  services: string[];
  costCenter: string;
  cfValues: Record<string, unknown>;
}

interface BookingDraftState {
  draft: BookingDraft | null;
  // Merge a partial snapshot into the draft (creating it if absent). The modal
  // calls this whenever its content fields change.
  save: (patch: Partial<BookingDraft>) => void;
  // Drop the draft — called after a booking is successfully created.
  clear: () => void;
}

const EMPTY: BookingDraft = {
  title: '', meetingUrl: '', isPrivate: false,
  recur: false, pattern: 'weekly', interval: 1, byday: [], count: 4, until: '',
  services: [], costCenter: '', cfValues: {},
};

export const useBookingDraft = create<BookingDraftState>((set) => ({
  draft: null,
  save: (patch) => set((s) => ({ draft: { ...(s.draft ?? EMPTY), ...patch } })),
  clear: () => set({ draft: null }),
}));
