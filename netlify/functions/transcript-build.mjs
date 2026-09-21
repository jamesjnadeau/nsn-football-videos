/* Background: assemble one broadcast's transcript and cache it.
 *
 * Background because a transcript is ~757 caption-segment fetches; a normal
 * function's 26s ceiling cannot hold that for a three-hour broadcast. */
import { buildTranscript } from '../lib/transcript.mjs';
import { openStore } from '../lib/http.mjs';

const CACHE_KEY = (id) => `transcript/${id}.json`;
const BUILDING_KEY = (id) => `building/${id}.json`;

export default async (req) => {
  const gameId = new URL(req.url).searchParams.get('game') || '';
  if (!/^\d{1,20}$/.test(gameId)) return;

  const store = await openStore('transcripts');
  try {
    const { cues, durationSec, segmentCount } = await buildTranscript(gameId);
    await store.setJSON(CACHE_KEY(gameId), {
      cues,
      durationSec,
      segmentCount,
      builtAt: new Date().toISOString(),
    });
  } catch (err) {
    // Leave no build marker behind, so the next visitor retries rather than
    // waiting out the full timeout on a transient CDN failure.
    console.error(`transcript build failed for ${gameId}:`, err);
  } finally {
    await store.delete(BUILDING_KEY(gameId)).catch(() => {});
  }
};

export const config = { path: '/api/transcript-build', method: 'POST', background: true };
