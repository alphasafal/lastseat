import { useEffect, useRef, useState } from 'react';
import { post } from '../lib/api.js';
import { explain, initials } from '../lib/format.js';

const CONTENDERS = 50;
const TEAM_SIZE = 4;
const SEATED = ['AR', 'JK', 'MO'];

/**
 * Runs the headline scenario for real: the server lets 50 throwaway people join a team with
 * one seat left at the same instant, on the same database the app uses, and reports what
 * MongoDB decided. Nothing here is simulated; the dots are coloured from the response.
 */
export default function RaceLab() {
  const [seats, setSeats] = useState(1);
  const [phase, setPhase] = useState('idle'); // idle | racing | revealing | done
  const [run, setRun] = useState(null);
  const [revealed, setRevealed] = useState(0);
  const [error, setError] = useState(null);
  const timer = useRef(null);

  useEffect(() => () => clearInterval(timer.current), []);

  async function start() {
    clearInterval(timer.current);
    setPhase('racing');
    setRun(null);
    setRevealed(0);
    setError(null);
    try {
      const result = await post('/api/lab/race', { contenders: CONTENDERS, seats });
      setRun(result);
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setRevealed(CONTENDERS);
        setPhase('done');
        return;
      }
      // Replay the outcomes in the order the requests actually finished.
      setPhase('revealing');
      let shown = 0;
      timer.current = setInterval(() => {
        shown += 2;
        setRevealed(Math.min(shown, CONTENDERS));
        if (shown >= CONTENDERS) {
          clearInterval(timer.current);
          setPhase('done');
        }
      }, 28);
    } catch (err) {
      setError(explain(err));
      setPhase('idle');
    }
  }

  const busy = phase === 'racing' || phase === 'revealing';
  const openBefore = run ? run.seats : seats;
  const winners = run ? run.results.filter((result) => result.outcome === 'JOINED') : [];
  const shownWinners = winners.filter((winner) => winner.finishedAs <= revealed);

  return (
    <div className="race">
      <div
        className="hero-seats"
        role="img"
        aria-label={`A team of ${TEAM_SIZE} with ${openBefore - shownWinners.length} open seats`}
      >
        {SEATED.slice(0, TEAM_SIZE - openBefore).map((text, index) => (
          <span key={text} className={`seat seat-taken${index === 0 ? ' seat-leader' : ''}`}>
            {text}
          </span>
        ))}
        {Array.from({ length: openBefore }, (_, index) => {
          const winner = shownWinners[index];
          return winner ? (
            <span key={`won-${index}`} className="seat seat-taken seat-won">
              {initials(winner.name)}
            </span>
          ) : (
            <span key={`open-${index}`} className={`seat seat-open${busy ? '' : ' seat-beacon'}`} />
          );
        })}
      </div>

      <div className="race-controls">
        <button
          type="button"
          className="button button-accent race-go"
          onClick={start}
          disabled={busy}
        >
          {busy ? 'Racing…' : run ? 'Run it again' : 'Run the race'}
        </button>
        <label className="race-seats">
          <span>Open seats</span>
          <select
            value={seats}
            disabled={busy}
            onChange={(event) => setSeats(Number(event.target.value))}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
        <p className="race-note">
          {CONTENDERS} people click join at the same instant, on this site&rsquo;s real database.
        </p>
      </div>

      <div className={`crowd crowd-${phase}`} aria-hidden="true">
        {Array.from({ length: CONTENDERS }, (_, index) => {
          const result = run?.results[index];
          const settled = result && result.finishedAs <= revealed;
          const state = !settled
            ? 'waiting'
            : result.outcome === 'JOINED'
              ? 'won'
              : result.outcome === 'TEAM_FULL'
                ? 'full'
                : 'error';
          return (
            <span
              key={index}
              className={`dot dot-${state}`}
              style={{ animationDelay: `${(index * 37) % 400}ms` }}
              title={
                settled ? `${result.name}: ${state === 'won' ? 'joined' : 'team full'}` : undefined
              }
            />
          );
        })}
      </div>

      <div className="race-result" aria-live="polite">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {phase === 'racing' && <p className="race-wait">Waiting for the database to decide…</p>}
        {phase === 'done' && run && <Outcome run={run} winners={winners} />}
      </div>
    </div>
  );
}

function Outcome({ run, winners }) {
  const names = winners.map((winner) => winner.name);
  const who =
    names.length === 1
      ? `${names[0]} got the seat.`
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} got the ${run.seats} seats.`;
  return (
    <>
      <p className="race-sentence">
        {who} The other {run.teamFull} were told the team is full.
        {run.other > 0 && ` ${run.other} requests ended in an error.`}
      </p>
      <p className="race-meta">
        Decided in {run.durationMs.toLocaleString()} ms, after {run.retries.toLocaleString()}{' '}
        transaction retries. Then checked against what is stored:
      </p>
      <ul className="checks">
        {run.checks.map((check) => (
          <li key={check.label} className={check.ok ? 'check-ok' : 'check-bad'}>
            <span className="check-mark" aria-hidden="true">
              {check.ok ? '✓' : '✕'}
            </span>
            <span className="sr-only">{check.ok ? 'Passed: ' : 'Failed: '}</span>
            {check.label}
          </li>
        ))}
      </ul>
      {run.note && <p className="race-meta">{run.note}</p>}
    </>
  );
}
