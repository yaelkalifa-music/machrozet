// Google Drive helper for /playlist/ (פלייליסט יעל כליפא).
// Works with files/folders shared as "anyone with the link".
//   ?folder=<folderId>  -> { items: [{id, title, mime}] }   (songs inside a shared folder)
//   ?file=<fileId>      -> { id, title }
//   ?play=<fileId>      -> the audio itself (streams, supports seeking)
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const J = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: J });
const ID = /^[\w-]{20,}$/;
const AUDIO = /\.(mp3|m4a|wav|aac|ogg|flac)$/i;

function unescapeJs(s) {
  return s.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
          .replace(/\\\//g, '/').replace(/\\\\/g, '\\');
}
function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

async function listFolder(fid) {
  const r = await fetch(`https://drive.google.com/drive/folders/${fid}?usp=sharing&hl=en`, { headers: { 'user-agent': UA, 'accept-language': 'en' } });
  if (!r.ok) return { error: r.status === 404 ? 'not_found' : 'not_shared' };
  let html = await r.text();
  const raw = unescapeJs(html).replace(/\\"/g, '"');
  const seen = new Map();
  // entries look like: ["<fileId>",["<folderId>"],"<name>","<mimeType>", ...
  const re = new RegExp('\\["([\\w-]{25,})",\\["' + fid + '"\\],"([^"]{1,300})","([^"]{3,100})"', 'g');
  let m;
  while ((m = re.exec(raw))) {
    const [, id, name, mime] = m;
    if (/folder/.test(mime)) continue;
    if (/^audio\//.test(mime) || AUDIO.test(name)) if (!seen.has(id)) seen.set(id, { id, title: name.replace(AUDIO, ''), mime });
  }
  // fallback: anything that looks like id + audio file name
  if (!seen.size) {
    const re2 = /"([\w-]{25,})",\[[^\]]*\],"([^"]{1,300}\.(?:mp3|m4a|wav|aac|ogg|flac))"/gi;
    while ((m = re2.exec(raw))) if (!seen.has(m[1])) seen.set(m[1], { id: m[1], title: m[2].replace(AUDIO, ''), mime: 'audio/mpeg' });
  }
  if (!seen.size && /ServiceLogin|accounts\.google\.com/.test(html)) return { error: 'not_shared' };
  return { items: [...seen.values()] };
}

async function fileInfo(id) {
  const r = await fetch(`https://drive.google.com/file/d/${id}/view?hl=en`, { headers: { 'user-agent': UA } });
  if (!r.ok) return { error: 'not_shared' };
  const html = await r.text();
  const m = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i) || html.match(/<title>([^<]*)<\/title>/i);
  let title = m ? decodeHtml(m[1]).replace(/\s*-\s*Google Drive\s*$/i, '') : '';
  if (/ServiceLogin|Sign in/i.test(title)) return { error: 'not_shared' };
  return { id, title: title.replace(AUDIO, '') };
}

async function play(id, request) {
  const h = { 'user-agent': UA };
  const range = request.headers.get('range');
  if (range) h.range = range;
  const up = await fetch(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, { headers: h, redirect: 'follow' });
  const ct = up.headers.get('content-type') || '';
  if (/text\/html/.test(ct)) return new Response('not shared', { status: 403, headers: { 'access-control-allow-origin': '*' } });
  const out = new Headers();
  ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].forEach(k => { const v = up.headers.get(k); if (v) out.set(k, v); });
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');
  out.set('content-type', /audio|video/.test(ct) ? ct : 'audio/mpeg');
  out.set('access-control-allow-origin', '*');
  out.set('cache-control', 'private, max-age=86400');
  out.delete('content-disposition');
  return new Response(up.body, { status: up.status, headers: out });
}

export async function onRequest({ request }) {
  const q = new URL(request.url).searchParams;
  try {
    if (q.get('play')) { const id = q.get('play'); if (!ID.test(id)) return json({ error: 'bad_id' }, 400); return await play(id, request); }
    if (q.get('folder')) { const id = q.get('folder'); if (!ID.test(id)) return json({ error: 'bad_id' }, 400); const r = await listFolder(id); return json(r, r.error ? 422 : 200); }
    if (q.get('file')) { const id = q.get('file'); if (!ID.test(id)) return json({ error: 'bad_id' }, 400); const r = await fileInfo(id); return json(r, r.error ? 422 : 200); }
    return json({ error: 'missing' }, 400);
  } catch (e) {
    return json({ error: 'fetch_failed', message: String(e && e.message || e) }, 502);
  }
}
