// Regression: the onboarding assistant must save the mentor's name and workplace
// (in any language) so it stops asking for them again.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const M = require('../api/_mail');
const AI = require('../api/_ai');
const agents = require('../api/agents');

function fakeRes() {
  return { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}

async function runChat(toolInput) {
  M.userFromToken = async () => ({ id: 'u1', email: 'm@example.com' });
  let call = 0;
  AI.callClaude = async () => (++call === 1
    ? { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'update_profile_draft', input: toolInput }] }
    : { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Thanks!' }] });
  const res = fakeRes();
  await agents({ method: 'POST', headers: { authorization: 'Bearer x' }, body: { task: 'onboard', messages: [{ role: 'user', content: 'hi' }], draft: {} } }, res);
  return res;
}

test('onboarding saves name and workplace in English', async () => {
  const res = await runChat({ name: 'Samira Ahmadi', company: 'Stantec', profession: 'Engineer' });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.draft.name, 'Samira Ahmadi');
  assert.equal(res.body.draft.company, 'Stantec');
  assert.ok(!res.body.missing.includes('company'));
});

test('onboarding saves name and workplace in Persian', async () => {
  const res = await runChat({ name: 'سمیرا احمدی', company: 'شرکت استنتک' });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.draft.name, 'سمیرا احمدی');
  assert.equal(res.body.draft.company, 'شرکت استنتک');
  assert.ok(!res.body.missing.includes('company'));
});

test('onboarding saves the LinkedIn link the mentor pastes (and ignores non-profile links)', async () => {
  let res = await runChat({ linkedin: 'linkedin.com/in/farhoud-asl-sabbagh-pour-84431218a/' });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  assert.equal(res.body.draft.linkedin, 'https://www.linkedin.com/in/farhoud-asl-sabbagh-pour-84431218a');
  res = await runChat({ linkedin: 'https://www.linkedin.com/company/workar' });
  assert.equal(res.body.draft.linkedin, undefined);
});
