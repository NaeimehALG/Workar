// Mentor applications are decided by the AI alone: nothing is left waiting for the admin.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const withStrict = m => Object.assign(m, { rowsStrict: m.rows });

test('every AI verdict ends in an action, never an admin to-do', async () => {
  const mailPath = require.resolve('../api/_mail'), aiPath = require.resolve('../api/_ai'), apPath = require.resolve('../api/_autopilot');
  const realM = require('../api/_mail'), realAi = require('../api/_ai');
  const good = { id: 'g', name: 'Good Mentor', role: 'mentor', approved: false, headline: 'Senior PM', bio: 'x'.repeat(120), linkedin: 'https://linkedin.com/in/good-mentor', experience: '8', company: 'Acme' };
  const thin = { id: 't', name: 'Thin Mentor', role: 'mentor', approved: false, headline: 'PM', bio: 'short', linkedin: '', experience: '1' };
  const bad = { id: 'b', name: 'Bad Mentor', role: 'mentor', approved: false, headline: 'x', bio: 'y'.repeat(100), linkedin: 'https://linkedin.com/in/bad-mentor', experience: '5', company: 'Z' };
  const banned = Object.assign({}, good, { id: 'x', banned: true, linkedin: 'https://linkedin.com/in/banned-one' });
  const patched = [], sent = [];
  require.cache[mailPath].exports = withStrict(Object.assign({}, realM, {
    rows: async () => [good, thin, bad, banned], patch: async (p, b) => { patched.push({ p, b }); return { ok: true }; },
    emailOf: async id => id + '@x.test', sendMail: async (to, subject) => { sent.push({ to, subject }); return { ok: true }; }
  }));
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
    assert.ok(sent.some(m => m.to === 't@x.test' && /almost ready/.test(m.subject))); // thin profile is asked for details
    assert.ok(!sent.some(m => m.to === 'b@x.test')); // declined silently: no email to the applicant
    assert.ok(!sent.some(m => m.to === 'x@x.test'));                              // banned accounts are skipped
  } finally { global.fetch = savedFetch; delete require.cache[apPath]; delete require.cache[mailPath]; delete require.cache[aiPath]; }
});

test('mentors need their own personal LinkedIn profile', () => {
  const AP = require('../api/_autopilot');
  assert.equal(AP.linkedInSlug('linkedin.com/in/Jane-Doe/'), 'jane-doe');
  assert.equal(AP.linkedInSlug('https://ca.linkedin.com/in/jane-doe?trk=x'), 'jane-doe');
  assert.equal(AP.linkedInSlug('https://www.linkedin.com/company/workarmentoring/'), '');
  assert.equal(AP.linkedInSlug('https://linkedin.com/'), '');
  assert.equal(AP.linkedInSlug('https://notlinkedin.com/in/jane'), '');
  const base = { name: 'A', role: 'mentor', headline: 'PM', bio: 'x'.repeat(100), experience: '6', company: 'Acme' };
  const a = { ...base, id: 'a', linkedin: 'https://www.linkedin.com/in/jane-doe' };
  const b = { ...base, id: 'b', linkedin: 'linkedin.com/in/JANE-DOE/' };
  assert.deepEqual(AP.missingBasics(a, [a]), []);
  assert.ok(AP.missingBasics(b, [a, b]).some(m => /already used/.test(m)));
  assert.ok(AP.missingBasics({ ...base, id: 'c', linkedin: 'https://linkedin.com/company/acme' }).some(m => /LinkedIn/.test(m)));
});

test('a new application is reviewed right away and only that applicant is touched', async () => {
  const mailPath = require.resolve('../api/_mail'), aiPath = require.resolve('../api/_ai'), apPath = require.resolve('../api/_autopilot');
  const realM = require('../api/_mail'), realAi = require('../api/_ai');
  const noLi = { id: 'n', name: 'No LinkedIn', role: 'mentor', approved: false, headline: 'Analyst', bio: 'z'.repeat(120), linkedin: '', experience: '18', company: 'Carsan' };
  const queries = [], sent = [], patched = [];
  require.cache[mailPath].exports = withStrict(Object.assign({}, realM, {
    rows: async q => { queries.push(q); return q.startsWith('profiles?role=eq.mentor&approved=eq.false') ? [noLi] : []; },
    patch: async (p, b) => { patched.push(b); return { ok: true }; },
    emailOf: async id => id + '@x.test', sendMail: async (to, subject) => { sent.push({ to, subject }); return { ok: true }; }
  }));
  require.cache[aiPath].exports = Object.assign({}, realAi, { askJSON: async () => [{ id: 'n', verdict: 'approve', summary: 'Strong' }] });
  delete require.cache[apPath];
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'; process.env.ANTHROPIC_API_KEY = 'k';
  const savedFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => [{ id: 'new' }], text: async () => '' });
  try {
    const AP = require('../api/_autopilot');
    const out = await AP.reviewOne('n');
    assert.ok(queries.some(q => q.includes('&id=eq.n')));
    assert.equal(out.verdict, 'ask');                       // the AI liked it, but a missing LinkedIn always blocks approval
    assert.match(out.question, /LinkedIn/);
    assert.deepEqual(patched, []);
    assert.ok(sent.some(m => m.to === 'n@x.test' && /almost ready/.test(m.subject)));
  } finally { global.fetch = savedFetch; delete require.cache[apPath]; delete require.cache[mailPath]; delete require.cache[aiPath]; }
});

test('a missing LinkedIn is still asked for when the AI review is unavailable', async () => {
  const mailPath = require.resolve('../api/_mail'), aiPath = require.resolve('../api/_ai'), apPath = require.resolve('../api/_autopilot');
  const realM = require('../api/_mail'), realAi = require('../api/_ai');
  const noLi = { id: 'n', name: 'No LinkedIn', role: 'mentor', approved: false, headline: 'Analyst', bio: 'z'.repeat(120), linkedin: '', experience: '18', company: 'Carsan' };
  const done = { id: 'd', name: 'Complete', role: 'mentor', approved: false, headline: 'PM', bio: 'y'.repeat(120), linkedin: 'https://linkedin.com/in/complete-one', experience: '9', company: 'Acme' };
  const sent = [], patched = [];
  require.cache[mailPath].exports = withStrict(Object.assign({}, realM, {
    rows: async q => q.startsWith('profiles?role=eq.mentor&approved=eq.false') ? [noLi, done] : [],
    patch: async (p, b) => { patched.push(b); return { ok: true }; },
    emailOf: async id => id + '@x.test', sendMail: async (to, subject) => { sent.push({ to, subject }); return { ok: true }; }
  }));
  require.cache[aiPath].exports = Object.assign({}, realAi, { askJSON: async () => { throw new Error('AI down'); } });
  delete require.cache[apPath];
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'; process.env.ANTHROPIC_API_KEY = 'k';
  const savedFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => [{ id: 'new' }], text: async () => '' });
  try {
    const AP = require('../api/_autopilot');
    const rep = { done: [], needs: [], emails: 0, errors: [] };
    await AP.mentorApplications(rep, {});
    assert.ok(sent.some(m => m.to === 'n@x.test' && /almost ready/.test(m.subject))); // asked for LinkedIn anyway
    assert.ok(!sent.some(m => m.to === 'd@x.test'));                                  // complete profile waits for the AI
    assert.equal(patched.length, 0);                                                    // nobody approved without the AI
  } finally { global.fetch = savedFetch; delete require.cache[apPath]; delete require.cache[mailPath]; delete require.cache[aiPath]; }
});

test('an unchanged profile keeps its earlier verdict and is not sent to the AI again', async () => {
  const mailPath = require.resolve('../api/_mail'), aiPath = require.resolve('../api/_ai'), apPath = require.resolve('../api/_autopilot');
  const realM = require('../api/_mail'), realAi = require('../api/_ai');
  const app = { id: 'd', name: 'Declined', role: 'mentor', approved: false, headline: 'PM', bio: 'q'.repeat(120), linkedin: 'https://linkedin.com/in/declined-one', experience: '9', company: 'Acme' };
  const events = [], sent = [], patched = []; let aiCalls = 0;
  require.cache[mailPath].exports = withStrict(Object.assign({}, realM, {
    rows: async q => q.startsWith('profiles?role=eq.mentor&approved=eq.false') ? [Object.assign({}, app)] : q.startsWith('agent_events?kind=eq.verdict') ? events.slice() : [],
    patch: async (p, b) => { patched.push(b); return { ok: true }; },
    emailOf: async id => id + '@x.test', sendMail: async (to, subject) => { sent.push({ to, subject }); return { ok: true }; }
  }));
  require.cache[aiPath].exports = Object.assign({}, realAi, { askJSON: async () => { aiCalls++; return aiCalls === 1 ? [{ id: 'd', verdict: 'decline', summary: 'no' }] : [{ id: 'd', verdict: 'approve', summary: 'yes' }]; } });
  delete require.cache[apPath];
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'; process.env.ANTHROPIC_API_KEY = 'k';
  const savedFetch = global.fetch;
  global.fetch = async (url, o) => {
    if (o && o.method === 'POST' && String(url).includes('agent_events')) { const b = JSON.parse(o.body); if (b.kind === 'verdict') events.push({ id: b.id, ref: b.ref }); }
    return { ok: true, json: async () => [{ id: 'new' }], text: async () => '' };
  };
  try {
    const AP = require('../api/_autopilot');
    await AP.mentorApplications({ done: [], needs: [], emails: 0, errors: [] }, {});
    await AP.mentorApplications({ done: [], needs: [], emails: 0, errors: [] }, {});
    assert.equal(aiCalls, 1);            // second run reused the stored verdict
    assert.equal(patched.length, 0);     // and did not flip to an approval
    app.bio = 'r'.repeat(130);           // the mentor edits their profile
    await AP.mentorApplications({ done: [], needs: [], emails: 0, errors: [] }, {});
    assert.equal(aiCalls, 2);            // a changed profile is reviewed again
  } finally { global.fetch = savedFetch; delete require.cache[apPath]; delete require.cache[mailPath]; delete require.cache[aiPath]; }
});
