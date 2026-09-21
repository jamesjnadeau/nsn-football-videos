/* Resolving a broadcast to something hls.js can play.
 *
 * The property that matters: every URI in the returned manifest must be
 * absolute. The client loads it as a blob: URL, and a blob URL is useless as a
 * base to resolve a relative URI against -- so a relative one that slipped
 * through would fail at playback, not here. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVariants, absolutiseMaster, resolveStream } from '../netlify/lib/stream.mjs';

const BASE = 'https://vcloud.hudl.com/file/broadcast/4450498.m3u8?tmu=abc';

const MASTER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1226732,RESOLUTION=640x360,SUBTITLES="subs"
https://di2g5yar1p6ph.cloudfront.net/sn-x/360p-hi.hls/index.m3u8
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2248816,RESOLUTION=1280x720,SUBTITLES="subs"
https://di2g5yar1p6ph.cloudfront.net/sn-x/720p-2.0.hls/index.m3u8
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="https://di2g5yar1p6ph.cloudfront.net/sn-x/sub.en.webvtt/index.m3u8"
`;

test('variants come back best first', () => {
  const v = parseVariants(MASTER, BASE);
  assert.equal(v.length, 2);
  assert.equal(v[0].resolution, '1280x720');
  assert.equal(v[0].bandwidth, 2248816);
  assert.equal(v[1].resolution, '640x360');
});

test('a relative variant is resolved against the manifest that named it', () => {
  const relative = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100
720p/index.m3u8
`;
  const [v] = parseVariants(relative, 'https://cdn.test/a/b/master.m3u8');
  assert.equal(v.url, 'https://cdn.test/a/b/720p/index.m3u8');
});

test('every URI in the rewritten master is absolute', () => {
  const out = absolutiseMaster(`#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=100
360p/index.m3u8
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="subs/index.m3u8"
`, 'https://cdn.test/a/master.m3u8');

  for (const line of out.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '#EXTM3U') continue;
    const uri = trimmed.startsWith('#') ? /URI="([^"]+)"/.exec(trimmed)?.[1] : trimmed;
    if (uri) assert.match(uri, /^https:\/\//, `not absolute: ${line}`);
  }
});

test('tag lines keep their attributes', () => {
  const out = absolutiseMaster(MASTER, BASE);
  assert.match(out, /BANDWIDTH=2248816/);
  assert.match(out, /TYPE=SUBTITLES/);
  assert.match(out, /NAME="English"/);
  assert.equal(out.split('\n').filter((l) => l.startsWith('#EXT-X-STREAM-INF')).length, 2);
});

test('resolveStream walks VMAP then master', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.includes('/vmap/')) {
      return `<vmap><Content duration="02:06:10.000"><![CDATA[${BASE}]]></Content></vmap>`;
    }
    return MASTER;
  };
  const out = await resolveStream('4450498', { fetchImpl });
  assert.equal(out.durationSec, 7570);
  assert.equal(out.variants.length, 2);
  assert.match(out.master, /^#EXTM3U/);
  assert.equal(seen.length, 2);
  assert.match(seen[0], /\/vmap\/4450498/);
  assert.equal(seen[1], BASE);
});

test('a broadcast with no stream fails loudly rather than returning junk', async () => {
  await assert.rejects(
    () => resolveStream('1', { fetchImpl: async () => '<vmap></vmap>' }),
    /no content stream/,
  );
  await assert.rejects(
    () => resolveStream('1', {
      fetchImpl: async (u) => (u.includes('/vmap/')
        ? `<vmap><Content><![CDATA[${BASE}]]></Content></vmap>`
        : '#EXTM3U\n'),
    }),
    /no variants/,
  );
});
