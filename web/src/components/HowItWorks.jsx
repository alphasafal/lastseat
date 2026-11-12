const REPO = 'https://github.com/alphasafal/lastseat';

const CLAIM = `teams.findOneAndUpdate(
  {
    _id: teamId,
    // a seat still exists
    openSeats: { $gt: 0 },
    // and I am not in the team yet
    'members.userId': { $ne: userId },
  },
  {
    $push: { members: me },
    $inc: {
      openSeats: -1,
      memberCount: 1,
    },
  },
);`;

export default function HowItWorks() {
  return (
    <section className="how" aria-labelledby="how-title">
      <h2 id="how-title">Why only one gets in</h2>
      <div className="how-grid">
        <pre className="code" tabIndex={0} aria-label="The update that claims a seat">
          <code>{CLAIM}</code>
        </pre>
        <dl className="how-points">
          <div>
            <dt>The check is part of the write</dt>
            <dd>
              There is no moment between &ldquo;is there a seat?&rdquo; and &ldquo;take it&rdquo;
              for someone else to slip into. MongoDB applies writes to one team one at a time, so
              the first request takes the seat and the other 49 no longer match.
            </dd>
          </div>
          <div>
            <dt>One team per person is an index</dt>
            <dd>
              A unique index on the hackathon and member makes a second team for the same person
              impossible to store, whatever the code does.
            </dd>
          </div>
          <div>
            <dt>A join is all or nothing</dt>
            <dd>
              The seat, the board, the history entry and the retry key commit in one transaction. A
              double click or a dropped connection replays the first answer.
            </dd>
          </div>
        </dl>
      </div>
      <p className="how-links">
        <a href={REPO}>Source on GitHub</a>
        <a href={`${REPO}/blob/main/docs/DESIGN.md`}>Design doc</a>
        <a href={`${REPO}/blob/main/docs/LOAD_TEST_REPORT.md`}>Load-test report</a>
      </p>
    </section>
  );
}
