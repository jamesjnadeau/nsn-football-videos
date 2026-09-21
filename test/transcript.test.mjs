import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVmap, hmsToSeconds, findSubtitlePlaylist, playlistSegments,
  vttTimeToSeconds, parseVtt, mergeCues, isFiller, mapLimit, buildTranscript,
} from '../netlify/lib/transcript.mjs';

test('hmsToSeconds handles the VMAP duration format', () => {
  assert.equal(hmsToSeconds('02:06:10.000'), 7570);
  assert.equal(hmsToSeconds('00:00:30.500'), 31);   // rounds
  assert.equal(hmsToSeconds('nonsense'), null);
});

test('parseVmap pulls the stream URL and duration', () => {
  const xml = `<VMAP><Content geoblocked="false" duration="02:06:10.000" type="archive">`
    + `<![CDATA[https://example.com/a.m3u8?x=1]]></Content></VMAP>`;
  assert.deepEqual(parseVmap(xml), { url: 'https://example.com/a.m3u8?x=1', durationSec: 7570 });
  assert.deepEqual(parseVmap('<VMAP></VMAP>'), { url: null, durationSec: null });
});

test('findSubtitlePlaylist picks the subtitles track only', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360',
    '360p/index.m3u8',
    '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,NAME="English",URI="sub.en.webvtt/index.m3u8"',
  ].join('\n');
  assert.equal(
    findSubtitlePlaylist(master, 'https://cdn.example.com/x/master.m3u8'),
    'https://cdn.example.com/x/sub.en.webvtt/index.m3u8'
  );
  assert.equal(findSubtitlePlaylist('#EXTM3U\n360p/index.m3u8', 'https://e.com/m.m3u8'), null);
});

test('playlistSegments resolves relative URIs in order', () => {
  const pl = '#EXTM3U\n#EXTINF:10.0,\na.vtt\n#EXTINF:10.0,\nb.vtt\n#EXT-X-ENDLIST';
  assert.deepEqual(playlistSegments(pl, 'https://e.com/s/index.m3u8'),
    ['https://e.com/s/a.vtt', 'https://e.com/s/b.vtt']);
});

test('vttTimeToSeconds parses both hh:mm:ss and mm:ss', () => {
  assert.equal(vttTimeToSeconds('00:19:54.520'), 1194.52);
  assert.equal(vttTimeToSeconds('19:54.520'), 1194.52);
  assert.equal(vttTimeToSeconds('bad'), null);
});

test('parseVtt extracts cues and strips styling tags', () => {
  const vtt = 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n\n'
    + '00:19:54.520 --> 00:19:57.320\nThey\'re going to call <b>off sides</b>\nagainst Spalding.\n';
  assert.deepEqual(parseVtt(vtt), [
    { start: 1194.52, end: 1197.32, text: "They're going to call off sides against Spalding." },
  ]);
});

test('parseVtt drops filler but keeps short real speech', () => {
  const mk = (t) => `WEBVTT\n\n00:00:10.400 --> 00:00:10.440\n${t}\n`;
  assert.equal(parseVtt(mk('Uh?')).length, 0);
  assert.equal(parseVtt(mk('tide.')).length, 1, 'short real words must survive');
});

test('isFiller targets filler words, not short words', () => {
  for (const t of ['Uh?', 'uh', 'Um.', 'Ahh', 'mmm', 'Hmm', 'er']) assert.ok(isFiller(t), t);
  for (const t of ['tide.', 'Myers.', 'S.', 'Uh oh', 'Touchdown!']) assert.ok(!isFiller(t), t);
});

test('mergeCues drops same-instant repeats but keeps later recurrences', () => {
  const cues = [
    { start: 10, end: 12, text: 'first down' },
    { start: 10.2, end: 12, text: 'first down' },   // rolling caption repeat
    { start: 900, end: 902, text: 'first down' },   // genuinely happens again
  ];
  const merged = mergeCues(cues);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((c) => c.start), [10, 900]);
});

test('mapLimit preserves order while bounding concurrency', async () => {
  let inFlight = 0, peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async (n) => {
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3, `concurrency exceeded limit: ${peak}`);
});

test('buildTranscript returns null cues when there is no caption track', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('vmap')) return '<VMAP><Content duration="01:00:00.000"><![CDATA[https://e.com/m.m3u8]]></Content></VMAP>';
    return '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n360p/index.m3u8';   // no subtitles
  };
  const r = await buildTranscript('123', { fetchImpl: fakeFetch });
  assert.equal(r.cues, null);
  assert.equal(r.durationSec, 3600);
});

test('buildTranscript survives a failing segment', async () => {
  const fakeFetch = async (url) => {
    if (url.includes('vmap')) return '<VMAP><Content duration="00:01:00.000"><![CDATA[https://e.com/m.m3u8]]></Content></VMAP>';
    if (url.endsWith('m.m3u8')) return '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="s/index.m3u8"';
    if (url.endsWith('s/index.m3u8')) return '#EXTINF:10.0,\na.vtt\n#EXTINF:10.0,\nb.vtt';
    if (url.endsWith('a.vtt')) throw new Error('boom');
    return 'WEBVTT\n\n00:00:20.000 --> 00:00:22.000\nsecond segment\n';
  };
  const r = await buildTranscript('123', { fetchImpl: fakeFetch });
  assert.deepEqual(r.cues, [{ start: 20, end: 22, text: 'second segment' }]);
});
