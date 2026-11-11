// The rules that must hold in the database at every instant, written as a checker.
// The race test, the chaos test and `npm run verify` (after a load test) all call this,
// so "nothing is corrupted" is something we measure rather than assume.

const id = (value) => String(value);

/**
 * @param {import('mongodb').Db} database
 * @param {{hackathonId?: import('mongodb').ObjectId}} [scope]
 * @returns {Promise<{ok: boolean, violations: string[], stats: object}>}
 */
export async function checkInvariants(database, scope = {}) {
  const filter = scope.hackathonId ? { hackathonId: scope.hackathonId } : {};
  const violations = [];
  const fail = (message) => violations.push(message);

  const [teams, participants, pending, hackathons] = await Promise.all([
    database.collection('teams').find(filter).toArray(),
    database.collection('participants').find(filter).toArray(),
    database.collection('join_requests').find({ ...filter, status: 'pending' }).toArray(),
    database.collection('hackathons').find().toArray(),
  ]);
  const limits = new Map(hackathons.map((h) => [id(h._id), h]));
  const teamById = new Map(teams.map((team) => [id(team._id), team]));
  const seatOf = new Map(); // "hackathon:user" -> team id

  for (const team of teams) {
    const label = `team ${team.name} (${team._id})`;
    const memberIds = team.members.map((member) => id(member.userId));
    const hackathon = limits.get(id(team.hackathonId));

    if (team.members.length !== team.memberCount) {
      fail(`${label}: memberCount ${team.memberCount} but ${team.members.length} members`);
    }
    if (team.memberCount < 1) fail(`${label}: exists with no members`);
    if (team.memberCount > team.maxSize) {
      fail(`${label}: OVERSOLD - ${team.memberCount} members for ${team.maxSize} seats`);
    }
    if (team.openSeats !== team.maxSize - team.memberCount) {
      fail(`${label}: openSeats ${team.openSeats} != ${team.maxSize} - ${team.memberCount}`);
    }
    if (team.openSeats < 0) fail(`${label}: negative openSeats`);
    if (hackathon && team.maxSize > hackathon.maxTeamSize) {
      fail(`${label}: maxSize ${team.maxSize} exceeds hackathon limit ${hackathon.maxTeamSize}`);
    }
    if (new Set(memberIds).size !== memberIds.length) fail(`${label}: duplicate member`);
    if (!memberIds.includes(id(team.leaderId))) fail(`${label}: leader is not a member`);

    for (const userId of memberIds) {
      const key = `${team.hackathonId}:${userId}`;
      if (seatOf.has(key)) {
        fail(`user ${userId} is in two teams: ${seatOf.get(key)} and ${team._id}`);
      }
      seatOf.set(key, id(team._id));
    }
  }

  // The participant row is a copy of membership kept for the board; it must agree with teams.
  const participantKeys = new Set();
  for (const participant of participants) {
    const key = `${participant.hackathonId}:${participant.userId}`;
    participantKeys.add(key);
    const seat = seatOf.get(key) ?? null;
    const recorded = participant.teamId ? id(participant.teamId) : null;
    if (seat !== recorded) {
      fail(`participant ${participant.userId}: teamId ${recorded} but actually seated in ${seat}`);
    }
    if (participant.teamId && participant.lookingForTeam) {
      fail(`participant ${participant.userId}: in a team but still listed as looking`);
    }
  }
  for (const key of seatOf.keys()) {
    if (!participantKeys.has(key)) fail(`team member ${key} has no participant record`);
  }

  for (const request of pending) {
    if (!teamById.has(id(request.teamId))) {
      fail(`pending request ${request._id} points at a deleted team`);
    }
    if (seatOf.has(`${request.hackathonId}:${request.userId}`)) {
      fail(`pending request ${request._id} belongs to someone who already has a team`);
    }
  }

  // The audit log must add up to the current state: members = initial + joined - left - removed.
  const movement = await database
    .collection('audit_log')
    .aggregate([
      {
        $match: {
          ...filter,
          type: { $in: ['team.created', 'member.joined', 'member.left', 'member.removed'] },
        },
      },
      {
        $group: {
          _id: '$teamId',
          initial: {
            $sum: {
              $cond: [
                { $eq: ['$type', 'team.created'] },
                { $ifNull: ['$data.seededMembers', 1] },
                0,
              ],
            },
          },
          joined: { $sum: { $cond: [{ $eq: ['$type', 'member.joined'] }, 1, 0] } },
          gone: {
            $sum: { $cond: [{ $in: ['$type', ['member.left', 'member.removed']] }, 1, 0] },
          },
        },
      },
    ])
    .toArray();
  const movementByTeam = new Map(movement.map((row) => [id(row._id), row]));
  for (const team of teams) {
    const row = movementByTeam.get(id(team._id));
    if (!row) {
      fail(`team ${team.name} (${team._id}): no audit trail`);
      continue;
    }
    const expected = row.initial + row.joined - row.gone;
    if (expected !== team.memberCount) {
      fail(
        `team ${team.name} (${team._id}): audit log implies ${expected} members, found ${team.memberCount}`,
      );
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    stats: {
      teams: teams.length,
      participants: participants.length,
      seated: seatOf.size,
      fullTeams: teams.filter((team) => team.openSeats === 0).length,
      pendingRequests: pending.length,
    },
  };
}
