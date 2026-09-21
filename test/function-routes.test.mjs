/* Netlify resolves a request by path. Two functions declaring the same path is
 * not an error at deploy time -- one of them simply wins, and the other becomes
 * dead code. That is how POST /api/markers ended up being answered by the read
 * handler, which looked for a ?game= query string it was never sent and refused
 * every save with "game must be a broadcast id".
 *
 * A `method` narrows a function, but it does not break the tie: the handler
 * without one matches every method and takes the path with it. So the rule
 * enforced here is the strict one -- a path belongs to exactly one function. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

const DIR = new URL('../netlify/functions/', import.meta.url);

const routes = await Promise.all(
  readdirSync(DIR).filter((f) => f.endsWith('.mjs')).sort().map(async (file) => {
    const mod = await import(new URL(file, DIR));
    return { file, config: mod.config, handler: mod.default };
  }),
);

test('there are functions to check', () => {
  assert.ok(routes.length >= 6, `found only ${routes.length} functions`);
});

test('every function exports a handler and a path under /api/', () => {
  for (const { file, config, handler } of routes) {
    assert.equal(typeof handler, 'function', `${file} exports no default handler`);
    assert.ok(config && typeof config.path === 'string', `${file} declares no config.path`);
    assert.match(config.path, /^\/api\/[a-z0-9/-]+$/, `${file} has an odd path: ${config.path}`);
  }
});

test('no two functions claim the same path', () => {
  const byPath = new Map();
  for (const { file, config } of routes) {
    const seen = byPath.get(config.path);
    assert.equal(
      seen, undefined,
      `${file} and ${seen} both claim ${config.path}; one of them will never run. ` +
      'Give them separate paths, or merge them and branch on req.method.',
    );
    byPath.set(config.path, file);
  }
});
