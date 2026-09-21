/* GET /api/stream?game=<id> -- the HLS master manifest for one broadcast.
 *
 * Signed-in only, and deliberately so. Anonymous visitors get NSN's own embed,
 * which carries NSN's ads; our player is the marking tool, for the small set of
 * people who have been invited to use it. Requiring a session also stops this
 * becoming a public "hand me NSN's stream" endpoint.
 *
 * Resolving costs two upstream requests, so the answer is cached per broadcast.
 */
import { getUser } from '@netlify/identity';
import { resolveStream } from '../lib/stream.mjs';
import { json, problem, openStore } from '../lib/http.mjs';
import { isKnownGame } from '../lib/games.mjs';

const CACHE_KEY = (id) => `stream/${id}.json`;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export default async (req) => {
  const url = new URL(req.url);
  const gameId = url.searchParams.get('game') || '';
  if (!/^\d{1,20}$/.test(gameId)) return problem('game must be a broadcast id');

  const user = await getUser();
  if (!user) return problem('sign in to use the marking player', 401);

  if (!await isKnownGame(gameId, url.origin)) return problem('no such broadcast', 404);

  const store = await openStore('streams');
  const cached = await store.get(CACHE_KEY(gameId), { type: 'json' });
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return json({ gameId, ...cached }, 200, { 'Cache-Control': 'private, max-age=3600' });
  }

  let resolved;
  try {
    resolved = await resolveStream(gameId);
  } catch (err) {
    // The pre-2022 broadcasts are the usual cause. The client falls back to the
    // NSN embed, so this is a normal outcome rather than a failure.
    console.warn(`could not resolve stream for ${gameId}:`, err.message);
    return problem('this broadcast has no playable stream', 404);
  }

  const payload = { ...resolved, resolvedAt: Date.now() };
  await store.setJSON(CACHE_KEY(gameId), payload);
  return json({ gameId, ...payload }, 200, { 'Cache-Control': 'private, max-age=3600' });
};

export const config = { path: '/api/stream' };
