export const SKILLS = [
  'frontend',
  'backend',
  'fullstack',
  'mobile',
  'design',
  'ml',
  'data',
  'devops',
  'security',
  'blockchain',
  'hardware',
  'gamedev',
  'product',
  'pitching',
  'marketing',
  'research',
];

const SKILL_LABELS = { ml: 'ML', devops: 'DevOps', gamedev: 'Game dev', fullstack: 'Full-stack' };
export const skillLabel = (skill) =>
  SKILL_LABELS[skill] ?? skill.charAt(0).toUpperCase() + skill.slice(1);

export function initials(name) {
  const parts = name
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase();
}

export function formatOffset(minutes) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const mins = abs % 60;
  return `UTC${sign}${Math.floor(abs / 60)}${mins ? `:${String(mins).padStart(2, '0')}` : ''}`;
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function timeAgo(value) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86_400), 'day');
}

export function timeUntil(value) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'expired';
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min left`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h left`;
  return `${Math.round(seconds / 86_400)} days left`;
}

/** ABCD-EFGH-JKMN: easier to read aloud and to type on a phone. */
export const prettyCode = (code) => code.replace(/(.{4})(?=.)/g, '$1-');

export function statusText(team) {
  if (team.status === 'full') return 'Full';
  if (team.status === 'ready')
    return `${team.openSeats} ${team.openSeats === 1 ? 'seat' : 'seats'} open`;
  const missing = team.minSize - team.memberCount;
  return `Needs ${missing} more to compete`;
}

/** One sentence per audit entry, written from the reader's point of view. */
export function describeEvent(entry) {
  const actor = entry.actor?.name ?? 'Someone';
  const subject = entry.subject?.name;
  switch (entry.type) {
    case 'team.created':
      return `${actor} created the team`;
    case 'team.updated':
      return `${actor} edited the team details`;
    case 'team.deleted':
      return 'The team was closed because its last member left';
    case 'member.joined':
      return entry.data?.via === 'invite'
        ? `${subject} joined with an invite code`
        : `${subject} joined after ${actor} accepted their request`;
    case 'member.left':
      return `${subject ?? actor} left the team`;
    case 'member.removed':
      return `${actor} removed ${subject}`;
    case 'leader.changed':
      return entry.data?.reason === 'transferred'
        ? `${actor} made ${subject} the leader`
        : `${subject} became leader after the previous leader left`;
    case 'invite.created':
      return `${actor} created an invite code ending in ${entry.data?.hint ?? '....'}`;
    case 'invite.revoked':
      return `${actor} revoked the invite code ending in ${entry.data?.hint ?? '....'}`;
    case 'request.created':
      return `${actor} asked to join`;
    case 'request.accepted':
      return `${actor} accepted ${subject}'s request`;
    case 'request.declined':
      return `${actor} declined ${subject}'s request`;
    case 'request.cancelled':
      return entry.data?.reason === 'joined_a_team'
        ? `${actor}'s request was withdrawn because they joined a team`
        : `${actor} withdrew their request`;
    case 'participant.updated':
      return `${actor} updated their profile`;
    default:
      return entry.type;
  }
}

/** What to tell the user when the server refuses. Falls back to the server's own message. */
export function explain(err) {
  switch (err?.code) {
    case 'TEAM_FULL':
      return 'That seat was just taken. The team is full.';
    case 'ALREADY_IN_TEAM':
      return 'You are already in a team for this hackathon. Leave it first to join another.';
    case 'INVITE_INVALID':
      return 'That code is not valid or has expired. Ask the team leader for a new one.';
    case 'RATE_LIMITED':
      return `Too many attempts. Try again in ${Math.ceil((err.details?.retryAfterSec ?? 60) / 60)} min.`;
    case 'CONFLICT':
      return 'The team changed while you were doing that. Check the latest state and try again.';
    case 'VALIDATION_FAILED':
      return (
        err.details?.issues?.map((issue) => `${issue.path} ${issue.message}`).join('. ') ||
        err.message
      );
    default:
      return err?.message ?? 'Something went wrong.';
  }
}
