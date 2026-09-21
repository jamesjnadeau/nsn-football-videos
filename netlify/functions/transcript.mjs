/* GET /api/transcript?game=<id>
 *
 * Returns a cached transcript, or kicks off the background build and answers
 * 202 so the page can poll. Assembling one costs ~757 requests to NSN's CDN,
 * so it happens once per broadcast and only for games somebody actually opens. */
import { json, problem, openStore } from '../lib/http.mjs';

const CACHE_KEY = (id) => `transcript/${id}.json`;
const BUILDING_KEY = (id) => `building/${id}.json`;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;   // matches the background function ceiling

export default async (req) => {
  const url = new URL(req.url);
  const gameId = url.searchParams.get('game') || '';
  if (!/^\d{1,20}$/.test(gameId)) return problem('game must be a broadcast id');

  const store = await openStore('transcripts');
  const cached = await store.get(CACHE_KEY(gameId), { type: 'json' });

  if (cached) {
    if (cached.cues === null) {
      return json({ gameId, status: 'unavailable', reason: 'this broadcast has no caption track' });
    }
    return json({ gameId, status: 'ready', ...cached }, 200, { 'Cache-Control': 'public, max-age=86400' });
  }

  // Don't pile up builds for the same broadcast behind a slow first request.
  const building = await store.get(BUILDING_KEY(gameId), { type: 'json' });
  const fresh = building && Date.now() - building.startedAt < BUILD_TIMEOUT_MS;
  if (!fresh) {
    await store.setJSON(BUILDING_KEY(gameId), { startedAt: Date.now() });
    // Fire and forget: the background function replies 202 immediately.
    await fetch(new URL(`/api/transcript-build?game=${gameId}`, url.origin), { method: 'POST' })
      .catch(() => {});
  }

  return json({ gameId, status: 'building', retryAfterMs: 4000 }, 202);
};

export const config = { path: '/api/transcript' };
