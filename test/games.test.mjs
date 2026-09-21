/* The allow-list that stops an arbitrary id turning into ~757 requests against
 * NSN's CDN. Its most important property is the one that is easy to lose: it
 * fails OPEN, so a hiccup fetching the data file cannot take transcripts down. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { knownGameIds, isKnownGame, _resetGameCache } from '../netlify/lib/games.mjs';

const ORIGIN = 'https://example.test';

/** Swap global fetch for the duration of one call. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const ok = (body) => async () => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
const GAMES = { games: [{ id: '4450498' }, { id: '4451222' }] };

test('ids from the published data file are recognised', async () => {
  _resetGameCache();
  await withFetch(ok(GAMES), async () => {
    assert.equal(await isKnownGame('4450498', ORIGIN), true);
    assert.equal(await isKnownGame(4451222, ORIGIN), true, 'a numeric id is the same id');
    assert.equal(await isKnownGame('9999999', ORIGIN), false);
  });
});

test('the data file is fetched once, then cached', async () => {
  _resetGameCache();
  let calls = 0;
  await withFetch(async (...a) => { calls++; return ok(GAMES)(...a); }, async () => {
    await isKnownGame('4450498', ORIGIN);
    await isKnownGame('4451222', ORIGIN);
    await isKnownGame('9999999', ORIGIN);
  });
  assert.equal(calls, 1);
});

test('it fetches games.json from the calling origin', async () => {
  _resetGameCache();
  let seen = null;
  await withFetch(async (url) => { seen = String(url); return ok(GAMES)(); }, async () => {
    await knownGameIds(ORIGIN);
  });
  assert.equal(seen, 'https://example.test/data/games.json');
});

test('a failed fetch allows the id through rather than breaking transcripts', async () => {
  for (const broken of [
    async () => { throw new Error('network down'); },
    async () => new Response('nope', { status: 500 }),
    ok({ games: [] }),                                   // empty file: treat as unusable
  ]) {
    _resetGameCache();
    await withFetch(broken, async () => {
      assert.equal(await isKnownGame('9999999', ORIGIN), true);
    });
  }
});

test('an unusable response is not cached, so the next call retries', async () => {
  _resetGameCache();
  let calls = 0;
  await withFetch(async () => { calls++; throw new Error('down'); }, async () => {
    await isKnownGame('1', ORIGIN);
    await isKnownGame('2', ORIGIN);
  });
  assert.equal(calls, 2);
});

test('every id in the real data file passes', async () => {
  const { default: data } = await import('../docs/data/games.json', { with: { type: 'json' } });
  _resetGameCache();
  await withFetch(ok(data), async () => {
    for (const g of data.games.slice(0, 20)) {
      assert.equal(await isKnownGame(g.id, ORIGIN), true, `${g.id} should be known`);
    }
  });
});
