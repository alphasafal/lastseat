import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import MySeat from '../components/MySeat.jsx';
import {
  Avatar,
  Dialog,
  EmptyState,
  Field,
  SeatStrip,
  SkillList,
  Tabs,
} from '../components/ui.jsx';
import { get, post } from '../lib/api.js';
import { SKILLS, explain, formatOffset, skillLabel, statusText, timeAgo } from '../lib/format.js';
import { useHackathon, useLiveEvents, useLiveReady } from '../lib/hackathon.jsx';
import { useToast } from '../lib/toast.jsx';
import { usePagedList } from '../lib/usePagedList.js';

const teamId = (team) => team.id;
const personId = (person) => person.userId;

export default function Board() {
  const { hackathon, hackathonId, totals, setTotals } = useHackathon();
  const [tab, setTab] = useState('teams');
  const [skill, setSkill] = useState('');

  useEffect(() => {
    document.title = `${hackathon.name} board | Lastseat`;
  }, [hackathon.name]);

  // The header counts are cheap to refresh but not worth refreshing on every single event.
  const refreshTotals = useThrottled(
    useCallback(() => {
      get(`/api/hackathons/${hackathonId}`).then((data) => setTotals(data.totals));
    }, [hackathonId, setTotals]),
    5000,
  );
  useLiveEvents(refreshTotals);

  const tabs = [
    { id: 'teams', label: 'Teams with open seats', short: 'Teams', count: totals?.openTeams },
    { id: 'people', label: 'People looking', short: 'People', count: totals?.peopleLooking },
    { id: 'suggested', label: 'Suggested for you', short: 'Suggested' },
  ];

  return (
    <div className="board-layout">
      <section className="board" aria-labelledby="board-title">
        <div className="board-head">
          <h1 id="board-title">{hackathon.name}</h1>
          <p className="board-rules">
            Teams of {hackathon.minTeamSize} to {hackathon.maxTeamSize}. One team per person.
          </p>
        </div>

        <div className="board-controls">
          <Tabs label="Board" tabs={tabs} active={tab} onChange={setTab} />
          {tab !== 'suggested' && (
            <label className="filter">
              <span>{tab === 'teams' ? 'Looking for' : 'Skill'}</span>
              <select value={skill} onChange={(event) => setSkill(event.target.value)}>
                <option value="">Any skill</option>
                {SKILLS.map((s) => (
                  <option key={s} value={s}>
                    {skillLabel(s)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'teams' && <TeamsPanel skill={skill} />}
          {tab === 'people' && <PeoplePanel skill={skill} />}
          {tab === 'suggested' && <SuggestedPanel />}
        </div>
      </section>
      <MySeat />
    </div>
  );
}

function useThrottled(fn, ms) {
  const [state] = useState({ last: 0, timer: null });
  return useCallback(() => {
    const wait = state.last + ms - Date.now();
    if (wait <= 0) {
      state.last = Date.now();
      fn();
    } else if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        state.last = Date.now();
        fn();
      }, wait);
    }
  }, [fn, ms, state]);
}

/** Rows in the shape of the real ones, so the page does not jump when the data arrives. */
function Placeholders({ noun }) {
  return (
    <div className="rows" role="status" aria-label={`Loading ${noun}`}>
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="skeleton-row" aria-hidden="true">
          <span className="skeleton skeleton-seats" />
          <span className="skeleton-lines">
            <span className="skeleton" style={{ width: `${55 - (index % 3) * 10}%` }} />
            <span className="skeleton" style={{ width: `${85 - (index % 2) * 15}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function ListFooter({ list, noun }) {
  if (list.error) {
    return (
      <p className="form-error" role="alert">
        The {noun} could not be loaded.{' '}
        <button type="button" className="link-button" onClick={list.reload}>
          Try again
        </button>
      </p>
    );
  }
  if (list.loading && list.items.length === 0) return <Placeholders noun={noun} />;
  if (!list.nextCursor) return null;
  return (
    <button type="button" className="button button-quiet button-wide" onClick={list.loadMore}>
      Show more {noun}
    </button>
  );
}

// --- Teams --------------------------------------------------------------------------------

function TeamsPanel({ skill }) {
  const { hackathonId } = useHackathon();
  const path = `/api/hackathons/${hackathonId}/board/teams${skill ? `?skill=${skill}` : ''}`;
  const list = usePagedList(path, teamId);
  const [asking, setAsking] = useState(null);

  useLiveReady(list.reload);
  useLiveEvents((event) => {
    if (event.type === 'team.deleted') list.remove(event.teamId);
    if (!event.team) return;
    // A team that just filled stays visible (marked full) so rows do not vanish under the
    // cursor; it is simply not added if it was not on screen already.
    const belongs = event.team.openSeats > 0 && (!skill || event.team.lookingFor.includes(skill));
    list.upsert(event.team, {
      addIfMissing: belongs,
      isNewer: (old, next) => next.version > old.version,
    });
  });

  return (
    <>
      {!list.loading && list.items.length === 0 && !list.error && (
        <EmptyState title="No teams with open seats match this filter.">
          Clear the filter, or create a team and let people come to you.
        </EmptyState>
      )}
      <ul className="rows">
        {list.items.map((team) => (
          <TeamRow
            key={team.id}
            team={team}
            changed={Boolean(list.flash[team.id])}
            onAsk={() => setAsking(team)}
          />
        ))}
      </ul>
      <ListFooter list={list} noun="teams" />
      <AskToJoinDialog team={asking} onClose={() => setAsking(null)} />
    </>
  );
}

function TeamRow({ team, changed, onAsk }) {
  const { hackathonId, me, myTeam, myRequests, setMyRequests } = useHackathon();
  const toast = useToast();
  const pending = myRequests.find(
    (request) => request.teamId === team.id && request.status === 'pending',
  );
  const mine = myTeam?.id === team.id;

  async function withdraw() {
    // Optimistic: the button flips back at once; restored if the server refuses.
    const before = myRequests;
    setMyRequests(before.map((r) => (r.id === pending.id ? { ...r, status: 'cancelled' } : r)));
    try {
      await post(`/api/requests/${pending.id}/cancel`);
    } catch (err) {
      setMyRequests(before);
      toast.error(explain(err));
    }
  }

  let action = null;
  if (mine) action = <span className="row-note">Your team</span>;
  else if (pending) {
    action = (
      <>
        <span className="row-note">Request sent</span>
        <button type="button" className="button button-quiet" onClick={withdraw}>
          Withdraw<span className="sr-only"> request to {team.name}</span>
        </button>
      </>
    );
  } else if (team.status === 'full') action = <span className="row-note">Full</span>;
  else if (me?.teamId) action = null;
  else if (!team.acceptingRequests) action = <span className="row-note">Invite only</span>;
  else {
    action = (
      <button type="button" className="button button-primary" onClick={onAsk}>
        Ask to join<span className="sr-only"> {team.name}</span>
      </button>
    );
  }

  return (
    <li
      className={`row team-row${changed ? ' row-changed' : ''}${team.status === 'full' ? ' row-full' : ''}`}
    >
      <SeatStrip team={team} />
      <div className="row-main">
        <h2 className="row-title">
          <Link to={`/h/${hackathonId}/teams/${team.id}`}>{team.name}</Link>
        </h2>
        <p className={`status status-${team.status}`}>{statusText(team)}</p>
        {team.description && <p className="row-text">{team.description}</p>}
        {team.lookingFor.length > 0 && (
          <div className="row-wants">
            <span className="row-label">Looking for</span>
            <SkillList skills={team.lookingFor} highlight={me?.skills ?? []} />
          </div>
        )}
      </div>
      <div className="row-action">{action}</div>
    </li>
  );
}

function AskToJoinDialog({ team, onClose }) {
  const { myRequests, setMyRequests } = useHackathon();
  const toast = useToast();
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (team) setMessage('');
  }, [team]);

  async function submit(event) {
    event.preventDefault();
    const target = team;
    onClose();
    // Optimistic: show "Request sent" immediately with a placeholder, then swap in the real one.
    const placeholder = {
      id: `temp-${target.id}`,
      teamId: target.id,
      teamName: target.name,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    const before = myRequests;
    setMyRequests([placeholder, ...before]);
    try {
      const { request } = await post(`/api/teams/${target.id}/requests`, { message });
      setMyRequests((current) => current.map((r) => (r.id === placeholder.id ? request : r)));
      toast.info(`Request sent to ${target.name}. The leader will see it now.`);
    } catch (err) {
      setMyRequests((current) => current.filter((r) => r.id !== placeholder.id));
      toast.error(explain(err));
    }
  }

  return (
    <Dialog open={Boolean(team)} onClose={onClose} title={team ? `Ask to join ${team.name}` : ''}>
      <form onSubmit={submit}>
        <Field label="Message to the leader" hint="Optional. Say what you would bring to the team.">
          {(props) => (
            <textarea
              {...props}
              rows={3}
              maxLength={280}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          )}
        </Field>
        <div className="dialog-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            Send request
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// --- People -------------------------------------------------------------------------------

function PeoplePanel({ skill }) {
  const { hackathonId, myTeam } = useHackathon();
  const path = `/api/hackathons/${hackathonId}/board/people${skill ? `?skill=${skill}` : ''}`;
  const list = usePagedList(path, personId);
  const wanted = myTeam?.lookingFor ?? [];

  useLiveReady(list.reload);
  useLiveEvents((event) => {
    for (const person of event.people ?? []) {
      if (!person.lookingForTeam) list.remove(person.userId);
      else list.upsert(person, { addIfMissing: !skill || person.skills.includes(skill) });
    }
  });

  return (
    <>
      {!list.loading && list.items.length === 0 && !list.error && (
        <EmptyState title="Nobody with that skill is looking right now.">
          Try another skill.
        </EmptyState>
      )}
      <ul className="rows">
        {list.items.map((person) => (
          <PersonRow
            key={person.userId}
            person={person}
            highlight={wanted}
            changed={Boolean(list.flash[person.userId])}
          />
        ))}
      </ul>
      <ListFooter list={list} noun="people" />
    </>
  );
}

function PersonRow({ person, highlight, changed, children }) {
  return (
    <li className={`row person-row${changed ? ' row-changed' : ''}`}>
      <Avatar name={person.name} />
      <div className="row-main">
        <h2 className="row-title">{person.name}</h2>
        <p className="row-meta">
          {formatOffset(person.utcOffsetMinutes)}, active {timeAgo(person.updatedAt)}
        </p>
        {person.headline && <p className="row-text">{person.headline}</p>}
        <SkillList
          skills={person.skills}
          highlight={highlight}
          empty={<p className="row-meta">No skills listed</p>}
        />
        {children}
      </div>
    </li>
  );
}

// --- Suggestions --------------------------------------------------------------------------

function SuggestedPanel() {
  const { hackathonId, myTeam, me } = useHackathon();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    get(`/api/hackathons/${hackathonId}/suggestions`).then(setData, setError);
  }, [hackathonId]);

  // Recompute when the thing the ranking is based on changes: my team, or my own skills.
  const basis = useMemo(
    () => `${myTeam?.id ?? ''}:${myTeam?.version ?? ''}:${me?.skills?.join(',') ?? ''}`,
    [myTeam, me],
  );
  useEffect(load, [load, basis]);

  if (error) {
    return (
      <p className="form-error" role="alert">
        {explain(error)}
      </p>
    );
  }
  if (!data) return <p className="page-status">Finding people…</p>;

  return (
    <>
      <div className="suggest-intro">
        <p>
          {data.basedOn.kind === 'team'
            ? `Ranked for ${data.basedOn.name}: people who bring what the team lacks and share its working hours.`
            : 'Ranked for you: people whose skills complement yours and who are awake when you are.'}
        </p>
        <details>
          <summary>How the score is calculated</summary>
          <ul>
            {data.scoring.explanation.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p>
            Weights: wanted {data.scoring.weights.wanted}, complementary{' '}
            {data.scoring.weights.complementary}, time zone {data.scoring.weights.timezone}.{' '}
            {data.considered} people were scored.
          </p>
        </details>
      </div>
      {data.suggestions.length === 0 && (
        <EmptyState title="Nobody is looking for a team right now." />
      )}
      <ul className="rows">
        {data.suggestions.map(({ person, score, breakdown, reasons }) => (
          <PersonRow key={person.userId} person={person} highlight={breakdown.wanted.skills}>
            <div className="score">
              <div className="score-head">
                <span className="score-value">{Math.round(score)}</span>
                <span className="score-of">match out of 100</span>
              </div>
              <div className="score-bars" aria-hidden="true">
                {['wanted', 'complementary', 'timezone'].map((part) => (
                  <span
                    key={part}
                    className={`score-bar score-${part}`}
                    style={{ flexGrow: breakdown[part].weight * breakdown[part].score * 100 }}
                  />
                ))}
                <span className="score-bar score-rest" style={{ flexGrow: 100 - score }} />
              </div>
              <ul className="score-reasons">
                {reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          </PersonRow>
        ))}
      </ul>
    </>
  );
}
