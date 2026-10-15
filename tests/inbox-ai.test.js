// Inbox AI: prep brief, message translation and the payment guard (api/agents.js), with mocks.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function harness({ messages = [], requests = [], ai = {}, reports = [] }) {
  const mailPath = require.resolve('../api/_mail'), aiPath = require.resolve('../api/_ai'), sPath = require.resolve('../api/_session');
  const agPath = require.resolve('../api/agents');
  const real = require('../api/_mail'); const realAi = require('../api/_ai'); const realS = require('../api/_session');
  const sent = [], inserted = [], patched = [];
  require.cache[mailPath].exports = Object.assign({}, real, {
    userFromToken: async t => (t ? { id: t, email: t + '@x.test' } : null),
    rows: async q => q.startsWith('messages?') ? messages.filter(m => q.includes(encodeURIComponent(m.id))) :
      q.startsWith('requests?') ? requests.filter(r => q.includes(encodeURIComponent(r.id))) :
      q.startsWith('safety_reports?') ? reports.slice() : [],
    patch: async (p, b) => { patched.push({ p, b }); return { ok: true }; },
    profile: async id => ({ id, name: id === 'm1' ? 'Arash' : 'Nora', role: id === 'm1' ? 'mentor' : 'client' }),
    sendMail: async (to, subject) => { sent.push({ to, subject }); }
  });
  require.cache[aiPath].exports = Object.assign({}, realAi, {
    askJSON: async () => ai.json || {},
    callClaude: async () => ({ content: [{ type: 'text', text: ai.text || '' }] }),
    textOf: d => d.content.map(c => c.text).join('')
  });
  require.cache[sPath].exports = Object.assign({}, realS, { makePrepBrief: async () => ({ goal: 'Move into PM', clientTips: ['Bring your resume'], agenda: ['a'], context: [] }) });
  delete require.cache[agPath];
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  const savedFetch = global.fetch;
  global.fetch = async (url, opt = {}) => {
    if (String(url).includes('/safety_reports') && opt.method === 'POST') inserted.push(JSON.parse(opt.body));
    return { ok: true, status: 200, headers: { get: () => '*/0' }, json: async () => ({}), text: async () => '' };
  };
  const handler = require('../api/agents');
  const call = (token, payload) => new Promise(resolve => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(d) { resolve({ code: this.code, body: d }); } };
    handler({ method: 'POST', headers: { authorization: token ? 'Bearer ' + token : '' }, body: payload }, res);
  });
  const done = () => { global.fetch = savedFetch; delete require.cache[agPath]; delete require.cache[mailPath]; delete require.cache[aiPath]; delete require.cache[sPath]; };
  return { call, sent, inserted, patched, done };
}

test('payment guard flags a message that moves payment outside Workar', async () => {
  const h = harness({ messages: [{ id: 'msg1', requestId: 'dm_c1_m1', senderId: 'm1', text: 'Send me an e-Transfer directly and we can skip Workar fees' }],
    ai: { json: { offPlatform: true, confidence: 0.95, reason: 'Asks for e-Transfer outside Workar.' } } });
  try {
    const r = await h.call('m1', { task: 'msg_check', messageId: 'msg1' });
    assert.equal(r.body.flagged, true);
    assert.equal(h.inserted.length, 1);
    assert.equal(h.inserted[0].reporterId, 'workar-ai'); assert.equal(h.inserted[0].reportedId, 'm1'); assert.equal(h.inserted[0].category, 'scam');
    assert.equal(h.sent.length, 1);
  } finally { h.done(); }
});

test('payment guard ignores ordinary messages and other people\'s messages', async () => {
  const h = harness({ messages: [{ id: 'msg2', requestId: 'dm_c1_m1', senderId: 'c1', text: 'Thanks, see you Tuesday!' }, { id: 'msg3', requestId: 'dm_c1_m1', senderId: 'm1', text: 'pay me by paypal' }],
    ai: { json: { offPlatform: true, confidence: 0.99 } } });
  try {
    assert.equal((await h.call('c1', { task: 'msg_check', messageId: 'msg2' })).body.flagged, false); // no payment words
    assert.equal((await h.call('c1', { task: 'msg_check', messageId: 'msg3' })).body.flagged, false); // not the sender
    assert.equal(h.inserted.length, 0);
  } finally { h.done(); }
});

test('payment guard trusts the AI when it says salary talk is fine', async () => {
  const h = harness({ messages: [{ id: 'msg4', requestId: 'dm_c1_m1', senderId: 'c1', text: 'The bank job pays 80k cash bonus included' }], ai: { json: { offPlatform: false, confidence: 0.9 } } });
  try { assert.equal((await h.call('c1', { task: 'msg_check', messageId: 'msg4' })).body.flagged, false); assert.equal(h.inserted.length, 0); }
  finally { h.done(); }
});

test('translation is only for the two people in the conversation', async () => {
  const h = harness({ messages: [{ id: 'msg5', requestId: 'r1', senderId: 'm1', text: 'Bonjour, à mardi' }], requests: [{ id: 'r1', mentorId: 'm1', clientId: 'c1' }], ai: { text: 'سلام، تا سه‌شنبه' } });
  try {
    const ok = await h.call('c1', { task: 'translate', messageId: 'msg5', lang: 'fa' });
    assert.equal(ok.code, 200); assert.equal(ok.body.text, 'سلام، تا سه‌شنبه');
    assert.equal((await h.call('x9', { task: 'translate', messageId: 'msg5', lang: 'fa' })).code, 403);
    assert.equal((await h.call('', { task: 'translate', messageId: 'msg5', lang: 'fa' })).code, 401);
  } finally { h.done(); }
});

test('prep brief: mentor gets the full brief, client only their tips, strangers nothing', async () => {
  const h = harness({ requests: [{ id: 'r2', mentorId: 'm1', clientId: 'c1' }] });
  try {
    const m = await h.call('m1', { task: 'prep_brief', requestId: 'r2' });
    assert.equal(m.body.goal, 'Move into PM');
    assert.ok(h.patched.some(p => p.b.prepBrief));
    const c = await h.call('c1', { task: 'prep_brief', requestId: 'r2' });
    assert.deepEqual(Object.keys(c.body), ['clientTips']);
    assert.equal((await h.call('x9', { task: 'prep_brief', requestId: 'r2' })).code, 403);
  } finally { h.done(); }
});

test('package notes: only mentors, and only for the packages asked', async () => {
  const h = harness({ ai: { json: { notes: { single: 'One session on your interview answers.', resume: 'Two sessions of interview practice.', bogus: 'x' } } } });
  const mailPath = require.resolve('../api/_mail');
  const base = require.cache[mailPath].exports;
  base.fullProfile = async id => ({ id, role: id === 'm1' ? 'mentor' : 'client', helpsWith: ['interview'] });
  try {
    const r = await h.call('m1', { task: 'package_notes', packages: [{ key: 'single', sessions: 1 }, { key: 'resume', sessions: 2 }] });
    assert.equal(r.code, 200); assert.deepEqual(Object.keys(r.body.notes), ['single', 'resume']);
    assert.equal((await h.call('c1', { task: 'package_notes', packages: [{ key: 'single', sessions: 1 }] })).code, 403);
  } finally { h.done(); }
});
