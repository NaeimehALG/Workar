process.env.SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://jgbjhzhbdsdhssyakpgq.supabase.co').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '').replace(/\/+$/, ''); // tolerate a URL saved with /rest/v1
// Public mentor pages for Google and link previews (LinkedIn, WhatsApp, X…).
//   GET /mentor/<id>          (rewritten to /api/mentor-page?id=<id>)  -> index.html with that mentor's title,
//                             description, photo and canonical URL in the <head>; the page itself opens that mentor.
//   GET /mentors-sitemap.xml  (rewritten to /api/mentor-page?sitemap=1) -> sitemap of every live mentor page.
// Only mentors who are live (role mentor, approved is not false, not banned) get their details; anything else,
// including any error, serves the plain index.html, so the site always loads.
// Env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (already set), SITE_URL (optional, default https://www.workar.me)
const fs = require('fs');
const path = require('path');

const SITE = () => (process.env.SITE_URL || 'https://www.workar.me').replace(/\/+$/, '');
const svc = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY });
const LIVE = 'role=eq.mentor&approved=not.is.false&banned=not.is.true';
const ID_RX = /^[A-Za-z0-9_-]{1,80}$/;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clip(s, n) { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; }
function httpsUrl(u) { const t = String(u || '').trim(); return /^https:\/\/[^\s"'<>]+$/i.test(t) ? t : ''; }

let cachedHtml = null;
async function indexHtml(req) {
  if (cachedHtml) return cachedHtml;
  for (const f of [path.join(process.cwd(), 'index.html'), path.join(__dirname, '..', 'index.html')]) {
    try { cachedHtml = fs.readFileSync(f, 'utf8'); return cachedHtml; } catch (e) {}
  }
  // Not bundled with the function: fetch the static page from this same deployment.
  const host = req && req.headers && (req.headers['x-forwarded-host'] || req.headers.host);
  const origin = host ? 'https://' + String(host).split(',')[0].trim() : SITE();
  const r = await fetch(origin + '/index.html');
  if (!r.ok) throw new Error('index.html ' + r.status);
  cachedHtml = await r.text();
  return cachedHtml;
}

async function liveMentor(id) {
  if (!ID_RX.test(id || '') || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(id)}&${LIVE}&select=id,name,headline,profession,company,bio,avatarUrl&limit=1`, { headers: svc() });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// Replaces one tag in the <head>; a tag that is not there is left alone.
function setTag(html, rx, tag) { return rx.test(html) ? html.replace(rx, () => tag) : html; }

function mentorHead(html, p) {
  const site = SITE();
  const name = clip(p.name, 80) || 'Mentor';
  const head = clip(p.headline || [p.profession, p.company].filter(Boolean).join(' at '), 110);
  const title = name + (head ? ' · ' + head : '') + ' · Workar';
  const bio = clip(p.bio, 150);
  const desc = clip((head ? head + '. ' : '') + (bio || `Book a private career mentoring session with ${name} on Workar.`), 200);
  const url = site + '/mentor/' + encodeURIComponent(p.id);
  const photo = httpsUrl(p.avatarUrl);
  const image = photo || site + '/og-image.jpg?v=2';
  const T = esc(title), D = esc(desc), U = esc(url), I = esc(image);
  let h = html;
  h = setTag(h, /<title>[^<]*<\/title>/i, `<title>${T}</title>`);
  h = setTag(h, /<meta name="description" content="[^"]*">/i, `<meta name="description" content="${D}">`);
  h = setTag(h, /<meta property="og:type" content="[^"]*">/i, '<meta property="og:type" content="profile">');
  h = setTag(h, /<meta property="og:url" content="[^"]*">/i, `<meta property="og:url" content="${U}">`);
  h = setTag(h, /<meta property="og:title" content="[^"]*">/i, `<meta property="og:title" content="${T}">`);
  h = setTag(h, /<meta property="og:description" content="[^"]*">/i, `<meta property="og:description" content="${D}">`);
  h = setTag(h, /<link rel="canonical" href="[^"]*">/i, `<link rel="canonical" href="${U}">`);
  h = setTag(h, /<meta property="og:image" content="[^"]*">/i, `<meta property="og:image" content="${I}">`);
  h = setTag(h, /<meta property="og:image:alt" content="[^"]*">/i, `<meta property="og:image:alt" content="${esc(name)}">`);
  if (photo) { // the mentor's photo has its own size: drop the fixed 1200x630 and use a square card
    h = h.replace(/<meta property="og:image:width" content="[^"]*">/i, '').replace(/<meta property="og:image:height" content="[^"]*">/i, '');
    h = setTag(h, /<meta name="twitter:card" content="[^"]*">/i, '<meta name="twitter:card" content="summary">');
  }
  h = setTag(h, /<meta name="twitter:title" content="[^"]*">/i, `<meta name="twitter:title" content="${T}">`);
  h = setTag(h, /<meta name="twitter:description" content="[^"]*">/i, `<meta name="twitter:description" content="${D}">`);
  h = setTag(h, /<meta name="twitter:image" content="[^"]*">/i, `<meta name="twitter:image" content="${I}">`);
  const ld = { '@context': 'https://schema.org', '@type': 'ProfilePage', url, name: title,
    mainEntity: Object.assign({ '@type': 'Person', name, url }, head ? { jobTitle: head } : {}, photo ? { image: photo } : {}, bio ? { description: bio } : {}) };
  const json = JSON.stringify(ld).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return h.replace(/<\/head>/i, () => `<script type="application/ld+json">${json}</script>\n</head>`);
}

async function sitemap() {
  const site = SITE();
  const pages = ['/', '/?go=browse', '/?go=terms', '/?go=privacy', '/?go=refunds'];
  let mentors = [];
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?${LIVE}&select=id&order=id.asc&limit=5000`, { headers: svc() });
    if (r.ok) mentors = (await r.json()).map(m => m && m.id).filter(id => ID_RX.test(String(id || '')));
  }
  const url = (loc, freq, pri) => `  <url><loc>${esc(site + loc)}</loc><changefreq>${freq}</changefreq><priority>${pri}</priority></url>`;
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + pages.map((p, i) => url(p, i < 2 ? 'daily' : 'monthly', i === 0 ? '1.0' : i === 1 ? '0.9' : '0.3')).join('\n') + '\n'
    + mentors.map(id => url('/mentor/' + encodeURIComponent(id), 'weekly', '0.8')).join('\n') + (mentors.length ? '\n' : '')
    + '</urlset>\n';
}

async function handler(req, res) {
  const q = (req && req.query) || {};
  if (q.sitemap) {
    try {
      const xml = await sitemap();
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
      return res.status(200).send(xml);
    } catch (e) {
      console.error('mentor-page sitemap failed:', e && e.message);
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.status(200).send('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>' + esc(SITE() + '/') + '</loc></url>\n</urlset>\n');
    }
  }
  let html;
  try { html = await indexHtml(req); }
  catch (e) { console.error('mentor-page: index.html unavailable:', e && e.message); res.setHeader('Location', '/'); return res.status(302).send(''); }
  let out = html;
  try {
    const id = String(q.id || '').slice(0, 120);
    const p = await liveMentor(id);
    if (p) out = mentorHead(html, p);
  } catch (e) { console.error('mentor-page failed:', e && e.message); out = html; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=3600');
  return res.status(200).send(out);
}

module.exports = handler;
module.exports._mentorHead = mentorHead;
module.exports._sitemap = sitemap;
