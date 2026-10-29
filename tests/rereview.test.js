// A live mentor who edited their profile is re-checked: approval says "updates are live", a failed check goes to the admin.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('edited live mentor profiles: updates-live email on approve, admin to-do on decline', async () => {
  const mailPath = require.resolve('../api/_mail'), aiPath = require.resolve('../api/_ai'), apPath = require.resolve('../api/_autopilot');
  const realM = require('../api/_mail'), realAi = require('../api/_ai');
  const base = { role: 'mentor', approved: false, headline: 'Senior PM', bio: 'x'.repeat(120), experience: '8', company: 'Acme', languages: ['English'], avatarUrl: 'https://x.test/a.jpg' };
  const ok = Object.assign({ id: 'o', name: 'Ok Mentor', linkedin: 'https://linkedin.com/in/ok-mentor' }, base);
  const no = Object.assign({ id: 'n', name: 'No Mentor', linkedin: 'https://linkedin.com/in/no-mentor' }, base);
  const sent = [];
  require.cache[mailPath].exports = Object.assign({}, realM, {
    rows: async () => [ok, no],
    rowsStrict: async path => /agent_events\?id=eq\.rereview/.test(path) ? [{ id: decodeURIComponent(path.split('id=eq.')[1].split('&')[0]) }] : (/^profiles/.test(path) ? [ok, no] : []),
    patch: async () => ({ ok: true }), emailOf: async id => id + '@x.test',
    sendMail: async (to, subject) => { sent.push({ to, subject }); return { ok: true }; }
  });
  require.cache[aiPath].exports = Object.assign({}, realAi, { askJSON: async () => [{ id: 'o', verdict: 'approve', summary: 'fine' }, { id: 'n', verdict: 'decline', summary: 'fake' }] });
  delete require.cache[apPath];
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'; process.env.ANTHROPIC_API_KEY = 'k';
  const savedFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => [{ id: 'new' }], text: async () => '' });
  try {
    const AP = require('../api/_autopilot');
    const rep = { done: [], needs: [], emails: 0, errors: [] };
    await AP.mentorApplications(rep, { approvedNow: 99 });            // daily cap reached: re-reviews are not capped
    assert.ok(sent.some(m => m.to === 'o@x.test' && /updates are live/.test(m.subject)));
    assert.ok(!sent.some(m => /Welcome|live$/.test(m.subject) && m.to === 'o@x.test' && !/updates/.test(m.subject)));
    assert.ok(!sent.some(m => m.to === 'n@x.test'));                     // no email to the mentor on a failed check
    assert.ok(rep.needs.some(n => /No Mentor/.test(n.text)));            // the admin decides
  } finally { global.fetch = savedFetch; delete require.cache[apPath]; delete require.cache[mailPath]; delete require.cache[aiPath]; }
});
