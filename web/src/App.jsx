import { useEffect, useState } from 'react';
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { LiveBadge } from './components/ui.jsx';
import { get } from './lib/api.js';
import { HackathonProvider, useHackathon } from './lib/hackathon.jsx';
import { useSession } from './lib/session.jsx';
import Board from './pages/Board.jsx';
import JoinByLink from './pages/JoinByLink.jsx';
import Landing from './pages/Landing.jsx';
import Team from './pages/Team.jsx';

export default function App() {
  const { user } = useSession();
  if (user === undefined) return <p className="page-status">Loading…</p>;

  return (
    <Routes>
      <Route path="/" element={user ? <Home /> : <Landing />} />
      <Route path="/join/:code" element={user ? <JoinByLink /> : <Landing />} />
      <Route element={user ? <HackathonShell /> : <RequireSignIn />}>
        <Route path="/h/:hackathonId" element={<Board />} />
        <Route path="/h/:hackathonId/teams/:teamId" element={<Team />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function RequireSignIn() {
  const location = useLocation();
  return <Navigate to="/" replace state={{ next: location.pathname }} />;
}

/** Signed-in home: there is one hackathon in the demo, so go straight to its board. */
function Home() {
  const [hackathons, setHackathons] = useState(null);
  const location = useLocation();
  useEffect(() => {
    get('/api/hackathons').then((data) => setHackathons(data.hackathons));
  }, []);

  if (location.state?.next) return <Navigate to={location.state.next} replace />;
  if (!hackathons) return <p className="page-status">Loading…</p>;
  if (hackathons.length === 1) return <Navigate to={`/h/${hackathons[0].id}`} replace />;
  return (
    <main className="page narrow">
      <h1>Hackathons</h1>
      <ul className="plain-list">
        {hackathons.map((hackathon) => (
          <li key={hackathon.id}>
            <Link to={`/h/${hackathon.id}`}>{hackathon.name}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

function HackathonShell() {
  const { hackathonId, teamId } = useParams();
  return (
    // Keyed by hackathon so switching hackathon starts from a clean state.
    <HackathonProvider key={hackathonId} hackathonId={hackathonId} teamId={teamId}>
      <Shell />
    </HackathonProvider>
  );
}

function Shell() {
  const { user, logout } = useSession();
  const { hackathon, hackathonId, status, error, myTeam } = useHackathon();
  const navigate = useNavigate();

  if (error) {
    return (
      <main className="page narrow">
        <h1>This hackathon could not be opened</h1>
        <p>{error.message}</p>
        <Link to="/">Back to start</Link>
      </main>
    );
  }

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to={`/h/${hackathonId}`} className="brand" aria-label="Lastseat, back to the board">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          lastseat
        </Link>
        <span className="topbar-hackathon">{hackathon?.name}</span>
        <LiveBadge status={status} />
        <nav className="topbar-nav" aria-label="Account">
          {myTeam && (
            <Link to={`/h/${hackathonId}/teams/${myTeam.id}`} className="topbar-team">
              My team
            </Link>
          )}
          <span className="topbar-user">{user.name}</span>
          <button
            type="button"
            className="button button-quiet"
            onClick={async () => {
              await logout();
              navigate('/');
            }}
          >
            Sign out
          </button>
        </nav>
      </header>
      <main id="main" className="page" tabIndex={-1}>
        {hackathon ? <Outlet /> : <p className="page-status">Loading…</p>}
      </main>
    </>
  );
}

function NotFound() {
  return (
    <main className="page narrow">
      <h1>Page not found</h1>
      <Link to="/">Back to start</Link>
    </main>
  );
}
