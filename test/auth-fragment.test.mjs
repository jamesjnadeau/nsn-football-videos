/* Identity sends invites, resets and confirmations as a URL fragment. Parsing
 * it wrong is what made activation links silently render the timeline, so the
 * parser is pinned here.
 *
 * docs/assets/auth.js is a plain IIFE that only touches window/location/history
 * at load, so it evaluates in a bare sandbox. Keeping that true is half the
 * point of this test: nothing in it may need a real DOM to load. */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../docs/assets/auth.js', import.meta.url), 'utf8');

/** Objects built inside the sandbox carry its realm's prototype, which strict
 *  deep-equality rejects; copy them back into this one before comparing. */
const plain = (o) => (o == null ? o : { ...o });

/** Load auth.js over a fake location and return { NSNAuth, location }. */
function loadAuth(hash = '') {
  const location = { hash, pathname: '/', search: '' };
  const replaced = [];
  const window = {
    location,
    history: {
      replaceState(_state, _title, url) { replaced.push(url); location.hash = ''; },
    },
  };
  const sandbox = { window, console, URLSearchParams };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'auth.js' });
  return { auth: window.NSNAuth, location, replaced };
}

test('auth.js loads without a DOM and exposes the parser', () => {
  const { auth } = loadAuth();
  assert.equal(typeof auth._parseFragment, 'function');
  assert.equal(auth.pending(), null);
});

test('each token kind is recognised', () => {
  const { auth } = loadAuth();
  const cases = [
    ['#invite_token=abc123', 'invite'],
    ['#recovery_token=abc123', 'recovery'],
    ['#confirmation_token=abc123', 'confirmation'],
    ['#email_change_token=abc123', 'email_change'],
  ];
  for (const [hash, kind] of cases) {
    assert.deepEqual(plain(auth._parseFragment(hash)), { kind, token: 'abc123' }, hash);
  }
});

test('ordinary routes are not mistaken for auth fragments', () => {
  const { auth } = loadAuth();
  for (const hash of ['', '#', '#/timeline', '#/schools', '#/game/12345', '#/school/bfa-fairfax', '#/account', '#/review']) {
    assert.equal(auth._parseFragment(hash), null, hash);
  }
});

test('an error fragment carries the description Identity sent', () => {
  const { auth } = loadAuth();
  assert.deepEqual(
    plain(auth._parseFragment('#error=access_denied&error_description=Invite+expired')),
    { kind: 'error', message: 'Invite expired' },
  );
  // Bare errors still produce something a person can read.
  assert.deepEqual(
    plain(auth._parseFragment('#error=access_denied')),
    { kind: 'error', message: 'access denied' },
  );
});

test('the token is captured at load and stripped from the URL', () => {
  const { auth, location, replaced } = loadAuth('#invite_token=tok-abc');
  assert.deepEqual(plain(auth.pending()), { kind: 'invite', token: 'tok-abc' });
  assert.deepEqual(replaced, ['/']);
  assert.equal(location.hash, '', 'the token must not stay in the address bar');
  auth.clearPending();
  assert.equal(auth.pending(), null);
});

test('a normal route is left in the URL untouched', () => {
  const { auth, location, replaced } = loadAuth('#/game/12345');
  assert.equal(auth.pending(), null);
  assert.deepEqual(replaced, []);
  assert.equal(location.hash, '#/game/12345');
});
