/* Resolving a broadcast's HLS stream so signed-in markers can play it in our
 * own player, where currentTime is readable and a play can be marked to the
 * second. Anonymous visitors keep NSN's embed, ads and all.
 *
 * This has to run server-side. The VMAP and the master manifest on
 * vcloud.hudl.com send no CORS headers; only the CloudFront variant playlists
 * and segments do (Access-Control-Allow-Origin: *), so the browser can play the
 * variants once something else has found them.
 *
 * We return the master manifest's text rather than a single variant URL. The
 * client hands it to hls.js as a blob, which keeps adaptive bitrate switching
 * and the embedded caption track working. Every URI is absolute first, because
 * a blob: URL is no use as a base to resolve relative ones against.
 */
import { parseVmap, resolveUri } from './transcript.mjs';

const VMAP_URL = (id) => `https://vcloud.hudl.com/api/broadcast/vmap/${encodeURIComponent(id)}?minify_js=1`;
const USER_AGENT = 'nsn-football-videos/1.0 (+https://github.com/jamesjnadeau/nsn-football-videos)';

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** The variants an HLS master advertises, best first. */
export function parseVariants(master, baseUrl) {
  const lines = master.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const uri = (lines[i + 1] || '').trim();
    if (!uri || uri.startsWith('#')) continue;
    const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(lines[i])?.[1] ?? 0);
    const resolution = /RESOLUTION=([\dx]+)/.exec(lines[i])?.[1] ?? null;
    out.push({ url: resolveUri(uri, baseUrl), bandwidth, resolution });
  }
  return out.sort((a, b) => b.bandwidth - a.bandwidth);
}

/**
 * Rewrite every URI in a master manifest to an absolute one.
 * Playlist URIs sit on their own line; media tracks carry theirs in URI="...".
 */
export function absolutiseMaster(master, baseUrl) {
  return master
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${resolveUri(u, baseUrl)}"`);
      }
      return resolveUri(trimmed, baseUrl);
    })
    .join('\n');
}

/**
 * Walk VMAP -> master manifest for one broadcast.
 * Returns { master, variants, durationSec } or throws.
 */
export async function resolveStream(broadcastId, { fetchImpl = fetchText } = {}) {
  const { url: contentUrl, durationSec } = parseVmap(await fetchImpl(VMAP_URL(broadcastId)));
  if (!contentUrl) throw new Error('no content stream in VMAP');

  const master = await fetchImpl(contentUrl);
  const variants = parseVariants(master, contentUrl);
  if (!variants.length) throw new Error('master manifest advertises no variants');

  return { master: absolutiseMaster(master, contentUrl), variants, durationSec };
}
