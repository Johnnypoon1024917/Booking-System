import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Megaphone, X } from 'lucide-react';
import { api } from '../api/client';
import { useRealtimeStore } from '../stores/realtime';

// R13 broadcast banner — single news-ticker bar shared by ALL active
// broadcasts, scrolling right-to-left. We render two identical streams
// in a flex track and animate translateX 0 → -50%, so the first copy
// sweeps off the left as the second slides in seamlessly.
//
// This matches the v1 behaviour saved in MEMORY.md: one bar, every
// broadcast queued one after another, dismiss removes whichever is
// currently the head of the queue.

interface Broadcast {
  id: string;
  title: string;
  content: string;
  severity?: string;
  color?: string;
  startsAt: string;
  endsAt: string;
  filters?: Record<string, any>;
}

const SEV_RANK: Record<string, number> = { urgent: 3, warning: 2, info: 1 };

function bannerColor(b: Broadcast): string {
  const c = b.color || b.filters?.color;
  if (c) return c;
  if (b.severity === 'urgent') return '#dc2626';
  if (b.severity === 'warning') return '#d97706';
  return '#1e2a44';
}

export function BroadcastBanner() {
  const [items, setItems] = useState<Broadcast[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const marqueeRef = useRef<HTMLDivElement | null>(null);
  const [marqueeWidth, setMarqueeWidth] = useState(1024);

  const load = useCallback(async () => {
    try {
      const data = await api.activeBroadcasts();
      setItems(Array.isArray(data) ? data : []);
    } catch { /* non-fatal */ }
  }, []);

  // Poll every 60s as a safety net (covers a dropped SSE connection or a
  // broadcast that expires while the tab is backgrounded). The realtime
  // trigger below is what makes emergency broadcasts appear on the dot.
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  // Realtime push: the backend emits `broadcast.published` the instant a
  // broadcast goes live (or expires/is deleted). The global useRealtime in
  // Layout feeds every SSE event into this store, so we re-fetch the moment
  // one arrives — no extra EventSource, no waiting out the 60s poll cycle.
  const lastEvent = useRealtimeStore((s) => s.lastEvent);
  useEffect(() => {
    if (lastEvent?.type === 'broadcast.published') load();
  }, [lastEvent, load]);

  // Refetch the moment the SSE stream re-establishes after a drop, so a
  // broadcast published while we were offline shows up immediately rather than
  // waiting out the 60s poll.
  const reconnectNonce = useRealtimeStore((s) => s.reconnectNonce);
  useEffect(() => {
    if (reconnectNonce > 0) load();
  }, [reconnectNonce, load]);

  const live = useMemo(
    () => items.filter((b) => !dismissed.has(b.id)),
    [items, dismissed],
  );

  // Highest-severity active broadcast wins the bar colour — red trumps
  // amber trumps slate even when an info broadcast is also live.
  const headColor = useMemo(() => {
    let best: Broadcast | null = null;
    let rank = 0;
    for (const b of live) {
      const r = SEV_RANK[b.severity || 'info'] || 0;
      if (r > rank) { rank = r; best = b; }
    }
    return bannerColor(best || live[0] || ({ severity: 'info' } as Broadcast));
  }, [live]);

  // Scale the loop duration with the total content length: two short
  // alerts shouldn't tear past too fast, but a long compliance notice
  // should still finish in reasonable time. Clamped 20s–120s.
  const tickerDuration = useMemo(() => {
    const total = live.reduce(
      (n, b) => n + (b.title?.length || 0) + (b.content?.length || 0) + 6, 0);
    return Math.min(120, Math.max(20, Math.round(total / 4)));
  }, [live]);

  // Track the marquee container width so each stream is at least one
  // viewport wide. Without this, short messages leave the right half
  // of the bar empty mid-scroll.
  useEffect(() => {
    const el = marqueeRef.current;
    if (!el) return;
    const sync = () => setMarqueeWidth(el.clientWidth || 1024);
    sync();
    const obs = new ResizeObserver(sync);
    obs.observe(el);
    return () => obs.disconnect();
  }, [live.length]);

  if (live.length === 0) return null;

  const dismiss = () => {
    const head = live[0];
    if (!head) return;
    setDismissed((prev) => new Set([...prev, head.id]));
  };

  // Two identical streams for the seamless loop.
  const renderStream = (key: string) => (
    <span className="bc-stream" key={key} style={{ minWidth: marqueeWidth }}>
      {live.map((b, i) => (
        <span key={`${key}-${b.id}`}>
          {i > 0 && <span className="bc-sep">●</span>}
          <b>{b.title}</b>
          <span> — {b.content}</span>
        </span>
      ))}
    </span>
  );

  return (
    <div className="bc-banner" role="alert" style={{ background: headColor }}>
      <Megaphone size={16} className="bc-ico" />
      <div className="bc-marquee" ref={marqueeRef}>
        <div className="bc-track" style={{ animationDuration: `${tickerDuration}s` }}>
          {renderStream('a')}
          {renderStream('b')}
        </div>
      </div>
      <button className="bc-x" onClick={dismiss} aria-label="dismiss">
        <X size={14} />
      </button>
    </div>
  );
}
