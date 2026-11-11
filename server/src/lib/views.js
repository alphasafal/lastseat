// The only shapes that ever leave the server. Nothing is serialised straight from a
// database document, so adding a private field to a collection can never leak it.

export function teamStatus(team) {
  if (team.openSeats === 0) return 'full';
  return team.memberCount >= team.minSize ? 'ready' : 'forming';
}

export function teamView(team) {
  return {
    id: String(team._id),
    hackathonId: String(team.hackathonId),
    name: team.name,
    description: team.description,
    lookingFor: team.lookingFor,
    leaderId: String(team.leaderId),
    members: team.members.map((member) => ({
      userId: String(member.userId),
      name: member.name,
      skills: member.skills,
      utcOffsetMinutes: member.utcOffsetMinutes,
      joinedAt: member.joinedAt,
    })),
    memberCount: team.memberCount,
    minSize: team.minSize,
    maxSize: team.maxSize,
    openSeats: team.openSeats,
    status: teamStatus(team),
    acceptingRequests: team.acceptingRequests,
    version: team.version,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

export function personView(participant) {
  return {
    userId: String(participant.userId),
    name: participant.name,
    skills: participant.skills,
    headline: participant.headline,
    timezone: participant.timezone,
    utcOffsetMinutes: participant.utcOffsetMinutes,
    lookingForTeam: participant.lookingForTeam,
    teamId: participant.teamId ? String(participant.teamId) : null,
    updatedAt: participant.updatedAt,
  };
}

export function hackathonView(hackathon) {
  return {
    id: String(hackathon._id),
    slug: hackathon.slug,
    name: hackathon.name,
    tagline: hackathon.tagline,
    minTeamSize: hackathon.minTeamSize,
    maxTeamSize: hackathon.maxTeamSize,
    startsAt: hackathon.startsAt,
  };
}

export function inviteView(invite, code) {
  return {
    id: String(invite._id),
    teamId: String(invite.teamId),
    // The code itself is only present in the response that creates it.
    ...(code ? { code } : {}),
    hint: invite.hint,
    createdBy: String(invite.createdBy),
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    revokedAt: invite.revokedAt,
    uses: invite.uses,
  };
}

export function joinRequestView(request) {
  return {
    id: String(request._id),
    teamId: String(request.teamId),
    teamName: request.teamName,
    hackathonId: String(request.hackathonId),
    user: {
      userId: String(request.userId),
      name: request.userName,
      skills: request.userSkills,
      utcOffsetMinutes: request.userUtcOffsetMinutes,
    },
    message: request.message,
    status: request.status,
    reason: request.reason ?? null,
    createdAt: request.createdAt,
    decidedAt: request.decidedAt ?? null,
  };
}

export function auditView(entry) {
  return {
    id: String(entry._id),
    type: entry.type,
    at: entry.at,
    teamId: entry.teamId ? String(entry.teamId) : null,
    actor: entry.actorId ? { userId: String(entry.actorId), name: entry.actorName } : null,
    subject: entry.subjectId ? { userId: String(entry.subjectId), name: entry.subjectName } : null,
    data: entry.data ?? {},
  };
}
