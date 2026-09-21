/* POST /api/markers -- submit a play marker.
 *
 * Contributors and moderators publish straight to the approved list; everyone
 * else lands in the review queue. Anonymous requests are rejected outright. */
import { getUser } from '@netlify/identity';
import {
  validateMarker, canPublishDirectly, newMarker, appendApproved,
  approvedKey, pendingKey, pendingPrefix, isDuplicate, MAX_PENDING_PER_USER,
} from '../lib/markers.mjs';
import { json, problem, readJson, openStore } from '../lib/http.mjs';

export default async (req) => {
  if (req.method !== 'POST') return problem('use POST', 405);

  const user = await getUser();
  if (!user) return problem('sign in to add a marker', 401);

  const body = await readJson(req);
  if (!body.ok) return problem(body.error);

  const store = await openStore('markers');

  // Duration bounds the marker, when we know it. The client sends what the
  // game data says; treat it as a hint, never as authority over the limits.
  const durationSec = Number(body.value.durationSec);
  const parsed = validateMarker(body.value, { durationSec });
  if (!parsed.ok) return problem(parsed.error);

  const direct = canPublishDirectly(user);

  if (!direct) {
    const { blobs } = await store.list({ prefix: pendingPrefix(user.id) });
    if (blobs.length >= MAX_PENDING_PER_USER) {
      return problem(`you already have ${blobs.length} submissions awaiting review`, 429);
    }
  }

  const existing = (await store.get(approvedKey(parsed.value.gameId), { type: 'json' }))?.markers ?? [];
  if (isDuplicate(parsed.value, existing)) {
    return problem('that play is already marked', 409);
  }

  const marker = newMarker(parsed.value, user, direct ? 'approved' : 'pending');

  if (direct) {
    await appendApproved(store, marker.gameId, marker);
    return json({ status: 'published', marker }, 201);
  }

  await store.setJSON(pendingKey(user.id, marker.id), marker, { onlyIfNew: true });
  return json({ status: 'pending', marker }, 202);
};

export const config = { path: '/api/markers', method: 'POST' };
