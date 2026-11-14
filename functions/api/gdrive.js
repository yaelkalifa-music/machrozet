// Streams a file from the signed-in user's own Google Drive (private files too),
// so a song starts playing at once instead of waiting for the whole download.
//   /api/gdrive?id=<fileId>&t=<the user's short-lived Google access token>
export async function onRequest({ request }) {
  const q = new URL(request.url).searchParams;
  const id = q.get('id') || '', t = q.get('t') || '';
  if (!/^[\w-]{10,}$/.test(id) || !t) return new Response('bad request', { status: 400 });
  const h = { Authorization: 'Bearer ' + t };
  const range = request.headers.get('range');
  if (range) h.Range = range;
  const up = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: h });
  const out = new Headers();
  ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].forEach(k => { const v = up.headers.get(k); if (v) out.set(k, v); });
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');
  const ct = up.headers.get('content-type') || '';
  out.set('content-type', /audio|video/.test(ct) ? ct : 'audio/mpeg');
  out.set('cache-control', 'private, no-store');
  return new Response(up.body, { status: up.status, headers: out });
}
