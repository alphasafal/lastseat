import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { patch, post } from '../lib/api.js';
import { explain, statusText } from '../lib/format.js';
import { useHackathon } from '../lib/hackathon.jsx';
import { useToast } from '../lib/toast.jsx';
import { Dialog, Field, SeatStrip, SkillList, SkillPicker } from './ui.jsx';

/** The side panel: where you sit in this hackathon, and what you can do about it. */
export default function MySeat() {
  const { me, myTeam, hackathonId } = useHackathon();
  if (!me) return <div className="side" aria-busy="true" />;

  return (
    <div className="side">
      <section className="my-seat" aria-labelledby="my-seat-title">
        <h2 id="my-seat-title">{myTeam ? 'Your team' : 'You do not have a team yet'}</h2>
        {myTeam ? (
          <div className="my-team">
            <SeatStrip team={myTeam} size="lg" />
            <p className="my-team-name">
              <Link to={`/h/${hackathonId}/teams/${myTeam.id}`}>{myTeam.name}</Link>
            </p>
            <p className={`status status-${myTeam.status}`}>{statusText(myTeam)}</p>
            <Link
              className="button button-primary button-wide"
              to={`/h/${hackathonId}/teams/${myTeam.id}`}
            >
              Open team page
            </Link>
          </div>
        ) : (
          <Seatless />
        )}
      </section>
      <ProfileCard />
    </div>
  );
}

function Seatless() {
  const { hackathonId, me, setMe, setMyTeam, myRequests } = useHackathon();
  const toast = useToast();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState(null);
  const [joining, setJoining] = useState(false);
  const pending = myRequests.filter((request) => request.status === 'pending');

  async function joinWithCode(event) {
    event.preventDefault();
    setJoining(true);
    setCodeError(null);
    try {
      const { team, me: person } = await post('/api/invites/join', { code });
      setMyTeam(team);
      if (person) setMe(person);
      toast.info(`You joined ${team.name}.`);
      navigate(`/h/${hackathonId}/teams/${team.id}`);
    } catch (err) {
      setCodeError(explain(err));
      setJoining(false);
    }
  }

  async function setLooking(lookingForTeam) {
    // Optimistic toggle with rollback.
    const before = me;
    setMe({ ...me, lookingForTeam });
    try {
      const data = await patch(`/api/hackathons/${hackathonId}/me`, { lookingForTeam });
      setMe(data.me);
    } catch (err) {
      setMe(before);
      toast.error(explain(err));
    }
  }

  return (
    <>
      <form className="code-form" onSubmit={joinWithCode}>
        <Field label="Have an invite code?" error={codeError}>
          {(props) => (
            <input
              {...props}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="ABCD-EFGH-JKMN"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
            />
          )}
        </Field>
        <button type="submit" className="button button-accent button-wide" disabled={joining}>
          Join team
        </button>
      </form>

      <p className="or">or</p>
      <button
        type="button"
        className="button button-primary button-wide"
        onClick={() => setCreating(true)}
      >
        Create a team
      </button>

      {pending.length > 0 && (
        <div className="my-requests">
          <h3>Requests you sent</h3>
          <ul className="plain-list">
            {pending.map((request) => (
              <li key={request.id}>
                <Link to={`/h/${hackathonId}/teams/${request.teamId}`}>{request.teamName}</Link>
                <span className="row-meta"> waiting for the leader</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label className="switch">
        <input
          type="checkbox"
          checked={me.lookingForTeam}
          onChange={(event) => setLooking(event.target.checked)}
        />
        <span>Show me on the “people looking” board</span>
      </label>

      <CreateTeamDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function CreateTeamDialog({ open, onClose }) {
  const { hackathonId, hackathon, setMyTeam, setMe } = useHackathon();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', description: '', lookingFor: [] });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { team, me } = await post(`/api/hackathons/${hackathonId}/teams`, form);
      setMyTeam(team);
      setMe(me);
      navigate(`/h/${hackathonId}/teams/${team.id}`);
    } catch (err) {
      setError(explain(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Create a team">
      <form onSubmit={submit}>
        <p className="hint">
          You become the leader and take the first of {hackathon.maxTeamSize} seats.
        </p>
        <Field label="Team name" error={error}>
          {(props) => (
            <input
              {...props}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              required
              minLength={3}
              maxLength={40}
            />
          )}
        </Field>
        <Field label="What are you building?" hint="Optional. One or two sentences.">
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
          hint="Up to 6. People with these skills are suggested to you first."
          value={form.lookingFor}
          max={6}
          onChange={(lookingFor) => setForm({ ...form, lookingFor })}
        />
        <div className="dialog-actions">
          <button type="button" className="button button-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            Create team
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ProfileCard() {
  const { hackathonId, me, setMe } = useHackathon();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ skills: [], headline: '' });

  function open() {
    setForm({ skills: me.skills, headline: me.headline });
    setEditing(true);
  }

  async function submit(event) {
    event.preventDefault();
    const before = me;
    setMe({ ...me, ...form });
    setEditing(false);
    try {
      const data = await patch(`/api/hackathons/${hackathonId}/me`, form);
      setMe(data.me);
      toast.info('Profile saved.');
    } catch (err) {
      setMe(before);
      toast.error(explain(err));
    }
  }

  return (
    <section className="profile-card" aria-label="Your profile">
      <h3>{me.name}</h3>
      {me.headline && <p className="row-text">{me.headline}</p>}
      <SkillList skills={me.skills} empty={<p className="row-meta">No skills listed yet.</p>} />
      <button type="button" className="button button-quiet" onClick={open}>
        Edit my skills
      </button>
      <Dialog
        open={editing}
        onClose={() => setEditing(false)}
        title="Your profile for this hackathon"
      >
        <form onSubmit={submit}>
          <Field label="One line about you" hint="Optional. Shown on the people board.">
            {(props) => (
              <input
                {...props}
                value={form.headline}
                maxLength={140}
                onChange={(event) => setForm({ ...form, headline: event.target.value })}
              />
            )}
          </Field>
          <SkillPicker
            legend="Your skills"
            hint="Up to 8."
            value={form.skills}
            max={8}
            onChange={(skills) => setForm({ ...form, skills })}
          />
          <div className="dialog-actions">
            <button type="button" className="button button-quiet" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="submit" className="button button-primary">
              Save profile
            </button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
