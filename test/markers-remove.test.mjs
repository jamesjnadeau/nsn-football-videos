/* Taking a play down: who may, and that a concurrent add is not clobbered. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canRemove, removeApproved, appendApproved, approvedKey } from '../netlify/lib/markers.mjs';

const mk = (id, by, startSec = 10) => ({
  id, createdBy: by, startSec, endSec: startSec + 10, label: `play ${id}`, status: 'approved',
});

/** Minimal stand-in for a Blobs store, with real etag semantics. */
function fakeStore(initial = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, { value: v, etag: 'e0' }]));
  let n = 0;
  return {
    calls: 0,
    onBeforeWrite: null,
    async get(key) { return data.get(key)?.value ?? null; },
    async getWithMetadata(key) {
      const row = data.get(key);
      return row ? { data: row.value, etag: row.etag } : null;
    },
    async setJSON(key, value, opts = {}) {
      this.calls++;
      if (this.onBeforeWrite) { const f = this.onBeforeWrite; this.onBeforeWrite = null; await f(); }
      const row = data.get(key);
      if (opts.onlyIfMatch && row?.etag !== opts.onlyIfMatch) return { modified: false };
      if (opts.onlyIfNew && row) return { modified: false };
      data.set(key, { value, etag: `e${++n}` });
      return { modified: true };
    },
  };
}

test('an author may remove their own play; a stranger may not', () => {
  const m = mk('m1', 'u-author');
  assert.equal(canRemove({ id: 'u-author', roles: [] }, m), true);
  assert.equal(canRemove({ id: 'u-other', roles: [] }, m), false);
  assert.equal(canRemove({ id: 'u-other', roles: ['contributor'] }, m), false,
    'publishing rights are not removal rights over other people\'s plays');
  assert.equal(canRemove({ id: 'u-other', roles: ['moderator'] }, m), true);
  assert.equal(canRemove(null, m), false);
  assert.equal(canRemove({ id: 'u-author' }, null), false);
});

test('removing takes out exactly the one marker', async () => {
  const store = fakeStore({
    [approvedKey('99')]: { markers: [mk('m1', 'u1', 10), mk('m2', 'u2', 30), mk('m3', 'u1', 50)] },
  });
  const out = await removeApproved(store, '99', 'm2');
  assert.equal(out.removed, true);
  assert.equal(out.marker.id, 'm2');
  assert.deepEqual(out.markers.map((m) => m.id), ['m1', 'm3']);
});

test('removing one that has already gone is not an error', async () => {
  const store = fakeStore({ [approvedKey('99')]: { markers: [mk('m1', 'u1')] } });
  assert.equal((await removeApproved(store, '99', 'nope')).removed, false);
  assert.equal((await removeApproved(store, 'no-such-game', 'm1')).removed, false);
});

test('a marker added mid-remove survives the compare-and-swap', async () => {
  const store = fakeStore({
    [approvedKey('99')]: { markers: [mk('m1', 'u1', 10), mk('m2', 'u1', 30)] },
  });
  // Someone else appends between our read and our write; the first write loses
  // its etag race and the retry must see -- and keep -- their marker.
  store.onBeforeWrite = async () => {
    await appendApproved(store, '99', mk('m9', 'u3', 70));
  };

  const out = await removeApproved(store, '99', 'm1');
  assert.equal(out.removed, true);
  assert.deepEqual(out.markers.map((m) => m.id), ['m2', 'm9'],
    'the concurrent addition must not be lost');
});
