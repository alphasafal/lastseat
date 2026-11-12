import { useEffect, useRef, useState } from 'react';

/**
 * Subscribes to the server-sent event stream for a hackathon (and optionally one team).
 *
 * `onReady` fires on every (re)connect, after the server has subscribed us. That is the
 * moment to fetch data: anything committed later arrives as an event, so nothing can fall
 * into the gap between the fetch and the stream.
 *
 * EventSource reconnects by itself; we only track the status for the indicator in the header.
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
    const source = new EventSource(`/api/stream?${query}`);

    // A stream that drops usually reconnects within a couple of seconds, so the indicator
    // only changes if it stays down.
    let downTimer = null;

    source.addEventListener('ready', () => {
      clearTimeout(downTimer);
      downTimer = null;
      setStatus('live');
      handlers.current.onReady?.();
    });
    source.addEventListener('change', (message) => {
      handlers.current.onEvent?.(JSON.parse(message.data));
    });
    // The server asks for a full refetch when it could not replay missed events.
    source.addEventListener('resync', () => handlers.current.onReady?.());
    source.onerror = () => {
      downTimer ??= setTimeout(() => setStatus('reconnecting'), 4000);
    };

    return () => {
      clearTimeout(downTimer);
      source.close();
    };
  }, [hackathonId, teamId]);

  return status;
}
