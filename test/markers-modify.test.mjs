/* Changing a published play -- editing it or taking it down: who may, and that
   a concurrent write is not clobbered. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canModify, removeApproved, updateApproved, appendApproved, approvedKey,
} from '../netlify/lib/markers.mjs';

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

test('an author may change their own play; a stranger may not', () => {
  const m = mk('m1', 'u-author');
  assert.equal(canModify({ id: 'u-author', roles: [] }, m), true);
  assert.equal(canModify({ id: 'u-other', roles: [] }, m), false);
  assert.equal(canModify({ id: 'u-other', roles: ['contributor'] }, m), false,
    'publishing rights are not rights over other people\'s plays');
  assert.equal(canModify({ id: 'u-other', roles: ['moderator'] }, m), true);
  assert.equal(canModify(null, m), false);
  assert.equal(canModify({ id: 'u-author' }, null), false);
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

test('editing changes the fields asked for and nothing else', async () => {
  const store = fakeStore({
    [approvedKey('99')]: { markers: [mk('m1', 'u1', 10), mk('m2', 'u2', 30)] },
  });
  const out = await updateApproved(store, '99', 'm1', {
    startSec: 12, endSec: 25, label: 'Touchdown', note: 'second effort', editedByName: 'Mod',
  });
  assert.equal(out.updated, true);
  assert.equal(out.marker.label, 'Touchdown');
  assert.equal(out.marker.startSec, 12);
  assert.equal(out.marker.note, 'second effort');
  assert.equal(out.marker.editedByName, 'Mod');
});

test('identity and provenance survive an edit, whatever the caller sends', async () => {
  const store = fakeStore({ [approvedKey('99')]: { markers: [mk('m1', 'u1', 10)] } });
  const out = await updateApproved(store, '99', 'm1', {
    id: 'not-yours', createdBy: 'u-impostor', createdByName: 'Impostor',
    createdAt: '1999-01-01T00:00:00.000Z', status: 'pending', label: 'fine',
  });
  assert.equal(out.marker.id, 'm1');
  assert.equal(out.marker.createdBy, 'u1', 'an edit must not reassign authorship');
  assert.equal(out.marker.status, 'approved', 'an edit must not smuggle a status change');
  assert.equal(out.marker.label, 'fine');
});

test('editing a start time re-sorts the list', async () => {
  const store = fakeStore({
    [approvedKey('99')]: { markers: [mk('m1', 'u1', 10), mk('m2', 'u1', 30), mk('m3', 'u1', 50)] },
  });
  const out = await updateApproved(store, '99', 'm1', { startSec: 90, endSec: 100 });
  assert.deepEqual(out.markers.map((m) => m.id), ['m2', 'm3', 'm1']);
});

test('editing one that has gone is not an error', async () => {
  const store = fakeStore({ [approvedKey('99')]: { markers: [mk('m1', 'u1')] } });
  assert.equal((await updateApproved(store, '99', 'nope', { label: 'x' })).updated, false);
  assert.equal((await updateApproved(store, 'no-such-game', 'm1', { label: 'x' })).updated, false);
});

test('a marker added mid-edit survives the compare-and-swap', async () => {
  const store = fakeStore({
    [approvedKey('99')]: { markers: [mk('m1', 'u1', 10), mk('m2', 'u1', 30)] },
  });
  store.onBeforeWrite = async () => { await appendApproved(store, '99', mk('m9', 'u3', 70)); };

  const out = await updateApproved(store, '99', 'm1', { label: 'edited' });
  assert.equal(out.updated, true);
  assert.deepEqual(out.markers.map((m) => m.id), ['m1', 'm2', 'm9']);
  assert.equal(out.markers.find((m) => m.id === 'm1').label, 'edited');
});
