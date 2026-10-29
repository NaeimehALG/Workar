// LinkedIn posting through Typefully (not a route: files starting with "_" are not deployed as functions).
// The weekly content task writes the coming week's posts into public.linkedin_queue (text, optional image URL,
// publish time). The daily cron (api/reminders.js) sends every queued post to Typefully, which publishes it
// on the Workar LinkedIn page at its time. Nothing is posted if TYPEFULLY_API_KEY is not set.
// Env: TYPEFULLY_API_KEY (required), TYPEFULLY_SOCIAL_SET_ID (optional; otherwise the set named "Workar" is used).
const API = 'https://api.typefully.com/v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const svc = () => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'Content-Type': 'application/json' });

async function tf(path, opts = {}) {
  const r = await fetch(API + path, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + process.env.TYPEFULLY_API_KEY, 'Content-Type': 'application/json' }, opts.headers || {}) }));
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Typefully ${opts.method || 'GET'} ${path.split('?')[0]} failed (${r.status}): ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

// The Workar social set: the env value if given, else the set whose name contains "Workar", else the only one.
function pickSocialSet(sets) {
  const list = (sets && sets.results) || [];
  const named = list.find(s => /workar/i.test(String(s.name || s.title || '')));
  if (named) return named.id;
  if (list.length === 1) return list[0].id;
  return null;
}
async function socialSetId() {
  if (process.env.TYPEFULLY_SOCIAL_SET_ID) return process.env.TYPEFULLY_SOCIAL_SET_ID;
  return pickSocialSet(await tf('/social-sets?limit=50'));
}

async function uploadImage(setId, url, alt) {
  const img = await fetch(url);
  if (!img.ok) throw new Error(`could not download the image (${img.status})`);
  const bytes = Buffer.from(await img.arrayBuffer());
  const name = (String(url).split('/').pop().split('?')[0] || 'image.png').replace(/[^\w.-]/g, '_');
  const up = await tf(`/social-sets/${encodeURIComponent(setId)}/media/upload`, { method: 'POST', body: JSON.stringify({ file_name: name, alt_text: String(alt || '').slice(0, 400) }) });
  const put = await fetch(up.upload_url, { method: 'PUT', body: bytes });
  if (!put.ok) throw new Error(`image upload failed (${put.status})`);
  for (let i = 0; i < 12; i++) {
    const m = await tf(`/social-sets/${encodeURIComponent(setId)}/media/${encodeURIComponent(up.media_id)}`);
    if (m.status === 'ready') return up.media_id;
    if (m.status === 'failed') throw new Error('Typefully could not process the image');
    await sleep(2500);
  }
  throw new Error('the image was still processing after 30 seconds');
}

function draftBody(row, mediaId) {
  const post = { text: String(row.text || '').slice(0, 3000) };
  if (mediaId) post.media_ids = [mediaId];
  return { platforms: { linkedin: { enabled: true, posts: [post] } }, publish_at: new Date(row.publishAt).toISOString(), draft_title: `Workar ${String(row.publishAt).slice(0, 10)} ${row.format || ''}`.trim() };
}

async function patchRow(id, body) {
  return fetch(`${process.env.SUPABASE_URL}/rest/v1/linkedin_queue?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: Object.assign({ Prefer: 'return=minimal' }, svc()), body: JSON.stringify(body) });
}

// Queued text is checked before it goes out: a post that names a Workar member or mentor, or states a count of
// mentors, members, sign-ups, users, bookings or clients (figures that must not be published), is held
// back and shown in the digest instead.
const COUNT_WORDS = '(?:mentors?|members?|sign[- ]?ups?|signups?|users?|bookings?|clients?|mentees?|customers?)';
// "1-on-1 mentoring" and "1:1 mentor" are not counts.
const COUNT_RE = new RegExp(`(?<!on[- ])(?<!\\d:)(?<![\\d,.])\\d[\\d,.]*\\s*\\+?\\s*(?:%\\s*)?(?:new\\s+|active\\s+|happy\\s+|registered\\s+|experienced\\s+)?${COUNT_WORDS}\\b|\\b${COUNT_WORDS}\\s*(?:[:=]|is|are|now|over|than|of|grew to|reached|hit|passed|topped|up to)?\\s*\\d`, 'i');
function postProblem(text, names) {
  const t = String(text || '');
  if (COUNT_RE.test(t)) return 'it states a number of mentors, members, sign-ups, users or bookings';
  const low = t.toLowerCase();
  for (const n of names || []) {
    const full = String(n || '').trim().replace(/\s+/g, ' ');
    if (full.length < 4 || !full.includes(' ')) continue;             // full names only; single first names are too common
    const re = new RegExp(`(^|[^\\p{L}])${full.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u');
    if (re.test(low)) return 'it names a Workar member or mentor';
  }
  return '';
}
async function memberNames() {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/profiles?select=name&name=not.is.null&limit=10000`, { headers: svc() });
  if (!r.ok) throw new Error(`member names could not be read (${r.status})`);
  return (await r.json()).map(p => p && p.name).filter(Boolean);
}

// Daily: send the posts due in the next 48 hours to Typefully, so a daily run that starts late never misses one.
// Posts whose time already passed are skipped, never posted late, and listed in the digest.
async function run(problems = []) {
  const out = { linkedinScheduled: 0 };
  if (!process.env.TYPEFULLY_API_KEY) return out;
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/linkedin_queue?status=eq.queued&select=*&order=publishAt.asc&limit=30`, { headers: svc() });
  if (!r.ok) { if (r.status !== 404) problems.push(`LinkedIn queue could not be read (${r.status}).`); return out; }
  const rows = await r.json();
  if (!rows.length) return out;
  let setId;
  try { setId = await socialSetId(); } catch (e) { problems.push('LinkedIn: ' + e.message); return out; }
  if (!setId) { problems.push('LinkedIn: could not find the Workar social set in Typefully. Set TYPEFULLY_SOCIAL_SET_ID in Vercel.'); return out; }
  const started = Date.now(), soon = started + 10 * 60 * 1000, horizon = started + 48 * 3600 * 1000;
  let names;
  try { names = await memberNames(); } catch (e) { problems.push('LinkedIn: no posts were sent today because ' + e.message + '; they are checked again tomorrow.'); return out; }
  for (const row of rows) {
    const at = Date.parse(row.publishAt), day = String(row.publishAt).slice(0, 10);
    if (at < soon) {
      await patchRow(row.id, { status: 'skipped', error: 'Its time had already passed when the daily run reached it.' });
      problems.push(`LinkedIn post for ${day} was not posted: its time had already passed when the daily run reached it (status "skipped" in linkedin_queue; set a new publishAt and status "queued" to post it).`);
      continue;
    }
    if (at > horizon) continue;                       // later posts go out with a later daily run
    if (Date.now() - started > 25000) break;          // stay inside the cron's time limit; the rest wait for tomorrow
    const bad = postProblem(row.text, names);
    if (bad) {
      await patchRow(row.id, { status: 'held', error: `Not posted: ${bad}.` });
      problems.push(`LinkedIn post for ${day} was held back and not posted because ${bad}. Edit the text in linkedin_queue and set its status to "queued" to post it.`);
      continue;
    }
    try {
      const mediaId = row.imageUrl ? await uploadImage(setId, row.imageUrl, row.altText) : null;
      const d = await tf(`/social-sets/${encodeURIComponent(setId)}/drafts`, { method: 'POST', body: JSON.stringify(draftBody(row, mediaId)) });
      await patchRow(row.id, { status: 'scheduled', typefullyDraftId: String(d.id || ''), sentAt: new Date().toISOString(), error: null });
      out.linkedinScheduled++;
    } catch (e) {
      console.error('linkedin-post', row.id, e.message);
      await patchRow(row.id, { status: 'failed', error: String(e.message || e).slice(0, 500) });
      problems.push(`LinkedIn post for ${String(row.publishAt).slice(0, 10)} could not be scheduled: ${e.message}`);
    }
  }
  return out;
}

module.exports = { run, pickSocialSet, draftBody, postProblem };
