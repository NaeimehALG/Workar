const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const navSource = html.slice(html.indexOf('function nav(view, params, fromHistory){'), html.indexOf("window.addEventListener('popstate'"));

test('booking after password recovery starts signup and preserves the selected mentor', () => {
  const context = { uid: null, state: { view: 'browse', authMode: 'forgot', authError: 'old', authInfo: 'old', authCheckEmail: true }, render() {}, window: { scrollTo() {} }, history: { pushState() {} } };
  vm.createContext(context); vm.runInContext(navSource, context);
  context.nav('onboard', { role: 'client', returnMentorId: 'mentor-1' });
  assert.equal(context.state.authMode, 'signup');
  assert.equal(context.state.returnMentorId, 'mentor-1');
  assert.equal(context.state.authError, '');
  assert.equal(context.state.authInfo, '');
  assert.equal(context.state.authCheckEmail, false);
  context.state.authMode = 'forgot'; context.nav('browse'); context.nav('dashboard');
  assert.equal(context.state.authMode, 'login');
  context.state.authMode = 'signup'; context.nav('dashboard');
  assert.equal(context.state.authMode, 'signup');
});

test('a coach sign-in redirect does not become an unavailable-coach reply', async () => {
  const source = html.slice(html.indexOf('async function sampleChat(turns){'), html.indexOf('async function sampleMatch('));
  const error = Object.assign(new Error('sign-in'), { signIn: true });
  const context = { state: { coachMode: 'resume' }, callAI: async () => { throw error; }, fallbackCoachReply: () => { throw new Error('Must not create a fallback reply'); } };
  vm.createContext(context); vm.runInContext(source, context);
  const result = await context.sampleChat([{ role: 'user', content: 'Test' }]);
  assert.equal(result.signIn, true); assert.equal(result.text, null);
});

function apiHarness({ signedIn = true, credits = 2, text = 'Useful response', failure = false } = {}) {
  const calls = [], patches = [];
  const mail = {
    userFromToken: async token => signedIn && token === 'test-token' ? { id: 'test-user', email: 'client@example.test' } : null,
    rows: async () => [{ aiCredits: credits }],
    patch: async () => { throw new Error('Balances must never be overwritten'); }
  };
  const ai = { callClaude: async input => { calls.push(input); if (failure) throw new Error('temporary-failure'); return { text }; }, textOf: data => data.text };
  const store = { consume: async userId => { patches.push({userId, value: {aiCredits: credits - 1}}); return credits - 1; } };
  const context = { module: { exports: {} }, process: { env: { ANTHROPIC_API_KEY: 'test-only-key', SUPABASE_URL: 'https://example.test' } }, require: name => name === './_mail' ? mail : name === './_credits' ? store : ai, AbortController, setTimeout, clearTimeout };
  vm.createContext(context); vm.runInContext(fs.readFileSync(path.join(root, 'api/ai.js'), 'utf8'), context);
  const response = { statusCode: null, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { calls, patches, response, request: async body => { await context.module.exports({ method: 'POST', headers: { authorization: 'Bearer test-token' }, body }, response); return response; } };
}

test('mock interview sends the target role as context and debits one credit after success', async () => {
  const h = apiHarness();
  await h.request({ mode: 'interview', interviewRole: 'Junior Project Coordinator', turns: [{ role: 'user', content: 'Begin the interview.' }] });
  assert.equal(h.response.statusCode, 200);
  assert.match(h.calls[0].system, /Junior Project Coordinator/);
  assert.match(h.calls[0].system, /Ask one question at a time/);
  assert.equal(h.calls[0].messages[0].content, 'Begin the interview.');
  assert.equal(h.patches[0].value.aiCredits, 1);
});

test('resume mode asks for factual, concrete resume improvements', async () => {
  const h = apiHarness(); await h.request({ mode: 'resume', prompt: 'My resume' });
  assert.match(h.calls[0].system, /one concrete rewrite/);
  assert.match(h.calls[0].system, /Never invent achievements/);
});

test('signed-out users and users with zero credits do not call the AI', async () => {
  for (const [options, code] of [[{ signedIn: false }, 401], [{ credits: 0 }, 402]]) {
    const h = apiHarness(options); await h.request({ prompt: 'Help' });
    assert.equal(h.response.statusCode, code); assert.equal(h.calls.length, 0); assert.equal(h.patches.length, 0);
  }
});

test('empty and failed AI replies never consume credits', async () => {
  for (const [options, code] of [[{ text: '' }, 502], [{ failure: true }, 500]]) {
    const h = apiHarness(options); await h.request({ prompt: 'Help' });
    assert.equal(h.response.statusCode, code); assert.equal(h.patches.length, 0);
  }
});

test('all inline scripts parse', () => {
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) new vm.Script(match[1]);
  }
});

