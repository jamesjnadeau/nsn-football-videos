/* The set of broadcasts this site actually indexes.
 *
 * Assembling one transcript costs ~757 requests to NSN's CDN. /api/transcript
 * and the background build behind it are both public and unauthenticated -- they
 * have to be, since anonymous visitors read transcripts -- so without this an
 * arbitrary id could be fed in on a loop and turned into real load on NSN. That
 * is the one thing this project has gone out of its way not to do.
 *
 * The ids come from the published data file rather than a list kept here, so
 * they cannot drift from what the pages link to. It is refreshed weekly, hence
 * the short TTL: a brand-new broadcast must not be rejected for long.
 */

const TTL_MS = 10 * 60 * 1000;
let cache = null;          // { ids: Set, at: number }

export async function knownGameIds(origin) {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.ids;

  const res = await fetch(new URL('/data/games.json', origin));
  if (!res.ok) throw new Error(`games.json: HTTP ${res.status}`);
  const data = await res.json();
  const ids = new Set((data?.games ?? []).map((g) => String(g.id)));
  if (!ids.size) throw new Error('games.json listed no broadcasts');

  cache = { ids, at: Date.now() };
  return ids;
}

/**
 * True if this id is one of ours.
 *
 * Fails open. This is a brake on abuse, not a security boundary, and a hiccup
 * fetching the data file must not take transcripts down for everyone.
 */
export async function isKnownGame(gameId, origin) {
  try {
    return (await knownGameIds(origin)).has(String(gameId));
  } catch (err) {
    console.warn('could not check the broadcast id, allowing it:', err.message);
    return true;
  }
}

/** Tests only. */
export function _resetGameCache() { cache = null; }
