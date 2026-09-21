/* GET /api/markers?game=<id> -- approved markers for one broadcast.
 * Public and unauthenticated: this is the read path every visitor hits. */
import { approvedKey } from '../lib/markers.mjs';
import { json, problem, openStore } from '../lib/http.mjs';

export default async (req) => {
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
};

export const config = { path: '/api/markers' };
