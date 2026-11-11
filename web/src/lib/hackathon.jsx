import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { get, post } from './api.js';
import { useLiveStream } from './live.js';
import { useSession } from './session.jsx';

const HackathonContext = createContext(null);

/**
 * Owns everything that is true for the signed-in person in one hackathon - their participant
 * record, their team, their join requests - and the single live connection for the page.
 * Pages below it register listeners instead of opening connections of their own.
 */
export function HackathonProvider({ hackathonId, teamId, children }) {
  const { user } = useSession();
  const [hackathon, setHackathon] = useState(null);
  const [totals, setTotals] = useState(null);
  const [me, setMe] = useState(null);
  const [myTeam, setMyTeam] = useState(null);
  const [myRequests, setMyRequests] = useState([]);
  const [error, setError] = useState(null);

  const listeners = useRef(new Set());
  const readyListeners = useRef(new Set());

  // Resolves once this person is registered in the hackathon. Everything that reads "me"
  // waits for it, so a refresh triggered by the live connection can never run ahead of the
  // registration and wipe the profile with an empty answer.
  const registration = useRef(null);

  const refreshMine = useCallback(async () => {
    await registration.current;
    const [mine, requests] = await Promise.all([
      get(`/api/hackathons/${hackathonId}/me`),
      get(`/api/hackathons/${hackathonId}/requests/mine`),
    ]);
    setMe(mine.me);
    setMyTeam(mine.team);
    setMyRequests(requests.requests);
    return mine;
  }, [hackathonId]);

  useEffect(() => {
    let cancelled = false;
    // Opening a hackathon registers you in it; the call is idempotent.
    registration.current = post(`/api/hackathons/${hackathonId}/participants`, {}).catch(() => {});
    (async () => {
      try {
        const data = await get(`/api/hackathons/${hackathonId}`);
        if (cancelled) return;
        setHackathon(data.hackathon);
        setTotals(data.totals);
        if (!cancelled) await refreshMine();
      } catch (err) {
        if (!cancelled) setError(err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hackathonId, refreshMine]);

  const onEvent = useCallback(
    (event) => {
      // Keep "me" and "my team" current from the snapshots carried by each event.
      if (event.team) {
        const amMember = event.team.members.some((member) => member.userId === user.id);
        setMyTeam((current) => {
          if (amMember)
            return !current || event.team.version >= current.version ? event.team : current;
          return current?.id === event.team.id ? null : current;
        });
      }
      if (event.type === 'team.deleted') {
        setMyTeam((current) => (current?.id === event.teamId ? null : current));
      }
      const mine = event.people?.find((person) => person.userId === user.id);
      if (mine) setMe(mine);
      if (
        event.type.startsWith('request.') &&
        (event.actor?.userId === user.id || event.subject?.userId === user.id)
      ) {
        get(`/api/hackathons/${hackathonId}/requests/mine`).then((data) =>
          setMyRequests(data.requests),
        );
      }
      for (const listener of listeners.current) listener(event);
    },
    [hackathonId, user.id],
  );

  const onReady = useCallback(() => {
    refreshMine().catch(() => {});
    for (const listener of readyListeners.current) listener();
  }, [refreshMine]);

  const status = useLiveStream({ hackathonId, teamId, onEvent, onReady });

  const value = useMemo(
    () => ({
      hackathonId,
      hackathon,
      totals,
      setTotals,
      me,
      setMe,
      myTeam,
      setMyTeam,
      myRequests,
      setMyRequests,
      refreshMine,
      status,
      error,
      /** Subscribe to live events; returns an unsubscribe function. */
      onEvent(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      /** Called on every (re)connect: refetch whatever the page shows. */
      onReady(listener) {
        readyListeners.current.add(listener);
        return () => readyListeners.current.delete(listener);
      },
    }),
    [hackathonId, hackathon, totals, me, myTeam, myRequests, refreshMine, status, error],
  );

  return <HackathonContext.Provider value={value}>{children}</HackathonContext.Provider>;
}

export const useHackathon = () => useContext(HackathonContext);

/** Runs `listener` for every live event while the component is mounted. */
export function useLiveEvents(listener) {
  const { onEvent } = useHackathon();
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  });
  useEffect(() => onEvent((event) => ref.current(event)), [onEvent]);
}

/** Runs `listener` every time the live connection (re)connects. */
export function useLiveReady(listener) {
  const { onReady } = useHackathon();
  const ref = useRef(listener);
  useEffect(() => {
    ref.current = listener;
  });
  useEffect(() => onReady(() => ref.current()), [onReady]);
}
