/* POST /api/review -- approve or reject a pending marker.
 * Body: { markerId, submittedBy, action: "approve" | "reject" } */
import { getUser } from '@netlify/identity';
import { isModerator, appendApproved, pendingKey } from '../lib/markers.mjs';
import { json, problem, readJson, openStore } from '../lib/http.mjs';

export default async (req) => {
  if (req.method !== 'POST') return problem('use POST', 405);

  const user = await getUser();
  if (!user) return problem('sign in', 401);
  if (!isModerator(user)) return problem('moderators only', 403);

  const body = await readJson(req);
  if (!body.ok) return problem(body.error);

  const { markerId, submittedBy, action } = body.value;
  if (!markerId || !submittedBy) return problem('markerId and submittedBy are required');
  if (action !== 'approve' && action !== 'reject') return problem('action must be approve or reject');

  const store = await openStore('markers');
  const key = pendingKey(submittedBy, markerId);
  const marker = await store.get(key, { type: 'json' });
  // Already handled by another moderator: report success rather than an error,
  // so a double-click does not look like a failure.
  if (!marker) return json({ status: 'already-handled', markerId });

  if (action === 'approve') {
    const approved = {
      ...marker,
      status: 'approved',
      reviewedBy: user.id,
      reviewedAt: new Date().toISOString(),
    };
    // Append first: if the delete then fails, the marker is published and the
    // stale pending entry is a no-op on the next review. The reverse order
    // could lose it entirely.
    await appendApproved(store, marker.gameId, approved);
    await store.delete(key);
    return json({ status: 'approved', marker: approved });
  }

  await store.delete(key);
  return json({ status: 'rejected', markerId });
};

export const config = { path: '/api/review', method: 'POST' };
