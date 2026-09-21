import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMarker, rolesOf, hasRole, isModerator, canPublishDirectly,
  isDuplicate, appendApproved, approvedKey, pendingKey, pendingPrefix, newMarker,
  MAX_LABEL, MAX_PLAY_SEC,
} from '../netlify/lib/markers.mjs';

const good = { gameId: '4450498', startSec: 100, endSec: 108, label: 'Touchdown, Spaulding' };

test('validateMarker accepts a well-formed marker and normalises it', () => {
  const r = validateMarker({ ...good, label: '  Touchdown,   Spaulding ', note: ' nice run ' });
  assert.ok(r.ok);
  assert.equal(r.value.label, 'Touchdown, Spaulding');
  assert.equal(r.value.note, 'nice run');
  assert.equal(r.value.gameId, '4450498');
});

test('validateMarker rejects bad time ranges', () => {
  const cases = [
    [{ ...good, endSec: 100 }, 'endSec must be after startSec'],
    [{ ...good, startSec: -5 }, 'startSec cannot be negative'],
    [{ ...good, startSec: 100, endSec: 100.5 }, /at least/],
    [{ ...good, startSec: 0, endSec: MAX_PLAY_SEC + 10 }, /cannot be longer/],
    [{ ...good, startSec: 'x' }, /must be numbers/],
  ];
  for (const [input, expected] of cases) {
    const r = validateMarker(input);
    assert.equal(r.ok, false, JSON.stringify(input));
    if (expected instanceof RegExp) assert.match(r.error, expected);
    else assert.equal(r.error, expected);
  }
});

test('validateMarker bounds against broadcast duration only when known', () => {
  assert.equal(validateMarker({ ...good, startSec: 7000, endSec: 7010 }, { durationSec: 7570 }).ok, true);
  assert.equal(validateMarker({ ...good, startSec: 7600, endSec: 7610 }, { durationSec: 7570 }).ok, false);
  assert.equal(validateMarker({ ...good, startSec: 7600, endSec: 7610 }).ok, true, 'unknown duration must not block');
});

test('validateMarker requires a sane label', () => {
  assert.equal(validateMarker({ ...good, label: '' }).ok, false);
  assert.equal(validateMarker({ ...good, label: 'x'.repeat(MAX_LABEL + 1) }).ok, false);
  assert.equal(validateMarker({ ...good, label: 'x'.repeat(MAX_LABEL) }).ok, true);
});

test('validateMarker rejects a non-numeric gameId', () => {
  assert.equal(validateMarker({ ...good, gameId: '../../etc/passwd' }).ok, false);
  assert.equal(validateMarker({ ...good, gameId: '' }).ok, false);
});

test('roles read from either shape', () => {
  assert.deepEqual(rolesOf({ roles: ['contributor'] }), ['contributor']);
  assert.deepEqual(rolesOf({ role: 'moderator' }), ['moderator']);
  assert.deepEqual(rolesOf({ roles: ['a'], role: 'a' }), ['a'], 'deduplicates');
  assert.deepEqual(rolesOf(null), []);
});

test('publishing rights follow roles, moderators included', () => {
  assert.equal(canPublishDirectly({ roles: ['contributor'] }), true);
  assert.equal(canPublishDirectly({ roles: ['moderator'] }), true, 'moderators must not be queued');
  assert.equal(canPublishDirectly({ roles: [] }), false);
  assert.equal(isModerator({ roles: ['contributor'] }), false);
  assert.equal(hasRole({ roles: ['contributor'] }, 'contributor'), true);
});

test('isDuplicate catches a re-mark of the same play, not a different one', () => {
  const existing = [{ startSec: 100, endSec: 110, label: 'Touchdown' }];
  assert.equal(isDuplicate({ startSec: 102, endSec: 111, label: 'touchdown' }, existing), true);
  assert.equal(isDuplicate({ startSec: 300, endSec: 310, label: 'Touchdown' }, existing), false);
  assert.equal(isDuplicate({ startSec: 102, endSec: 111, label: 'Fumble' }, existing), false);
});

test('keys are namespaced per game, and pending by submitting user', () => {
  assert.equal(approvedKey('4450498'), 'approved/4450498.json');
  assert.equal(pendingPrefix('u-1'), 'pending/u-1/');
  assert.equal(pendingKey('u-1', 'abc'), 'pending/u-1/abc.json');
  // The invariant that matters: a crafted id cannot introduce path separators
  // and so cannot climb out of its own prefix.
  const crafted = pendingKey('../../x', 'a/b');
  assert.ok(crafted.startsWith('pending/'), crafted);
  assert.equal(crafted.split('/').length, 3, `unexpected separators: ${crafted}`);
  assert.ok(!crafted.includes('/../'), crafted);
});

/* A fake Blobs store implementing just enough of the contract: last-write-wins
   unless onlyIfMatch/onlyIfNew is supplied, which is the behaviour the CAS
   retry in appendApproved exists to handle. */
function fakeStore() {
  const data = new Map();
  let version = 0;
  return {
    data,
    async getWithMetadata(key) {
      const row = data.get(key);
      return row ? { data: row.value, etag: row.etag } : null;
    },
    async setJSON(key, value, opts = {}) {
      const row = data.get(key);
      if (opts.onlyIfNew && row) return { modified: false };
      if (opts.onlyIfMatch && (!row || row.etag !== opts.onlyIfMatch)) return { modified: false };
      data.set(key, { value, etag: `v${++version}` });
      return { modified: true };
    },
  };
}

test('appendApproved creates the first entry for a game', async () => {
  const store = fakeStore();
  const m = newMarker(validateMarker(good).value, { id: 'u1', name: 'Jane' }, 'approved');
  const { markers, added } = await appendApproved(store, '4450498', m);
  assert.equal(added, true);
  assert.equal(markers.length, 1);
  assert.equal(store.data.get('approved/4450498.json').value.markers[0].label, 'Touchdown, Spaulding');
});

test('appendApproved keeps markers sorted by start time', async () => {
  const store = fakeStore();
  const mk = (s) => newMarker(validateMarker({ ...good, startSec: s, endSec: s + 8 }).value, { id: 'u' }, 'approved');
  await appendApproved(store, '1', mk(500));
  await appendApproved(store, '1', mk(100));
  const { markers } = await appendApproved(store, '1', mk(300));
  assert.deepEqual(markers.map((m) => m.startSec), [100, 300, 500]);
});

test('appendApproved is idempotent for the same marker id', async () => {
  const store = fakeStore();
  const m = newMarker(validateMarker(good).value, { id: 'u1' }, 'approved');
  await appendApproved(store, '1', m);
  const second = await appendApproved(store, '1', m);
  assert.equal(second.added, false, 'approving twice must not duplicate');
  assert.equal(second.markers.length, 1);
});

test('appendApproved does not lose a marker under a concurrent write', async () => {
  const store = fakeStore();
  const mk = (s, id) => ({ ...newMarker(validateMarker({ ...good, startSec: s, endSec: s + 8 }).value, { id: 'u' }, 'approved'), id });

  // Both readers see the same empty state, then both write: the CAS retry must
  // make the loser re-read and append rather than clobber the winner.
  const original = store.getWithMetadata.bind(store);
  let firstRead = true;
  store.getWithMetadata = async (k) => { if (firstRead) { firstRead = false; } return original(k); };

  await Promise.all([
    appendApproved(store, '1', mk(100, 'a')),
    appendApproved(store, '1', mk(200, 'b')),
  ]);
  const saved = store.data.get('approved/1.json').value.markers;
  assert.equal(saved.length, 2, 'a concurrent write was lost');
  assert.deepEqual(saved.map((m) => m.id).sort(), ['a', 'b']);
});

test('appendApproved gives up rather than spinning forever', async () => {
  const store = fakeStore();
  store.setJSON = async () => ({ modified: false });   // every CAS loses
  const m = newMarker(validateMarker(good).value, { id: 'u1' }, 'approved');
  await assert.rejects(() => appendApproved(store, '1', m, { attempts: 3 }), /write conflicts/);
});
