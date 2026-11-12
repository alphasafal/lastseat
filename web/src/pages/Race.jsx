import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import HowItWorks from '../components/HowItWorks.jsx';
import RaceLab from '../components/RaceLab.jsx';

export default function Race() {
  useEffect(() => {
    document.title = 'Race lab | Lastseat';
  }, []);

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Lastseat, back to start">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          lastseat
        </Link>
        <nav className="topbar-nav" aria-label="Site">
          <Link to="/">Back to the board</Link>
        </nav>
      </header>
      <main className="page race-page">
        <h1>Race lab</h1>
        <p className="landing-lede">
          A team has one seat left and fifty people click join at once. Run it and see what the
          database decides.
        </p>
        <RaceLab />
        <HowItWorks />
      </main>
    </>
  );
}
