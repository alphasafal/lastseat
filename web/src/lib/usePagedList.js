import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from './api.js';

/**
 * A cursor-paginated list that can also be patched by live events.
 * `flash` holds the ids that changed recently so rows can highlight what just moved.
 */
export function usePagedList(path, idOf) {
  const [state, setState] = useState({
    items: [],
    nextCursor: null,
    totals: null,
    loading: true,
    error: null,
  });
  const [flash, setFlash] = useState({});
  const request = useRef(0);

  const reload = useCallback(async () => {
    const ticket = ++request.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await get(path);
      // Ignore the answer if the filter changed while the request was in flight.
      if (ticket !== request.current) return;
      setState({
        items: data.items,
        nextCursor: data.nextCursor,
        totals: data.totals,
        loading: false,
        error: null,
      });
    } catch (error) {
      if (ticket === request.current) setState((s) => ({ ...s, loading: false, error }));
    }
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (!state.nextCursor) return;
    const ticket = request.current;
    const separator = path.includes('?') ? '&' : '?';
    const data = await get(`${path}${separator}cursor=${encodeURIComponent(state.nextCursor)}`);
    if (ticket !== request.current) return;
    setState((s) => {
      const seen = new Set(s.items.map(idOf));
      return {
        ...s,
        items: [...s.items, ...data.items.filter((item) => !seen.has(idOf(item)))],
        nextCursor: data.nextCursor,
      };
    });
  }, [path, state.nextCursor, idOf]);

  const markChanged = useCallback((id) => {
    setFlash((f) => ({ ...f, [id]: Date.now() }));
    setTimeout(() => setFlash(({ [id]: _gone, ...rest }) => rest), 2400);
  }, []);

  /** Replace an item, or add it at the top when `addIfMissing` says it belongs in this list. */
  const upsert = useCallback(
    (item, { addIfMissing = false, isNewer = () => true } = {}) => {
      setState((s) => {
        const index = s.items.findIndex((existing) => idOf(existing) === idOf(item));
        if (index === -1) return addIfMissing ? { ...s, items: [item, ...s.items] } : s;
        if (!isNewer(s.items[index], item)) return s;
        const items = [...s.items];
        items[index] = item;
        return { ...s, items };
      });
      markChanged(idOf(item));
    },
    [idOf, markChanged],
  );

  const remove = useCallback(
    (id) => setState((s) => ({ ...s, items: s.items.filter((item) => idOf(item) !== id) })),
    [idOf],
  );

  return { ...state, flash, reload, loadMore, upsert, remove };
}
