// Every failure a client can see is an AppError with a stable machine-readable code.
// The UI switches on `code`, never on the English message.

export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} code stable identifier, e.g. TEAM_FULL
   * @param {string} message human-readable explanation
   * @param {object} [details] extra fields merged into the response
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const errors = {
  validation: (issues) =>
    new AppError(400, 'VALIDATION_FAILED', 'Request is not valid.', { issues }),
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.'),
  badCredentials: () => new AppError(401, 'BAD_CREDENTIALS', 'Email or password is incorrect.'),
  forbidden: (message = 'You are not allowed to do that.') =>
    new AppError(403, 'FORBIDDEN', message),
  notLeader: () => new AppError(403, 'NOT_TEAM_LEADER', 'Only the team leader can do that.'),
  crossOrigin: () => new AppError(403, 'CROSS_ORIGIN', 'Cross-origin requests are not accepted.'),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} was not found.`),
  emailTaken: () => new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists.'),
  notRegistered: () =>
    new AppError(409, 'NOT_REGISTERED', 'Register for this hackathon before forming a team.'),
  alreadyInTeam: () =>
    new AppError(409, 'ALREADY_IN_TEAM', 'You can only be in one team per hackathon.'),
  subjectAlreadyInTeam: () =>
    new AppError(409, 'USER_ALREADY_IN_TEAM', 'That person has already joined another team.'),
  teamFull: () => new AppError(409, 'TEAM_FULL', 'That seat was just taken. The team is full.'),
  teamNameTaken: () =>
    new AppError(409, 'TEAM_NAME_TAKEN', 'Another team in this hackathon already uses that name.'),
  notAMember: () => new AppError(409, 'NOT_A_MEMBER', 'That person is not a member of this team.'),
  requestsClosed: () =>
    new AppError(409, 'REQUESTS_CLOSED', 'This team is not accepting join requests.'),
  requestExists: () =>
    new AppError(409, 'REQUEST_EXISTS', 'You already have a pending request for this team.'),
  requestNotPending: () =>
    new AppError(409, 'REQUEST_NOT_PENDING', 'This request has already been decided.'),
  tooManyRequests: (limit) =>
    new AppError(
      409,
      'TOO_MANY_PENDING_REQUESTS',
      `You can have at most ${limit} pending requests.`,
    ),
  tooManyInvites: (limit) =>
    new AppError(409, 'TOO_MANY_INVITES', `A team can have at most ${limit} active invite codes.`),
  conflict: () =>
    new AppError(409, 'CONFLICT', 'The team changed while you were doing that. Please try again.'),
  // Deliberately identical for unknown, expired and revoked codes so a guesser learns nothing.
  inviteInvalid: () =>
    new AppError(404, 'INVITE_INVALID', 'This invite code is not valid or has expired.'),
  idempotencyKeyReused: () =>
    new AppError(
      422,
      'IDEMPOTENCY_KEY_REUSED',
      'This Idempotency-Key was already used for a different request.',
    ),
  busy: () =>
    new AppError(503, 'BUSY', 'This team is busy right now. Please try again in a moment.', {
      retryAfterSec: 2,
    }),
  rateLimited: (retryAfterSec) =>
    new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.', {
      retryAfterSec,
    }),
};

const DUPLICATE_KEY = 11000;

export function isDuplicateKey(err, indexName) {
  if (err?.code !== DUPLICATE_KEY) return false;
  if (!indexName) return true;
  // The driver exposes keyPattern, but the index name in the message is the most reliable signal
  // across server versions.
  return String(err.message).includes(indexName);
}
