import { useEffect, useRef, useState } from 'react';

// A tab nobody is looking at keeps its stream this long, so a quick switch to another tab and
// back does not reconnect.
const HIDDEN_GRACE_MS = 20_000;
// What counts as "someone is using this page".
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];

/**
 * Subscribes to the server-sent event stream for a hackathon (and optionally one team).
 *
 * `onReady` fires on every (re)connect, after the server has subscribed us. That is the
 * moment to fetch data: anything committed later arrives as an event, so nothing can fall
 * into the gap between the fetch and the stream.
 *
 * An open stream costs the server a connection for as long as it lasts, so it is only held
 * while it is useful. A hidden tab closes it after a short grace period. The server can also
 * ask, in the `ready` event, for it to be closed after a time without any input. Either way
 * the status becomes "paused", and the next look at the page or touch of the mouse opens a new
 * stream; `onReady` then refetches, so the page catches up on everything it missed.
 *
 * EventSource reconnects by itself after a network drop; for that we only track the status.
 */
export function useLiveStream({ hackathonId, teamId, onEvent, onReady }) {
  const [status, setStatus] = useState('connecting');
  const handlers = useRef({ onEvent, onReady });

  useEffect(() => {
    handlers.current = { onEvent, onReady };
  });

  useEffect(() => {
    if (!hackathonId) return undefined;
    const query = new URLSearchParams({ hackathonId, ...(teamId ? { teamId } : {}) });

    let source = null;
    let downTimer = null; // turns the indicator to "reconnecting" only if the stream stays down
    let hideTimer = null; // pauses a hidden tab
    let idleTimer = null; // pauses an unused page, when the server asks for that
    let idleAfterMs = 0; // from the server's `ready` event; 0 = never
    let lastActivity = Date.now();

    function open() {
      if (source) return;
      setStatus('connecting');
      source = new EventSource(`/api/stream?${query}`);

      source.addEventListener('ready', (message) => {
        clearTimeout(downTimer);
        downTimer = null;
        idleAfterMs = JSON.parse(message.data).idleAfterMs ?? 0;
        checkIdle();
        // checkIdle may just have paused the stream: a reconnect is not a sign of life.
        if (!source) return;
        setStatus('live');
        handlers.current.onReady?.();
      });
      source.addEventListener('change', (message) => {
        handlers.current.onEvent?.(JSON.parse(message.data));
      });
      // The server asks for a full refetch when it could not replay missed events.
      source.addEventListener('resync', () => handlers.current.onReady?.());
      // A stream that drops usually reconnects within a couple of seconds, so the indicator
      // only changes if it stays down.
      source.onerror = () => {
        downTimer ??= setTimeout(() => setStatus('reconnecting'), 4000);
      };
    }

    function pause() {
      clearTimeout(downTimer);
      clearTimeout(idleTimer);
      downTimer = null;
      source?.close();
      source = null;
      setStatus('paused');
    }

    /** Pauses if there was no input for `idleAfterMs`; otherwise looks again when that is due. */
    function checkIdle() {
      clearTimeout(idleTimer);
      if (!source || idleAfterMs <= 0) return;
      const remaining = lastActivity + idleAfterMs - Date.now();
      if (remaining <= 0) pause();
      else idleTimer = setTimeout(checkIdle, remaining);
    }

    function onActivity() {
      lastActivity = Date.now();
      if (!document.hidden) open();
    }

    function onVisibilityChange() {
      clearTimeout(hideTimer);
      if (document.hidden) hideTimer = setTimeout(pause, HIDDEN_GRACE_MS);
      else onActivity();
    }

    open();
    if (document.hidden) onVisibilityChange();
    document.addEventListener('visibilitychange', onVisibilityChange);
    for (const type of ACTIVITY_EVENTS)
      window.addEventListener(type, onActivity, { passive: true });

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity);
      clearTimeout(downTimer);
      clearTimeout(hideTimer);
      clearTimeout(idleTimer);
      source?.close();
    };
  }, [hackathonId, teamId]);

  return status;
}
