// Song search for /playlist/ voice requests.
//   ?src=yt&q=...    -> { items: [{ type:'yt', id, title }] }   (YouTube results)
//   ?src=suno&q=...  -> { items: [{ type:'suno', id, title, image, audio }] }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const H = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=600' };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });

function textOf(t) { return t ? (t.simpleText || (t.runs || []).map(r => r.text).join('')) : ''; }

async function youtube(q) {
  const r = await fetch('https://www.youtube.com/results?hl=he&gl=IL&search_query=' + encodeURIComponent(q), {
    headers: { 'user-agent': UA, 'accept-language': 'he-IL,he;q=0.9,en;q=0.8', cookie: 'CONSENT=YES+1; SOCS=CAI' }
  });
  const html = await r.text();
  const items = [];
  const m = html.match(/var ytInitialData\s*=\s*(\{.+?\});\s*<\/script>/s) || html.match(/ytInitialData"\]\s*=\s*(\{.+?\});/s);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      (function walk(o) {
        if (!o || typeof o !== 'object' || items.length >= 8) return;
        if (o.videoRenderer && o.videoRenderer.videoId) {
          const v = o.videoRenderer;
          items.push({ type: 'yt', id: v.videoId, title: textOf(v.title), length: textOf(v.lengthText) });
          return;
        }
        for (const k in o) walk(o[k]);
      })(data);
    } catch (e) {}
  }
  if (!items.length) {
    const seen = new Set();
    const re = /"videoId":"([\w-]{11})"/g; let x;
    while ((x = re.exec(html)) && items.length < 8) if (!seen.has(x[1])) { seen.add(x[1]); items.push({ type: 'yt', id: x[1], title: '' }); }
  }
  return items;
}

async function suno(q) {
  const body = { search_queries: [{ name: 'public_song', search_type: 'public_song', term: q, from_index: 0, rank_by: 'most_relevant' }] };
  const r = await fetch('https://studio-api.prod.suno.com/api/search/', {
    method: 'POST', headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json', origin: 'https://suno.com', referer: 'https://suno.com/' },
    body: JSON.stringify(body)
  });
  if (!r.ok) return { error: 'suno_' + r.status };
  const j = await r.json();
  const items = [];
  (function walk(o) {
    if (!o || typeof o !== 'object' || items.length >= 8) return;
    if (o.id && o.audio_url && o.title !== undefined) { items.push({ type: 'suno', id: o.id, title: o.title || '', image: o.image_url || '', audio: o.audio_url }); return; }
    for (const k in o) walk(o[k]);
  })(j);
  return { items };
}

export async function onRequest({ request }) {
  const p = new URL(request.url).searchParams;
  const q = (p.get('q') || '').trim().slice(0, 120);
  if (!q) return json({ error: 'missing' }, 400);
  try {
    if (p.get('src') === 'suno') { const r = await suno(q); return json(r, r.error ? 502 : 200); }
    return json({ items: await youtube(q) });
  } catch (e) {
    return json({ error: 'fetch_failed', message: String(e && e.message || e) }, 502);
  }
}
