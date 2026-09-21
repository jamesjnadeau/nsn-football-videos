/* Assembling a broadcast transcript from NSN's stream.
 *
 * NSN's broadcasts carry auto-generated English captions, but reaching them is a
 * four-step walk and none of it is possible from the browser: the VMAP and the
 * master manifest send no CORS headers, so this has to run server-side.
 *
 *   ajax VMAP  ->  master .m3u8  ->  subtitle .m3u8  ->  ~757 .vtt segments
 *
 * The captions are speech recognition, so proper nouns come through mangled
 * ("Missiskoy" for Missisquoi). They are good for locating a moment in a long
 * broadcast, not for reading facts out of.
 */

const VMAP_URL = (id) => `https://vcloud.hudl.com/api/broadcast/vmap/${encodeURIComponent(id)}?minify_js=1`;
const USER_AGENT = 'nsn-football-videos/1.0 (+https://github.com/jamesjnadeau/nsn-football-videos)';

/** Resolve a possibly-relative URI against the playlist that referenced it. */
export function resolveUri(uri, baseUrl) {
  return new URL(uri, baseUrl).toString();
}

/** Pull the content stream URL and duration out of a VMAP document. */
export function parseVmap(xml) {
  const content = /<Content([^>]*)>\s*<!\[CDATA\[(.*?)\]\]>/s.exec(xml);
  if (!content) return { url: null, durationSec: null };
  const dur = /duration="([^"]+)"/.exec(content[1]);
  return { url: content[2].trim(), durationSec: dur ? hmsToSeconds(dur[1]) : null };
}

/** "02:06:10.000" -> 7570 */
export function hmsToSeconds(hms) {
  const parts = String(hms).split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
  return Math.round(h * 3600 + m * 60 + s);
}

/** Find the subtitle playlist in an HLS master manifest, if one is advertised. */
export function findSubtitlePlaylist(master, baseUrl) {
  for (const line of master.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES/.test(line)) continue;
    const uri = /URI="([^"]+)"/.exec(line);
    if (uri) return resolveUri(uri[1], baseUrl);
  }
  return null;
}

/** Segment URIs from a media playlist, in order. */
export function playlistSegments(playlist, baseUrl) {
  return playlist
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => resolveUri(l, baseUrl));
}

/** "00:19:54.520" -> 1194.52 */
export function vttTimeToSeconds(t) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(t.trim());
  if (!m) return null;
  const [, h, mm, ss, ms] = m;
  return Number(h || 0) * 3600 + Number(mm) * 60 + Number(ss) + Number((ms || '0').padEnd(3, '0')) / 1000;
}

/** Parse one WebVTT segment into cues. Segments carry absolute stream times. */
export function parseVtt(text) {
  const cues = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx === -1) continue;
    const [rawStart, rawEnd] = lines[idx].split('-->');
    const start = vttTimeToSeconds(rawStart);
    const end = vttTimeToSeconds((rawEnd || '').split(/\s+/).filter(Boolean)[0] || '');
    if (start === null || end === null) continue;
    const body = lines
      .slice(idx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')       // caption styling tags
      .replace(/\s+/g, ' ')
      .trim();
    if (body && !isFiller(body)) cues.push({ start: round2(start), end: round2(end), text: body });
  }
  return cues;
}

function round2(n) { return Math.round(n * 100) / 100; }

/* Live captioning emits a lot of standalone filler, mostly "Uh?" on crowd noise
 * (52 of them in one sampled broadcast). Matched on the whole cue text so real
 * fragments like "tide." or "Myers." survive -- those are short but meaningful,
 * which is why this is not a minimum-duration filter. */
const FILLER = /^(?:u+h+|u+m+|a+h+|m+h*m+|h+m+|e+r+)[.?!,\s]*$/i;

export function isFiller(text) { return FILLER.test(text.trim()); }

/** Drop the repeats that rolling live captions produce, and sort by time. */
export function mergeCues(cues) {
  const seen = new Set();
  const out = [];
  for (const c of cues.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const key = `${c.start}|${c.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const prev = out[out.length - 1];
    // A cue repeated at the same instant with the same words is duplication;
    // the same words later in the game is not.
    if (prev && prev.text === c.text && Math.abs(prev.start - c.start) < 0.5) continue;
    out.push(c);
  }
  return out;
}

async function fetchText(url, { retries = 2, timeoutMs = 20000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    }
  }
}

/** Run jobs with bounded concurrency, preserving input order in the result. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

/**
 * Build the transcript for a broadcast.
 * Resolves to { cues, durationSec, segmentCount } or { cues: null } when the
 * broadcast has no caption track (true of some pre-2022 games).
 */
export async function buildTranscript(broadcastId, { concurrency = 12, fetchImpl = fetchText } = {}) {
  const vmapUrl = VMAP_URL(broadcastId);
  const { url: contentUrl, durationSec } = parseVmap(await fetchImpl(vmapUrl));
  if (!contentUrl) throw new Error('no content stream in VMAP');

  const master = await fetchImpl(contentUrl);
  const subUrl = findSubtitlePlaylist(master, contentUrl);
  if (!subUrl) return { cues: null, durationSec, segmentCount: 0 };

  const segments = playlistSegments(await fetchImpl(subUrl), subUrl);
  const texts = await mapLimit(segments, concurrency, async (u) => {
    try { return await fetchImpl(u); } catch { return ''; }   // one bad segment must not sink the job
  });

  const cues = mergeCues(texts.flatMap((t) => (t ? parseVtt(t) : [])));
  return { cues, durationSec, segmentCount: segments.length };
}
