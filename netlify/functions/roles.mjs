/* Manage who may publish without review.
 *   GET  /api/review/users            -- list Identity users and their roles
 *   POST /api/review/users            -- { userId, role, grant: true|false }
 * Moderators only. */
import { getUser, admin } from '@netlify/identity';
import { isModerator, rolesOf, ROLE_CONTRIBUTOR, ROLE_MODERATOR } from '../lib/markers.mjs';
import { json, problem, readJson } from '../lib/http.mjs';

const GRANTABLE = new Set([ROLE_CONTRIBUTOR, ROLE_MODERATOR]);

export default async (req) => {
  const user = await getUser();
  if (!user) return problem('sign in', 401);
  if (!isModerator(user)) return problem('moderators only', 403);

  if (req.method === 'GET') {
    const users = await admin.listUsers();
    return json({
      users: users.map((u) => ({ id: u.id, email: u.email, name: u.name, roles: rolesOf(u) })),
    });
  }

  if (req.method !== 'POST') return problem('use GET or POST', 405);

  const body = await readJson(req);
  if (!body.ok) return problem(body.error);

  const { userId, role, grant } = body.value;
  if (!userId) return problem('userId is required');
  if (!GRANTABLE.has(role)) return problem(`role must be one of: ${[...GRANTABLE].join(', ')}`);
  if (userId === user.id && role === ROLE_MODERATOR && grant === false) {
    return problem('you cannot remove your own moderator role', 409);
  }

  const target = await admin.getUser(userId);
  if (!target) return problem('no such user', 404);

  const next = new Set(rolesOf(target));
  if (grant === false) next.delete(role); else next.add(role);

  const updated = await admin.updateUser(userId, { app_metadata: { roles: [...next] } });

  return json({
    user: { id: userId, email: target.email, roles: rolesOf(updated) ?? [...next] },
    // Worth saying plainly: the JWT only picks this up on the next refresh, so
    // the affected user will not see the change until they sign in again.
    note: 'takes effect the next time that user signs in or refreshes their session',
  });
};

export const config = { path: '/api/review/users' };
