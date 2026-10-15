// Mentor applications are decided by the AI alone: nothing is left waiting for the admin.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('every AI verdict ends in an action, never an admin to-do', async () => {
  const mailPath = require.resolve('../api/_mail'), aiPath = require.resolve('../api/_ai'), apPath = require.resolve('../api/_autopilot');
  const realM = require('../api/_mail'), realAi = require('../api/_ai');
  const good = { id: 'g', name: 'Good Mentor', role: 'mentor', approved: false, headline: 'Senior PM', bio: 'x'.repeat(120), linkedin: 'https://linkedin.com/in/g', experience: '8', company: 'Acme' };
  const thin = { id: 't', name: 'Thin Mentor', role: 'mentor', approved: false, headline: 'PM', bio: 'short', linkedin: '', experience: '1' };
  const bad = { id: 'b', name: 'Bad Mentor', role: 'mentor', approved: false, headline: 'x', bio: 'y'.repeat(100), linkedin: 'https://linkedin.com/in/b', experience: '5', company: 'Z' };
  const banned = Object.assign({}, good, { id: 'x', banned: true });
  const patched = [], sent = [];
  require.cache[mailPath].exports = Object.assign({}, realM, {
    rows: async () => [good, thin, bad, banned], patch: async (p, b) => { patched.push({ p, b }); return { ok: true }; },
    emailOf: async id => id + '@x.test', sendMail: async (to, subject) => { sent.push({ to, subject }); return { ok: true }; }
  });
  require.cache[aiPath].exports = Object.assign({}, realAi, { askJSON: async () => [
    { id: 'g', verdict: 'approve', summary: 'Strong' }, { id: 't', verdict: 'approve', summary: 'ok' }, { id: 'b', verdict: 'decline', summary: 'Copy-paste bio' }, { id: 'x', verdict: 'approve' }] });
  delete require.cache[apPath];
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'; process.env.ANTHROPIC_API_KEY = 'k';
  const savedFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => [{ id: 'new' }], text: async () => '' });
  try {
    const AP = require('../api/_autopilot');
    assert.ok(AP.missingBasics(thin).length >= 3);
    assert.deepEqual(AP.missingBasics(good), []);
    const rep = { done: [], needs: [], emails: 0, errors: [] };
    await AP.mentorApplications(rep, {});
    assert.equal(rep.needs.length, 0);
    assert.deepEqual(patched.map(x => x.b), [{ approved: true }]);              // only the good one goes live
    assert.ok(patched[0].p.includes('id=eq.g'));
    assert.ok(sent.some(m => m.to === 't@x.test' && /question/.test(m.subject))); // thin profile is asked for details
    assert.ok(sent.some(m => m.to === 'b@x.test' && /application/.test(m.subject))); // declined politely
    assert.ok(!sent.some(m => m.to === 'x@x.test'));                              // banned accounts are skipped
  } finally { global.fetch = savedFetch; delete require.cache[apPath]; delete require.cache[mailPath]; delete require.cache[aiPath]; }
});
