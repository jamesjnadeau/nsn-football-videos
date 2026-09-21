/* GET /api/review/queue -- pending submissions awaiting a moderator. */
import { getUser } from '@netlify/identity';
import { isModerator } from '../lib/markers.mjs';
import { json, problem, openStore } from '../lib/http.mjs';

export default async (req) => {
  const user = await getUser();
  if (!user) return problem('sign in', 401);
  if (!isModerator(user)) return problem('moderators only', 403);

  const store = await openStore('markers');
  const { blobs } = await store.list({ prefix: 'pending/' });

  const markers = (
    await Promise.all(blobs.map((b) => store.get(b.key, { type: 'json' }).catch(() => null)))
  ).filter(Boolean);

  markers.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return json({ count: markers.length, markers });
};

export const config = { path: '/api/review/queue' };
