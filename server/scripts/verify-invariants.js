// Checks every data invariant against the live database and exits non-zero on a violation.
// Run it after a load test or a crash:  npm run verify

import { connect, db, disconnect } from '../src/db.js';
import { checkInvariants } from '../src/lib/invariants.js';

await connect();
const report = await checkInvariants(db());
await disconnect();

console.log(JSON.stringify(report.stats, null, 2));
if (report.ok) {
  console.log('All invariants hold.');
} else {
  console.error(`${report.violations.length} violation(s):`);
  for (const violation of report.violations) console.error(` - ${violation}`);
  process.exit(1);
}
