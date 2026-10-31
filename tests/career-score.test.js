// Free Resume Score / LinkedIn Check (api/agents.js task "career_score"), with mocks.
const { test } = require('node:test');
const assert = require('node:assert/strict');

function harness(aiText) {
  const mailPath = require.resolve('../api/_mail'), aiPath = require.resolve('../api/_ai'), agPath = require.resolve('../api/agents');
  const real = require('../api/_mail'), realAi = require('../api/_ai');
  const prompts = [];
  require.cache[mailPath].exports = Object.assign({}, real, { userFromToken: async t => (t ? { id: t, email: t + '@x.test' } : null) });
  require.cache[aiPath].exports = Object.assign({}, realAi, {
    callClaude: async o => { prompts.push(o); return { content: [{ type: 'text', text: aiText }] }; },
    textOf: d => d.content.map(c => c.text).join('')
  });
  delete require.cache[agPath];
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  const savedFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => '*/0' }, json: async () => ({}), text: async () => '' });
  const handler = require('../api/agents');
  const call = (token, payload) => new Promise(resolve => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(d) { resolve({ code: this.code, body: d }); } };
    handler({ method: 'POST', headers: { authorization: token ? 'Bearer ' + token : '' }, body: payload }, res);
  });
  const done = () => { global.fetch = savedFetch; delete require.cache[agPath]; delete require.cache[mailPath]; delete require.cache[aiPath]; };
  return { call, prompts, done };
}
const RESUME = 'Business Analyst with 5 years of experience in requirements, process mapping and stakeholder management. '.repeat(2);

test('career score needs a signed-in account', async () => {
  const h = harness('{}');
  const r = await h.call(null, { task: 'career_score', kind: 'resume', text: RESUME });
  assert.equal(r.code, 401); h.done();
});

test('career score refuses another person\'s file and too-short text', async () => {
  const h = harness('{}');
  assert.equal((await h.call('u1', { task: 'career_score', kind: 'resume', path: 'u2/cv.pdf' })).code, 403);
  assert.equal((await h.call('u1', { task: 'career_score', kind: 'linkedin', text: 'short' })).code, 400);
  h.done();
});

test('career score returns a clamped score, strengths and three fixes', async () => {
  const fixes = [1, 2, 3, 4].map(n => ({ title: 'Fix ' + n, detail: 'Do ' + n }));
  const h = harness('```json\n' + JSON.stringify({ score: 140, verdict: 'Clear and focused.', strengths: ['Clear summary'], fixes }) + '\n```');
  const r = await h.call('u1', { task: 'career_score', kind: 'linkedin', text: RESUME, target: 'Product Manager' });
  assert.equal(r.code, 200);
  assert.equal(r.body.score, 100);
  assert.equal(r.body.kind, 'linkedin');
  assert.equal(r.body.fixes.length, 3);
  assert.deepEqual(r.body.strengths, ['Clear summary']);
  assert.match(h.prompts[0].system, /LinkedIn/);
  assert.match(h.prompts[0].system, /Product Manager/);
  h.done();
});

test('career score reports a failed review instead of an empty result', async () => {
  const h = harness('not json');
  const r = await h.call('u1', { task: 'career_score', kind: 'resume', text: RESUME });
  assert.equal(r.code, 502); h.done();
});
