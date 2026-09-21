/* Small shared helpers so every function answers in the same shape. */

export const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

export const problem = (message, status = 400) => json({ error: message }, status);

/** Read and size-limit a JSON body; never throws. */
export async function readJson(req, { maxBytes = 8192 } = {}) {
  const text = await req.text();
  if (text.length > maxBytes) return { ok: false, error: 'request body too large' };
  if (!text) return { ok: false, error: 'missing body' };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: 'body must be valid JSON' };
  }
}

/** Blobs is configured from the environment at runtime; surface a clear error
 *  rather than a stack trace if the site has no Blobs available. */
export async function openStore(name) {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name, consistency: 'strong' });
}
