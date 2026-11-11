import { useState } from 'react';
import { Field, SkillPicker, Tabs } from '../components/ui.jsx';
import { explain } from '../lib/format.js';
import { useSession } from '../lib/session.jsx';

const DEMO_TEAM = {
  memberCount: 3,
  maxSize: 4,
  members: ['AR', 'JK', 'MO'],
};

export default function Landing() {
  const { login, register, demo } = useSession();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ name: '', email: '', password: '', skills: [] });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (field) => (event) => setForm((f) => ({ ...f, [field]: event.target.value }));

  async function run(action) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(explain(err));
      setBusy(false);
    }
  }

  const submit = (event) => {
    event.preventDefault();
    run(() =>
      mode === 'login'
        ? login({ email: form.email, password: form.password })
        : register({
            ...form,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          }),
    );
  };

  return (
    <main className="landing">
      <section className="landing-pitch" aria-labelledby="pitch-title">
        <p className="brand brand-large">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          lastseat
        </p>
        <h1 id="pitch-title">Fifty people click join. One of them gets the seat.</h1>
        <div className="hero-seats" role="img" aria-label="A team of four with one open seat">
          {DEMO_TEAM.members.map((initialsText) => (
            <span key={initialsText} className="seat seat-taken">
              {initialsText}
            </span>
          ))}
          <span className="seat seat-open seat-beacon" />
        </div>
        <p className="landing-lede">
          Form a hackathon team with an invite code or a join request, and watch the board of people
          looking for teammates update as it happens. Seats are never double-booked, however many
          people reach for the same one.
        </p>
      </section>

      <section className="landing-auth" aria-label="Sign in or create an account">
        <Tabs
          label="Account"
          active={mode}
          onChange={(next) => {
            setMode(next);
            setError(null);
          }}
          tabs={[
            { id: 'login', label: 'Sign in' },
            { id: 'register', label: 'Create account' },
          ]}
        />
        <form
          id={`panel-${mode}`}
          role="tabpanel"
          aria-labelledby={`tab-${mode}`}
          onSubmit={submit}
          noValidate={false}
        >
          {mode === 'register' && (
            <Field label="Name">
              {(props) => (
                <input
                  {...props}
                  value={form.name}
                  onChange={set('name')}
                  required
                  minLength={2}
                  maxLength={60}
                  autoComplete="name"
                />
              )}
            </Field>
          )}
          <Field label="Email">
            {(props) => (
              <input
                {...props}
                type="email"
                value={form.email}
                onChange={set('email')}
                required
                autoComplete="email"
              />
            )}
          </Field>
          <Field label="Password" hint={mode === 'register' ? 'At least 8 characters.' : undefined}>
            {(props) => (
              <input
                {...props}
                type="password"
                value={form.password}
                onChange={set('password')}
                required
                minLength={mode === 'register' ? 8 : 1}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            )}
          </Field>
          {mode === 'register' && (
            <SkillPicker
              legend="Your skills"
              hint="Pick up to 8. Teams use these to find you."
              value={form.skills}
              max={8}
              onChange={(skills) => setForm((f) => ({ ...f, skills }))}
            />
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button button-primary button-wide" disabled={busy}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <div className="landing-demo">
          <p>Just looking around?</p>
          <button
            type="button"
            className="button button-accent button-wide"
            disabled={busy}
            onClick={() => run(demo)}
          >
            Try a demo account
          </button>
          <p className="hint">
            Creates a throwaway account. Open a second browser window to see the board update live.
          </p>
        </div>
      </section>
    </main>
  );
}
