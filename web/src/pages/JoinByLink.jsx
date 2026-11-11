import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { post } from '../lib/api.js';
import { explain } from '../lib/format.js';

/** Landing page of an invite link: /join/ABCD-EFGH-JKMN. Signs the person into that team. */
export default function JoinByLink() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const started = useRef(false);

  useEffect(() => {
    // React runs effects twice in development; the join must be sent once.
    if (started.current) return;
    started.current = true;
    post('/api/invites/join', { code })
      .then(({ team }) => navigate(`/h/${team.hackathonId}/teams/${team.id}`, { replace: true }))
      .catch((err) => setError(explain(err)));
  }, [code, navigate]);

  return (
    <main className="page narrow">
      {error ? (
        <>
          <h1>You could not join with this link</h1>
          <p role="alert">{error}</p>
          <Link to="/">Go to the board</Link>
        </>
      ) : (
        <p className="page-status">Joining the team…</p>
      )}
    </main>
  );
}
