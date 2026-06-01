import { useEffect, useRef } from 'react';

// Idle-timeout hook for shared / unattended devices (kiosks). Fires `onIdle`
// after `timeoutMs` of no user interaction, and re-arms the countdown on any
// touch / pointer / key / scroll activity. Use it to discard half-finished
// input and return a walk-up tablet to its default screen so the next person
// never inherits the previous user's session (QA: kiosk "walk-away" leak).
//
// `onIdle` is held in a ref so passing a fresh inline callback each render
// doesn't tear down and re-arm the listeners — which would also reset the
// countdown on every render and make the timer never elapse.
const ACTIVITY_EVENTS: (keyof DocumentEventMap)[] = [
  'pointerdown', 'pointermove', 'mousedown', 'keydown', 'touchstart', 'wheel', 'scroll',
];

export function useIdleTimer(timeoutMs: number, onIdle: () => void, enabled = true) {
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!enabled || timeoutMs <= 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => onIdleRef.current(), timeoutMs);
    };
    arm(); // start counting from mount
    for (const ev of ACTIVITY_EVENTS) document.addEventListener(ev, arm, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const ev of ACTIVITY_EVENTS) document.removeEventListener(ev, arm);
    };
  }, [timeoutMs, enabled]);
}
