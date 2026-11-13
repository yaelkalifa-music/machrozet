// Resolves a Suno link (song, short /s/ link, or playlist) to playable MP3 URLs.
// Used by /playlist/ (פלייליסט יעל כליפא).
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const HDR = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: HDR });

function okHost(u) {
  try { const h = new URL(u).hostname; return /(^|\.)suno\.(com|ai)$/.test(h); } catch (e) { return false; }
}
function meta(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']*)', 'i');
  const re2 = new RegExp('<meta[^>]+content=["\']([^"\']*)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', 'i');
  const m = html.match(re) || html.match(re2);
  return m ? decode(m[1]) : '';
}
function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function cleanTitle(t) {
  return (t || '').replace(/\s*[|–-]\s*Suno\s*$/i, '').replace(/\s+by\s+@?\S+$/i, '').trim();
}
async function follow(url) {
  let target = url;
  for (let i = 0; i < 5; i++) {
    if (UUID.test(new URL(target).pathname) && /\/song\//.test(target)) return target;
    const r = await fetch(target, { redirect: 'manual', headers: { 'user-agent': UA } });
    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) { target = new URL(loc, target).toString(); continue; }
    return target;
  }
  return target;
}
async function songInfo(id) {
  const out = { type: 'suno', id, audio: `https://cdn1.suno.ai/${id}.mp3`, title: '', image: '' };
  try {
    const r = await fetch(`https://suno.com/song/${id}`, { headers: { 'user-agent': UA } });
    const html = await r.text();
    out.title = cleanTitle(meta(html, 'og:title') || (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '');
    out.image = meta(html, 'og:image');
  } catch (e) {}
  return out;
}

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: { ...HDR, 'access-control-allow-methods': 'GET' } });
  const url = new URL(request.url).searchParams.get('url') || '';
  if (!okHost(url)) return json({ error: 'not_suno' }, 400);
  try {
    const final = await follow(url);
    const path = new URL(final).pathname;

    // playlist
    const pl = path.match(/\/playlist\/([0-9a-f-]{36})/i);
    if (pl) {
      const items = [];
      for (let page = 1; page <= 5; page++) {
        const r = await fetch(`https://studio-api.prod.suno.com/api/playlist/${pl[1]}/?page=${page}`, { headers: { 'user-agent': UA, accept: 'application/json' } });
        if (!r.ok) break;
        const j = await r.json();
        const clips = (j.playlist_clips || []).map(c => c.clip || c).filter(c => c && c.id);
        clips.forEach(c => items.push({ type: 'suno', id: c.id, title: c.title || '', image: c.image_url || '', audio: c.audio_url || `https://cdn1.suno.ai/${c.id}.mp3` }));
        if (!clips.length || (j.num_total_results && items.length >= j.num_total_results)) break;
      }
      if (items.length) return json({ kind: 'playlist', items });
      return json({ error: 'playlist_unreadable' }, 422);
    }

    // single song
    let m = path.match(UUID);
    if (!m) {
      const r = await fetch(final, { headers: { 'user-agent': UA } });
      const html = await r.text();
      const og = meta(html, 'og:url') + ' ' + meta(html, 'og:audio');
      m = og.match(UUID) || html.match(/\/song\/([0-9a-f-]{36})/i);
      if (m && m[1] && UUID.test(m[1])) m = [m[1]];
    }
    if (!m) return json({ error: 'no_song_id', final }, 422);
    return json({ kind: 'song', items: [await songInfo(m[0])] });
  } catch (e) {
    return json({ error: 'fetch_failed', message: String(e && e.message || e) }, 502);
  }
}
