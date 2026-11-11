import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Avatar,
  Dialog,
  EmptyState,
  Field,
  SeatStrip,
  SkillList,
  SkillPicker,
} from '../components/ui.jsx';
import { del, get, patch, post, put } from '../lib/api.js';
import {
  describeEvent,
  explain,
  formatOffset,
  prettyCode,
  statusText,
  timeAgo,
  timeUntil,
} from '../lib/format.js';
import { useHackathon, useLiveEvents, useLiveReady } from '../lib/hackathon.jsx';
import { useSession } from '../lib/session.jsx';
import { useToast } from '../lib/toast.jsx';

export default function Team() {
  const { teamId } = useParams();
  const { user } = useSession();
  const { hackathonId, me, myRequests, setMyRequests, setMyTeam, refreshMine } = useHackathon();
  const toast = useToast();
  const navigate = useNavigate();

  const [team, setTeam] = useState(null);
  const [gone, setGone] = useState(false);
  const [history, setHistory] = useState([]);
  const [requests, setRequests] = useState([]);
  const [invites, setInvites] = useState([]);
  const [pendingSeat, setPendingSeat] = useState(null); // user id shown optimistically in a seat
  const [dialog, setDialog] = useState(null); // 'edit' | 'leave' | { remove: member }

  const isMember = Boolean(team?.members.some((member) => member.userId === user.id));
  const isLeader = team?.leaderId === user.id;

  const loadTeam = useCallback(async () => {
    try {
      const data = await get(`/api/teams/${teamId}`);
      setTeam((current) =>
        !current || data.team.version >= current.version ? data.team : current,
      );
      setGone(false);
      return data.team;
    } catch (err) {
      if (err.status === 404) setGone(true);
      else toast.error(explain(err));
      return null;
    }
  }, [teamId, toast]);

  const loadPrivate = useCallback(
    async (current) => {
      if (!current?.members.some((member) => member.userId === user.id)) return;
      get(`/api/teams/${teamId}/audit`).then(
        (data) => setHistory(data.entries),
        () => {},
      );
      if (current.leaderId !== user.id) return;
      get(`/api/teams/${teamId}/requests`).then(
        (data) => setRequests(data.requests),
        () => {},
      );
      get(`/api/teams/${teamId}/invites`).then(
        (data) => setInvites(data.invites),
        () => {},
      );
    },
    [teamId, user.id],
  );

  const loadAll = useCallback(async () => loadPrivate(await loadTeam()), [loadTeam, loadPrivate]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);
  useLiveReady(loadAll);

  useEffect(() => {
    if (team) document.title = `${team.name} | Lastseat`;
  }, [team]);

  useLiveEvents((event) => {
    if (event.teamId !== teamId) return;
    if (event.type === 'team.deleted') {
      setGone(true);
      return;
    }
    if (event.team) {
      setTeam((current) =>
        !current || event.team.version > current.version ? event.team : current,
      );
      setPendingSeat(null);
      // Becoming leader (or member) unlocks lists we have not loaded yet.
      if (event.type === 'leader.changed' || event.type === 'member.joined')
        loadPrivate(event.team);
    }
    // Private lists are refetched when an event says they changed; the event is the signal,
    // the REST call is the source of truth.
    const leaderNow = (event.team ?? team)?.leaderId === user.id;
    if (leaderNow && event.type.startsWith('request.')) {
      get(`/api/teams/${teamId}/requests`).then(
        (data) => setRequests(data.requests),
        () => {},
      );
    }
    if (leaderNow && event.type.startsWith('invite.')) {
      get(`/api/teams/${teamId}/invites`).then(
        (data) => setInvites(data.invites),
        () => {},
      );
    }
    if (isMember && event.type !== 'participant.updated') {
      setHistory((entries) =>
        entries.some((e) => e.id === event.id) ? entries : [event, ...entries],
      );
    }
    if (event.type === 'member.removed' && event.subject?.userId === user.id) {
      toast.info(`You were removed from ${team?.name ?? 'the team'}.`);
    }
  });

  if (gone) {
    return (
      <div className="narrow">
        <h1>This team no longer exists</h1>
        <p>Its last member left, so the team was closed.</p>
        <Link className="button button-primary" to={`/h/${hackathonId}`}>
          Back to the board
        </Link>
      </div>
    );
  }
  if (!team) return <p className="page-status">Loading team…</p>;

  const myRequest = myRequests.find(
    (request) => request.teamId === teamId && request.status === 'pending',
  );

  /** Runs a leader/member action that returns the updated team. */
  async function act(run, success) {
    try {
      const data = await run();
      if (data?.team)
        setTeam((current) => (data.team.version >= current.version ? data.team : current));
      if (success) toast.info(success);
      return data;
    } catch (err) {
      toast.error(explain(err));
      loadTeam();
      return null;
    }
  }

  async function accept(request) {
    // Optimistic: the person takes the seat on screen immediately. If someone else took the
    // last seat in the meantime the server answers TEAM_FULL and the seat is given back.
    const before = { team, requests };
    setPendingSeat(request.user.userId);
    setRequests(requests.filter((r) => r.id !== request.id));
    setTeam({
      ...team,
      members: [...team.members, { ...request.user, joinedAt: new Date().toISOString() }],
      memberCount: team.memberCount + 1,
      openSeats: team.openSeats - 1,
    });
    try {
      const data = await post(`/api/requests/${request.id}/accept`);
      setTeam((current) => (data.team.version >= current.version ? data.team : current));
      setPendingSeat(null);
      toast.info(`${request.user.name} is now on the team.`);
    } catch (err) {
      setTeam(before.team);
      setRequests(before.requests);
      setPendingSeat(null);
      toast.error(explain(err));
      loadAll();
    }
  }

  async function decline(request) {
    const before = requests;
    setRequests(requests.filter((r) => r.id !== request.id));
    try {
      await post(`/api/requests/${request.id}/decline`);
    } catch (err) {
      setRequests(before);
      toast.error(explain(err));
    }
  }

  async function leave() {
    setDialog(null);
    const data = await act(() => post(`/api/teams/${teamId}/leave`), 'You left the team.');
    if (!data) return;
    setMyTeam(null);
    await refreshMine();
    navigate(`/h/${hackathonId}`);
  }

  async function askToJoin() {
    try {
      const { request } = await post(`/api/teams/${teamId}/requests`, { message: '' });
      setMyRequests((current) => [request, ...current]);
      toast.info('Request sent. The leader will see it now.');
    } catch (err) {
      toast.error(explain(err));
    }
  }

  return (
    <div className="team-page">
      <p className="back">
        <Link to={`/h/${hackathonId}`}>Back to the board</Link>
      </p>
      <header className="team-head">
        <div>
          <h1>{team.name}</h1>
          <p className={`status status-${team.status}`}>{statusText(team)}</p>
          {team.description && <p className="team-description">{team.description}</p>}
          {team.lookingFor.length > 0 && (
            <div className="row-wants">
              <span className="row-label">Looking for</span>
              <SkillList skills={team.lookingFor} highlight={isMember ? [] : (me?.skills ?? [])} />
            </div>
          )}
        </div>
        <div className="team-head-actions">
          {isLeader && (
            <button type="button" className="button button-quiet" onClick={() => setDialog('edit')}>
              Edit team
            </button>
          )}
          {isMember && (
            <button
              type="button"
              className="button button-danger"
              onClick={() => setDialog('leave')}
            >
              Leave team
            </button>
          )}
          {!isMember &&
            !me?.teamId &&
            !myRequest &&
            team.status !== 'full' &&
            team.acceptingRequests && (
              <button type="button" className="button button-primary" onClick={askToJoin}>
                Ask to join
              </button>
            )}
          {!isMember && myRequest && (
            <span className="row-note">Request sent, waiting for the leader</span>
          )}
        </div>
      </header>

      <section aria-labelledby="seats-title" className="panel">
        <h2 id="seats-title">
          Seats{' '}
          <span className="count">
            {team.memberCount} of {team.maxSize} taken
          </span>
        </h2>
        <SeatStrip team={team} size="xl" pendingUserId={pendingSeat} />
        <ul className="members">
          {team.members.map((member) => (
            <li key={member.userId} className="member">
              <Avatar name={member.name} />
              <div className="row-main">
                <p className="member-name">
                  {member.name}
                  {member.userId === team.leaderId && <span className="role">Leader</span>}
                  {member.userId === user.id && <span className="role role-you">You</span>}
                </p>
                <p className="row-meta">{formatOffset(member.utcOffsetMinutes)}</p>
                <SkillList skills={member.skills} />
              </div>
              {isLeader && member.userId !== user.id && (
                <div className="member-actions">
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={() =>
                      act(
                        () => put(`/api/teams/${teamId}/leader`, { userId: member.userId }),
                        `${member.name} is now the leader.`,
                      )
                    }
                  >
                    Make leader<span className="sr-only">: {member.name}</span>
                  </button>
                  <button
                    type="button"
                    className="button button-quiet"
                    onClick={() => setDialog({ remove: member })}
                  >
                    Remove<span className="sr-only"> {member.name}</span>
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {isLeader && (
        <div className="team-columns">
          <RequestsPanel requests={requests} team={team} onAccept={accept} onDecline={decline} />
          <InvitesPanel
            teamId={teamId}
            invites={invites}
            onChange={() =>
              get(`/api/teams/${teamId}/invites`).then((data) => setInvites(data.invites))
            }
          />
        </div>
      )}

      {isMember && (
        <section aria-labelledby="history-title" className="panel">
          <h2 id="history-title">History</h2>
          <p className="hint">Every change to this team, with who made it and when.</p>
          <ol className="history">
            {history.map((entry) => (
              <li key={entry.id}>
                <span>{describeEvent(entry)}</span>
                <time dateTime={entry.at} title={new Date(entry.at).toLocaleString()}>
                  {timeAgo(entry.at)}
                </time>
              </li>
            ))}
          </ol>
        </section>
      )}

      <Dialog open={dialog === 'leave'} onClose={() => setDialog(null)} title="Leave this team?">
        <p>
          {team.memberCount === 1
            ? 'You are the only member, so the team will be closed and its invite codes will stop working.'
            : isLeader
              ? 'Leadership passes to the member who has been on the team the longest.'
              : 'Your seat opens up for someone else.'}
        </p>
        <div className="dialog-actions">
          <button type="button" className="button button-quiet" onClick={() => setDialog(null)}>
            Stay
          </button>
          <button type="button" className="button button-danger" onClick={leave}>
            Leave team
          </button>
        </div>
      </Dialog>

      <Dialog
        open={Boolean(dialog?.remove)}
        onClose={() => setDialog(null)}
        title={`Remove ${dialog?.remove?.name ?? ''}?`}
      >
        <p>Their seat opens up and they go back to the “people looking” board.</p>
        <div className="dialog-actions">
          <button type="button" className="button button-quiet" onClick={() => setDialog(null)}>
            Cancel
          </button>
          <button
            type="button"
            className="button button-danger"
            onClick={() => {
              const member = dialog.remove;
              setDialog(null);
              act(
                () => del(`/api/teams/${teamId}/members/${member.userId}`),
                `${member.name} was removed.`,
              );
            }}
          >
            Remove from team
          </button>
        </div>
      </Dialog>

      {isLeader && (
        <EditTeamDialog
          open={dialog === 'edit'}
          team={team}
          onClose={() => setDialog(null)}
          onSave={(input) => {
            setDialog(null);
            return act(() => patch(`/api/teams/${teamId}`, input), 'Team saved.');
          }}
        />
      )}
    </div>
  );
}

function RequestsPanel({ requests, team, onAccept, onDecline }) {
  return (
    <section aria-labelledby="requests-title" className="panel">
      <h2 id="requests-title">
        Requests to join <span className="count">{requests.length}</span>
      </h2>
      {requests.length === 0 ? (
        <EmptyState title="No requests waiting.">
          New requests appear here as soon as someone asks, without refreshing.
        </EmptyState>
      ) : (
        <ul className="rows rows-tight">
          {requests.map((request) => (
            <li key={request.id} className="row request-row">
              <Avatar name={request.user.name} />
              <div className="row-main">
                <p className="member-name">{request.user.name}</p>
                <p className="row-meta">
                  {formatOffset(request.user.utcOffsetMinutes)}, asked {timeAgo(request.createdAt)}
                </p>
                {request.message && <p className="row-text">“{request.message}”</p>}
                <SkillList skills={request.user.skills} highlight={team.lookingFor} />
              </div>
              <div className="row-action">
                <button
                  type="button"
                  className="button button-accent"
                  disabled={team.openSeats === 0}
                  onClick={() => onAccept(request)}
                >
                  Accept<span className="sr-only"> {request.user.name}</span>
                </button>
                <button
                  type="button"
                  className="button button-quiet"
                  onClick={() => onDecline(request)}
                >
                  Decline<span className="sr-only"> {request.user.name}</span>
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {team.openSeats === 0 && requests.length > 0 && (
        <p className="hint">The team is full. Free a seat to accept someone.</p>
      )}
    </section>
  );
}

const EXPIRY_OPTIONS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 24 * 60, label: '24 hours' },
  { minutes: 48 * 60, label: '2 days' },
  { minutes: 7 * 24 * 60, label: '7 days' },
];

function InvitesPanel({ teamId, invites, onChange }) {
  const toast = useToast();
  const [minutes, setMinutes] = useState(48 * 60);
  const [fresh, setFresh] = useState(null);

  async function create(event) {
    event.preventDefault();
    try {
      const { invite } = await post(`/api/teams/${teamId}/invites`, { expiresInMinutes: minutes });
      setFresh(invite);
      onChange();
    } catch (err) {
      toast.error(explain(err));
    }
  }

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast.info(`${what} copied.`);
    } catch {
      toast.error('Copying is blocked in this browser. Select the text and copy it by hand.');
    }
  }

  async function revoke(invite) {
    try {
      await del(`/api/teams/${teamId}/invites/${invite.id}`);
      if (fresh?.id === invite.id) setFresh(null);
      onChange();
    } catch (err) {
      toast.error(explain(err));
    }
  }

  return (
    <section aria-labelledby="invites-title" className="panel">
      <h2 id="invites-title">Invite codes</h2>
      <p className="hint">Anyone with a valid code takes a seat straight away, while seats last.</p>

      {fresh && (
        <div className="fresh-code" role="group" aria-label="New invite code">
          <p className="fresh-code-value">{prettyCode(fresh.code)}</p>
          <p className="hint">Copy it now. For safety the full code is shown only once.</p>
          <div className="fresh-code-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => copy(prettyCode(fresh.code), 'Code')}
            >
              Copy code
            </button>
            <button
              type="button"
              className="button button-quiet"
              onClick={() =>
                copy(`${window.location.origin}/join/${prettyCode(fresh.code)}`, 'Link')
              }
            >
              Copy invite link
            </button>
          </div>
        </div>
      )}

      <form className="invite-form" onSubmit={create}>
        <label>
          <span>Valid for</span>
          <select value={minutes} onChange={(event) => setMinutes(Number(event.target.value))}>
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option.minutes} value={option.minutes}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="button button-accent">
          Create invite code
        </button>
      </form>

      {invites.length > 0 && (
        <ul className="invite-list">
          {invites.map((invite) => (
            <li key={invite.id}>
              <span>
                Code ending in <strong>{invite.hint}</strong>
              </span>
              <span className="row-meta">
                {timeUntil(invite.expiresAt)}, used {invite.uses}{' '}
                {invite.uses === 1 ? 'time' : 'times'}
              </span>
              <button type="button" className="button button-quiet" onClick={() => revoke(invite)}>
                Revoke<span className="sr-only"> code ending in {invite.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EditTeamDialog({ open, team, onClose, onSave }) {
  const [form, setForm] = useState(null);

  useEffect(() => {
    if (open) {
      setForm({
        name: team.name,
        description: team.description,
        lookingFor: team.lookingFor,
        acceptingRequests: team.acceptingRequests,
      });
    }
    // Only reset the form when the dialog opens, not on every live update of the team.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title="Edit team">
      {form && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave(form);
          }}
        >
          <Field label="Team name">
            {(props) => (
              <input
                {...props}
                value={form.name}
                required
                minLength={3}
                maxLength={40}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            )}
          </Field>
          <Field label="What are you building?">
            {(props) => (
              <textarea
                {...props}
                rows={2}
                maxLength={280}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            )}
          </Field>
          <SkillPicker
            legend="Skills you are looking for"
            value={form.lookingFor}
            max={6}
            onChange={(lookingFor) => setForm({ ...form, lookingFor })}
          />
          <label className="switch">
            <input
              type="checkbox"
              checked={form.acceptingRequests}
              onChange={(event) => setForm({ ...form, acceptingRequests: event.target.checked })}
            />
            <span>Let people ask to join from the board</span>
          </label>
          <div className="dialog-actions">
            <button type="button" className="button button-quiet" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="button button-primary">
              Save team
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
