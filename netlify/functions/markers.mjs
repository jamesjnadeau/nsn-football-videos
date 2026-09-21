/* /api/markers -- the play markers for one broadcast.
 *
 *   GET  ?game=<id>   approved markers; public, unauthenticated, cached briefly
 *   POST              submit a marker; requires a signed-in user
 *
 * Both live in one function on purpose. Netlify routes by path, and a second
 * function declaring this same path would simply never run -- a `method` narrows
 * a handler but does not break the tie. test/function-routes.test.mjs holds the
 * line; the dispatch below is what makes one path enough.
 */
import { getUser } from '@netlify/identity';
import {
  validateMarker, canPublishDirectly, newMarker, appendApproved,
  approvedKey, pendingKey, pendingPrefix, isDuplicate, MAX_PENDING_PER_USER,
} from '../lib/markers.mjs';
import { json, problem, readJson, openStore } from '../lib/http.mjs';

/** The read path every visitor hits. */
async function listMarkers(req) {
  const gameId = new URL(req.url).searchParams.get('game') || '';
  if (!/^\d{1,20}$/.test(gameId)) return problem('game must be a broadcast id');

  const store = await openStore('markers');
  const saved = await store.get(approvedKey(gameId), { type: 'json' });
  return json(
    { gameId, markers: saved?.markers ?? [] },
    200,
    // Short cache: markers change rarely, but a new one should show up quickly.
    { 'Cache-Control': 'public, max-age=30' }
  );
}

/** Contributors and moderators publish straight to the approved list; everyone
 *  else lands in the review queue. Anonymous requests are rejected outright. */
async function submitMarker(req) {
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
}

export default async (req) => {
  if (req.method === 'GET') return listMarkers(req);
  if (req.method === 'POST') return submitMarker(req);
  return problem('use GET or POST', 405);
};

export const config = { path: '/api/markers' };
