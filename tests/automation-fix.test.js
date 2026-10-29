// Automation fixes of Oct 29 2026: retries of unsent emails, the digest showing what the other runs did,
// approve-before-record, AI backoff, paging through all sign-ups, CRON_SECRET, and the LinkedIn content check.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const mailPath = require.resolve('../api/_mail'), aiPath = require.resolve('../api/_ai'), apPath = require.resolve('../api/_autopilot');
const realM = require('../api/_mail'), realAi = require('../api/_ai');
process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';

// A tiny in-memory agent_events table behind fetch.
function fakeDb(extra = () => null) {
  const events = new Map(), deleted = [], posted = [];
  const fetch = async (url, o = {}) => {
    url = String(url);
    const x = await extra(url, o); if (x) return x;
    const j = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b, text: async () => JSON.stringify(b) });
    if (url.includes('/agent_events') && o.method === 'POST') {
      const b = JSON.parse(o.body); posted.push(b);
      if (events.has(b.id)) return j([]);
      events.set(b.id, b); return j([b], 201);
    }
    if (url.includes('/agent_events?id=eq.') && o.method === 'DELETE') { const id = decodeURIComponent(url.split('id=eq.')[1]); deleted.push(id); events.delete(id); return j([]); }
    return j([]);
  };
  return { events, deleted, posted, fetch };
}
function load(mockM, mockAi) {
  require('../api/_mail'); require('../api/_ai');
  require.cache[mailPath].exports = Object.assign({}, realM, mockM);
  if (mockAi) require.cache[aiPath].exports = Object.assign({}, realAi, mockAi);
  delete require.cache[apPath];
  return require('../api/_autopilot');
}
function restore(saved) { global.fetch = saved; delete require.cache[apPath]; delete require.cache[mailPath]; delete require.cache[aiPath]; }

test('mail() forgets the once-key when sending fails, the recipient is missing, the cap is hit or mail is off', async () => {
  const saved = global.fetch, db = fakeDb(); global.fetch = db.fetch;
  let result = { ok: false };
  try {
    const AP = load({ sendMail: async () => result });
    const rep = { done: [], needs: [], emails: 0, errors: [], capped: 0, noRecipient: 0 };
    await AP.once('nudge-pay', 'r1');
    assert.equal(await AP._mail(rep, 'a@x.test', 'S', 'T', ['p'], null, ['nudge-pay', 'r1']), false);
    assert.ok(db.deleted.includes('nudge-pay:r1'));
    assert.equal(await AP._mail(rep, null, 'S', 'T', ['p'], null, ['ask', 'u1']), false);
    assert.ok(db.deleted.includes('ask:u1')); assert.equal(rep.noRecipient, 1);
    result = { skipped: true };
    assert.equal(await AP._mail(rep, 'a@x.test', 'S', 'T', ['p'], null, ['x', '1']), false);
    assert.ok(db.deleted.includes('x:1')); assert.equal(rep.mailOff, true);
    rep.emails = 60;
    result = { ok: true };
    assert.equal(await AP._mail(rep, 'a@x.test', 'S', 'T', ['p'], null, ['y', '1']), false);
    assert.ok(db.deleted.includes('y:1')); assert.equal(rep.capped, 1);
    const lines = AP.mailProblems(rep).join(' ');
    assert.match(lines, /not configured/); assert.match(lines, /safety limit of 60/); assert.match(lines, /no recipient/);
  } finally { restore(saved); }
});

test('a crash after approving never leaves "approve" recorded for a hidden mentor', async () => {
  const saved = global.fetch, order = [];
  const db = fakeDb(async (url, o) => { if (url.includes('/agent_events') && o.method === 'POST') order.push('record:' + JSON.parse(o.body).kind); return null; });
  global.fetch = db.fetch;
  const good = { id: 'g', name: 'Good Mentor', role: 'mentor', approved: false, headline: 'Senior PM', bio: 'x'.repeat(120), idealMentee: 'PMs', linkedin: 'https://linkedin.com/in/good-mentor', experience: '8', company: 'Acme', languages: ['English'], avatarUrl: 'a', field: 'Other', seniority: 'senior', industries: ['a'], skills: ['b'], helpsWith: ['leadership'] };
  try {
    const AP = load({
      rows: async q => q.startsWith('profiles?role=eq.mentor&approved=eq.false') ? [Object.assign({}, good)] : [],
      rowsStrict: async q => q.startsWith('profiles?role=eq.mentor&approved=eq.false') ? [Object.assign({}, good)] : [],
      patch: async (p, b) => { order.push('patch:' + JSON.stringify(b)); return { ok: false }; },
      emailOf: async id => id + '@x.test', sendMail: async () => ({ ok: true })
    }, { askJSON: async () => [{ id: 'g', verdict: 'approve', summary: 'ok' }] });
    process.env.ANTHROPIC_API_KEY = 'k';
    const rep = { done: [], needs: [], emails: 0, errors: [] };
    await AP.mentorApplications(rep, {});
    assert.ok(order.includes('patch:{"approved":true}'));
    assert.ok(!db.events.has('approve:g'));            // the patch failed: nothing recorded, retried next run
    assert.ok(rep.errors.some(e => /Could not approve/.test(e)));
  } finally { restore(saved); }
});

test('after 3 failed AI reviews of the same profile version the applicant goes to "Needs you"', async () => {
  const saved = global.fetch, db = fakeDb(); global.fetch = db.fetch;
  const app = { id: 'p', name: 'Pat Mentor', role: 'mentor', approved: false, headline: 'PM', bio: 'y'.repeat(120), idealMentee: 'PMs', linkedin: 'https://linkedin.com/in/pat-m', experience: '9', company: 'Acme', languages: ['English'], avatarUrl: 'a', field: 'Other', seniority: 'senior', industries: ['a'], skills: ['b'], helpsWith: ['leadership'] };
  let calls = 0;
  try {
    const rowsFn = async q => {
      if (q.startsWith('profiles?role=eq.mentor&approved=eq.false')) return [Object.assign({}, app)];
      if (q.startsWith('agent_events?kind=eq.review_fail')) return [...db.events.values()].filter(e => e.kind === 'review_fail').map(e => ({ ref: e.ref }));
      return [];
    };
    const AP = load({ rows: rowsFn, rowsStrict: rowsFn, patch: async () => ({ ok: true }), emailOf: async id => id + '@x.test', sendMail: async () => ({ ok: true }) },
      { askJSON: async sys => { if (/review mentor applications/.test(sys)) calls++; throw new Error('AI down'); } });
    process.env.ANTHROPIC_API_KEY = 'k';
    for (let i = 0; i < 3; i++) { const rep = { done: [], needs: [], emails: 0, errors: [] }; await AP.mentorApplications(rep, {}); }
    assert.equal(calls, 3);                                       // one (mocked) AI call per run
    const before = calls;
    const rep = { done: [], needs: [], emails: 0, errors: [] };
    await AP.mentorApplications(rep, {});
    assert.equal(calls, before);                                  // no fourth AI call
    assert.ok(rep.needs.some(n => /failed 3 times/.test(n.text)));
  } finally { restore(saved); }
});

test('the daily digest lists what the 15-minute and hourly jobs did, their errors and money alerts', async () => {
  const saved = global.fetch, db = fakeDb(); global.fetch = db.fetch;
  const U = '11111111-1111-1111-1111-111111111111', V = '22222222-2222-2222-2222-222222222222';
  const now = new Date().toISOString();
  const rowsFn = async q => {
    if (q.startsWith('agent_events?kind=in.')) return [
      { id: 'approve:' + U, kind: 'approve', ref: U, createdAt: now },
      { id: 'ask:' + V, kind: 'ask', ref: V, createdAt: now }, { id: 'ask:' + V + ':abc', kind: 'ask', ref: V + ':abc', createdAt: now },
      { id: 'finish-profile:' + V, kind: 'finish-profile', ref: V, createdAt: now },
      { id: 'agent_error:1', kind: 'agent_error', ref: 'Hourly setup sweep: boom', createdAt: now },
      { id: 'agent_error:2', kind: 'agent_error', ref: 'Hourly setup sweep: boom', createdAt: now },
      { id: 'money_alert:1', kind: 'money_alert', ref: 'Refund failed <script>', createdAt: now }];
    if (q.startsWith('profiles?id=in.')) return [{ id: U, name: 'Ann Lee' }, { id: V, name: 'Bo <b>' }];
    return [];
  };
  let html = '', subject = '';
  try {
    const AP = load({ rows: rowsFn, rowsStrict: rowsFn, sendMail: async (to, s, h) => { subject = s; html = h; return { ok: true }; } });
    const out = await AP.run([], {});
    assert.equal(out.digest, 'sent');
    assert.match(html, /Approved mentor <b>Ann Lee<\/b>/);
    assert.match(html, /Asked mentor applicant <b>Bo &lt;b&gt;<\/b>/);
    assert.ok(!/again after they updated/.test(html));           // the first ask's version marker is not a second email
    assert.match(html, /Hourly setup sweep: boom \(2 times\)/);
    assert.match(html, /Refund failed &lt;script&gt;/);
    assert.match(html, /Between daily runs/);
    assert.ok(!/AUTOPILOT-SETUP/.test(html));
    assert.match(subject, /need you/);
    assert.ok(db.events.has('digest:' + new Date().toISOString().slice(0, 10)));   // marker for the 17:30 check
  } finally { restore(saved); }
});

test('the digest does not list again what the daily run itself just did', async () => {
  const saved = global.fetch, db = fakeDb(); global.fetch = db.fetch;
  const U = '33333333-3333-3333-3333-333333333333';
  let html = '';
  try {
    const AP = load({
      rows: async () => [], sendMail: async (to, s, h) => { html = h; return { ok: true }; },
      rowsStrict: async q => q.startsWith('agent_events?kind=in.') ? [{ id: 'expire:req1', kind: 'expire', ref: 'req1', createdAt: new Date().toISOString() }, { id: 'approve:' + U, kind: 'approve', ref: U, createdAt: new Date().toISOString() }] : []
    });
    await AP.once('expire', 'req1');                              // claimed by the current run
    const act = await AP._otherRunActivity({}, Date.now() - 3600e3);
    assert.ok(!act.done.some(d => /Closed an unanswered/.test(d)));
    assert.ok(act.done.some(d => /Approved mentor/.test(d)));
    assert.ok(html === '');
  } finally { restore(saved); }
});

test('a digest that could not be sent (no RESEND_API_KEY) counts as failed and writes no marker', async () => {
  const saved = global.fetch, db = fakeDb(); global.fetch = db.fetch;
  try {
    const AP = load({ rows: async () => [], rowsStrict: async () => [], sendMail: async () => ({ skipped: true }) });
    const out = await AP.run([], {});
    assert.equal(out.digest, 'failed');
    assert.ok(![...db.events.keys()].some(k => k.startsWith('digest:')));
  } finally { restore(saved); }
});

test('sign-up checks page through every user and skip anonymous ones', async () => {
  const saved = global.fetch, pages = [];
  const mk = (n, start) => Array.from({ length: n }, (_, i) => ({ id: 'u' + (start + i), email: `u${start + i}@x.test`, created_at: new Date().toISOString(), is_anonymous: i === 0 }));
  global.fetch = async url => {
    url = String(url);
    if (url.includes('/auth/v1/admin/users?page=')) { const p = Number(/page=(\d+)/.exec(url)[1]); pages.push(p); return { ok: true, json: async () => ({ users: p === 1 ? mk(500, 0) : p === 2 ? mk(500, 500) : mk(3, 1000) }) }; }
    return { ok: true, json: async () => [] };
  };
  try {
    const AP = load({});
    const users = await AP.allUsers();
    assert.deepEqual(pages, [1, 2, 3]);
    assert.equal(users.length, 1003 - 3);
  } finally { restore(saved); }
});

test('the daily job refuses to run without CRON_SECRET; digest_check needs its key', async () => {
  const r = require('../api/reminders');
  const res = () => { const o = { code: 0, body: null }; o.status = c => { o.code = c; return o; }; o.json = b => { o.body = b; return o; }; o.end = () => o; o.send = b => { o.body = b; return o; }; return o; };
  const saved = process.env.CRON_SECRET; delete process.env.CRON_SECRET;
  try {
    const a = res(); await r({ query: {}, headers: {} }, a); assert.equal(a.code, 503);
    process.env.CRON_SECRET = 's';
    const b = res(); await r({ query: {}, headers: { authorization: 'Bearer wrong' } }, b); assert.equal(b.code, 401);
    delete process.env.DIGEST_CHECK_KEY;
    const c = res(); await r({ query: { task: 'digest_check' }, headers: { 'x-digest-key': '' } }, c); assert.equal(c.code, 401);
  } finally { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; }
});

test('askJSON never starts an AI call that would run past the deadline', async () => {
  const savedFetch = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, json: async () => ({ content: [{ type: 'text', text: '[]' }] }) }; };
  process.env.ANTHROPIC_API_KEY = 'k';
  try {
    delete require.cache[aiPath];
    const AI = require('../api/_ai');
    await assert.rejects(AI.askJSON('s', 'u', { deadline: Date.now() + 1000 }));
    assert.equal(calls, 0);
    assert.deepEqual(await AI.askJSON('s', 'u', { deadline: Date.now() + 60000 }), []);
    assert.equal(calls, 1);
  } finally { global.fetch = savedFetch; delete require.cache[aiPath]; }
});

test('LinkedIn: a late post is reported, member names and member counts are held back, 48 hours ahead are sent', async () => {
  process.env.TYPEFULLY_API_KEY = 'tk'; delete process.env.TYPEFULLY_SOCIAL_SET_ID;
  const L = require('../api/_linkedin');
  const h = n => new Date(Date.now() + n * 3600e3).toISOString();
  const rows = [{ id: 'late', publishAt: h(-2), text: 'x' }, { id: 'name', publishAt: h(3), text: 'Congratulations to Sara Ahmadi on her new role' },
    { id: 'count', publishAt: h(4), text: 'Workar now has 120 mentors and 3,000 members' }, { id: 'ok', publishAt: h(40), text: '3 tips for your 1-on-1 interview prep' }];
  const patches = []; const saved = global.fetch;
  global.fetch = async (url, opt = {}) => {
    url = String(url); const j = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b });
    if (url.includes('/linkedin_queue?status=eq.queued')) return j(rows);
    if (url.includes('/profiles?select=name')) return j([{ name: 'Sara Ahmadi' }, { name: 'Ali' }]);
    if (url.includes('/linkedin_queue?id=eq.')) { patches.push({ id: decodeURIComponent(url.split('id=eq.')[1]), body: JSON.parse(opt.body) }); return j({}); }
    if (url.endsWith('/social-sets?limit=50')) return j({ results: [{ id: 's1', name: 'Workar' }] });
    if (url.endsWith('/drafts')) return j({ id: 'd1' }, 201);
    return j({}, 404);
  };
  try {
    const problems = [];
    const out = await L.run(problems);
    assert.equal(out.linkedinScheduled, 1);
    assert.equal(patches.find(p => p.id === 'ok').body.status, 'scheduled');      // 40 h ahead is sent now
    assert.equal(patches.find(p => p.id === 'name').body.status, 'held');
    assert.equal(patches.find(p => p.id === 'count').body.status, 'held');
    assert.ok(problems.some(p => /already passed/.test(p)));
    assert.ok(problems.some(p => /names a Workar member/.test(p)));
    assert.ok(problems.some(p => /number of mentors/.test(p)));
    assert.equal(L.postProblem('Book a 30-minute session with a mentor', []), '');
  } finally { global.fetch = saved; delete process.env.TYPEFULLY_API_KEY; }
});

test('the help desk facts never claim that Workar reviews or vets mentors, and the welcome email does not either', () => {
  const K = require('../api/_knowledge');
  assert.ok(!/reviews every mentor|profiles are reviewed|vetted|verified mentor/i.test(K));
  assert.match(K, /goes live once it is complete/);
  assert.ok(!/AI agents? (run|operate|manage)/i.test(K));
  const src = require('fs').readFileSync(require.resolve('../api/_autopilot'), 'utf8');
  assert.ok(!/has been reviewed/.test(src));
});
