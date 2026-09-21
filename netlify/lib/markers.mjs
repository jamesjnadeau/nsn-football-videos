/* Play markers: validation, identity/role rules, and Blobs storage.
 *
 * Storage layout is shaped by the access pattern. Reads dominate -- every
 * visitor opening a game page wants that game's approved markers -- so those
 * live in one array per game and cost a single GET. Writes are rare, so the
 * cost of a compare-and-swap retry on that array is acceptable.
 *
 *   approved/<gameId>.json            { markers: [...] }  CAS via onlyIfMatch
 *   pending/<userId>/<markerId>.json  { ...marker }       queue = list({ prefix })
 *
 * Pending submissions get one blob each rather than a shared queue file, so
 * concurrent submitters never contend on the same key. They are filed under the
 * submitting user so rate limiting is a prefix list rather than a full scan of
 * the queue.
 */

export const ROLE_CONTRIBUTOR = 'contributor';
export const ROLE_MODERATOR = 'moderator';

export const MAX_LABEL = 80;
export const MAX_NOTE = 280;
export const MIN_PLAY_SEC = 1;
export const MAX_PLAY_SEC = 600;      // 10 minutes; a "play" longer than this is a mistake
export const MAX_PENDING_PER_USER = 25;

/** Netlify Identity exposes roles as an array, older shapes as a single string. */
export function rolesOf(user) {
  if (!user) return [];
  const many = Array.isArray(user.roles) ? user.roles : [];
  const one = typeof user.role === 'string' && user.role ? [user.role] : [];
  return [...new Set([...many, ...one])];
}

export function hasRole(user, role) { return rolesOf(user).includes(role); }
export function isModerator(user) { return hasRole(user, ROLE_MODERATOR); }
/** Moderators can post directly too; not being able to would be absurd. */
export function canPublishDirectly(user) {
  return hasRole(user, ROLE_CONTRIBUTOR) || isModerator(user);
}

/**
 * Validate a submitted marker.
 * Returns { ok: true, value } or { ok: false, error } -- never throws, so the
 * function layer can map straight onto a 400.
 */
export function validateMarker(input, { durationSec } = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!input || typeof input !== 'object') return fail('missing body');

  const gameId = String(input.gameId ?? '').trim();
  if (!/^\d{1,20}$/.test(gameId)) return fail('gameId must be a broadcast id');

  const start = Number(input.startSec);
  const end = Number(input.endSec);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return fail('startSec and endSec must be numbers');
  if (start < 0) return fail('startSec cannot be negative');
  if (end <= start) return fail('endSec must be after startSec');

  const length = end - start;
  if (length < MIN_PLAY_SEC) return fail(`a play must be at least ${MIN_PLAY_SEC}s long`);
  if (length > MAX_PLAY_SEC) return fail(`a play cannot be longer than ${MAX_PLAY_SEC}s`);
  // Only bound against the broadcast when we know how long it is.
  if (Number.isFinite(durationSec) && durationSec > 0 && end > durationSec + 1) {
    return fail('endSec is past the end of the broadcast');
  }

  const label = String(input.label ?? '').trim().replace(/\s+/g, ' ');
  if (!label) return fail('label is required');
  if (label.length > MAX_LABEL) return fail(`label must be ${MAX_LABEL} characters or fewer`);

  const note = String(input.note ?? '').trim().replace(/\s+/g, ' ');
  if (note.length > MAX_NOTE) return fail(`note must be ${MAX_NOTE} characters or fewer`);

  return {
    ok: true,
    value: {
      gameId,
      startSec: Math.round(start * 100) / 100,
      endSec: Math.round(end * 100) / 100,
      label,
      note: note || undefined,
    },
  };
}

/** Two markers on the same game overlapping by more than half their length. */
export function isDuplicate(candidate, existing) {
  return existing.some((m) => {
    const overlap = Math.min(m.endSec, candidate.endSec) - Math.max(m.startSec, candidate.startSec);
    if (overlap <= 0) return false;
    const shorter = Math.min(m.endSec - m.startSec, candidate.endSec - candidate.startSec);
    return overlap / shorter > 0.5 && m.label.toLowerCase() === candidate.label.toLowerCase();
  });
}

export const approvedKey = (gameId) => `approved/${gameId}.json`;

/** Blob keys cannot start with "/"; ids are UUIDs but sanitise defensively. */
const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
export const pendingPrefix = (userId) => `pending/${safe(userId)}/`;
export const pendingKey = (userId, markerId) => `${pendingPrefix(userId)}${safe(markerId)}.json`;

export function newMarker(value, user, status) {
  return {
    id: crypto.randomUUID(),
    ...value,
    status,
    createdBy: user.id,
    createdByName: user.name || (user.email ? user.email.split('@')[0] : 'anonymous'),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Append to a game's approved list, retrying on a lost compare-and-swap.
 * Netlify Blobs is last-write-wins without onlyIfMatch, so two people marking
 * the same game at once would otherwise silently drop one of the markers.
 */
export async function appendApproved(store, gameId, marker, { attempts = 5 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const key = approvedKey(gameId);
    const current = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    const markers = current?.data?.markers ?? [];

    if (markers.some((m) => m.id === marker.id)) return { markers, added: false };

    const next = { markers: [...markers, marker].sort((a, b) => a.startSec - b.startSec) };
    // onlyIfNew for a game nobody has marked yet; onlyIfMatch once it exists.
    const opts = current?.etag ? { onlyIfMatch: current.etag } : { onlyIfNew: true };
    const { modified } = await store.setJSON(key, next, opts);
    if (modified) return { markers: next.markers, added: true };
  }
  throw new Error('could not save marker after repeated write conflicts');
}

/** Who may change a published marker at all -- edit or remove it: whoever put
 *  it up, or a moderator. */
export function canModify(user, marker) {
  if (!user || !marker) return false;
  return isModerator(user) || marker.createdBy === user.id;
}

/**
 * Remove one marker from a game's approved list, under the same
 * compare-and-swap as appendApproved so a concurrent add is not clobbered.
 * Returns { removed: false } when it was already gone -- deleting twice is not
 * an error, it is the outcome the caller wanted.
 */
export async function removeApproved(store, gameId, markerId, { attempts = 5 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const key = approvedKey(gameId);
    const current = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    const markers = current?.data?.markers ?? [];

    const marker = markers.find((m) => m.id === markerId);
    if (!marker) return { removed: false, marker: null, markers };

    const next = { markers: markers.filter((m) => m.id !== markerId) };
    const { modified } = await store.setJSON(key, next, { onlyIfMatch: current.etag });
    if (modified) return { removed: true, marker, markers: next.markers };
  }
  throw new Error('could not remove marker after repeated write conflicts');
}

/**
 * Change one marker in place, under the same compare-and-swap as the other
 * writers. Identity and provenance are not the caller's to change: the id, who
 * marked it, when, and its status all survive the merge.
 */
export async function updateApproved(store, gameId, markerId, changes, { attempts = 5 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const key = approvedKey(gameId);
    const current = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    const markers = current?.data?.markers ?? [];

    const existing = markers.find((m) => m.id === markerId);
    if (!existing) return { updated: false, marker: null, markers };

    const merged = {
      ...existing,
      ...changes,
      id: existing.id,
      createdBy: existing.createdBy,
      createdByName: existing.createdByName,
      createdAt: existing.createdAt,
      status: existing.status,
    };
    // Editing a start time reorders the list, which is kept sorted for display.
    const next = {
      markers: markers
        .map((m) => (m.id === markerId ? merged : m))
        .sort((a, b) => a.startSec - b.startSec),
    };
    const { modified } = await store.setJSON(key, next, { onlyIfMatch: current.etag });
    if (modified) return { updated: true, marker: merged, markers: next.markers };
  }
  throw new Error('could not update marker after repeated write conflicts');
}
