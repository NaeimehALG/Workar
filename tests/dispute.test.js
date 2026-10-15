const { test } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../api/_dispute');

const meetings = [{ max_participants: 2, participants: [
  { user_name: 'Arash', join_time: Date.parse('2026-10-15T01:02:00Z') / 1000, duration: 28 * 60 },
  { user_name: 'Nora', join_time: Date.parse('2026-10-15T01:00:30Z') / 1000, duration: 29 * 60 }
] }];

test('Daily attendance is summarised per person with roles and lateness', () => {
  const a = D.summarizeMeetings(meetings, { mentor: 'Arash', client: 'Nora' });
  assert.equal(a.calls, 1); assert.equal(a.maxTogether, 2);
  const arash = a.people.find(p => p.name === 'Arash');
  assert.equal(arash.role, 'mentor'); assert.equal(arash.minutes, 28);
  const txt = D.attendanceText(a, '2026-10-15T01:00:00Z');
  assert.match(txt, /Arash \(mentor\): 28 min in the call, first joined 2 min after the start/);
  assert.match(txt, /Most people in the call at once: 2/);
  assert.equal(D.attendanceText(D.summarizeMeetings([], {}), null), 'Nobody joined the call room.');
  assert.equal(D.attendanceText({ available: false, note: 'Jitsi' }), 'Jitsi');
});

test('the daily job opens, waits for the mentor, then analyzes before the hold expires', () => {
  const now = Date.parse('2026-10-16T00:00:00Z'), h = 3600e3;
  const base = { problemReportedAt: '2026-10-15T02:00:00Z' };
  assert.equal(D.dueAction(Object.assign({}, base), now), 'open');
  assert.equal(D.dueAction(Object.assign({}, base, { disputeOpenedAt: new Date(now - 10 * h).toISOString(), holdCaptureBefore: new Date(now + 6 * 24 * h).toISOString() }), now), 'wait');
  assert.equal(D.dueAction(Object.assign({}, base, { disputeOpenedAt: new Date(now - 49 * h).toISOString() }), now), 'analyze');
  assert.equal(D.dueAction(Object.assign({}, base, { disputeOpenedAt: new Date(now - 10 * h).toISOString(), holdCaptureBefore: new Date(now + 30 * h).toISOString() }), now), 'analyze');
  assert.equal(D.dueAction(Object.assign({}, base, { disputeOpenedAt: 'x', disputeAnalyzedAt: 'y' }), now), 'none');
  assert.equal(D.dueAction(Object.assign({}, base, { problemResolvedAt: 'z' }), now), 'none');
});

test('open → mentor statement → AI review, end to end with mocks', async () => {
  const path = require('node:path');
  const mailPath = require.resolve('../api/_mail'), aiPath = require.resolve('../api/_ai'), dPath = require.resolve('../api/_dispute');
  const saved = { mail: require.cache[mailPath], ai: require.cache[aiPath], d: require.cache[dPath], fetch: global.fetch };
  const req = { id: 'r1', mentorId: 'm1', clientId: 'c1', startsAt: '2026-10-15T01:00:00Z', amountCents: 4000, problemReportedAt: '2026-10-15T02:00:00Z', problemNote: 'Mentor never joined', meetingUrl: 'https://meet.jit.si/x' };
  const stmts = [], sent = [], patches = [];
  const real = require('../api/_mail');
  require.cache[mailPath].exports = Object.assign({}, real, {
    rows: async q => q.startsWith('requests?') ? [Object.assign({}, req)] : q.startsWith('dispute_statements') ? stmts.slice() : [],
    profile: async id => ({ id, name: id === 'm1' ? 'Arash' : 'Nora' }), emailOf: async id => id + '@x.test',
    sendMail: async (to, subject) => { sent.push({ to, subject }); }
  });
  require.cache[aiPath].exports = { askJSON: async () => ({ summary: 'Both say the call did not happen.', happened: 'no', recommendation: 'refund', reason: 'Mentor agrees.', questions: [] }) };
  delete require.cache[dPath];
  global.fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    if (opts.method === 'PATCH') { patches.push(body); Object.assign(req, body); return { ok: true, json: async () => [req] }; }
    if (opts.method === 'POST') { stmts.push(Object.assign({ createdAt: new Date().toISOString() }, body)); return { ok: true }; }
    return { ok: true, json: async () => [] };
  };
  try {
    const D2 = require('../api/_dispute');
    assert.deepEqual(await D2.open(Object.assign({}, req)), { ok: true });
    assert.equal(stmts[0].role, 'client');
    assert.deepEqual(sent.map(s => s.to).sort(), ['c1@x.test', 'm1@x.test', 'workarmentoring@gmail.com']);
    assert.equal((await D2.statement({ id: 'stranger' }, 'r1', 'hi there')).status, 403);
    const res = await D2.statement({ id: 'm1' }, 'r1', 'Sorry, I had an emergency and could not join.');
    assert.equal(res.status, 200);
    assert.equal(req.disputeRecommendation, 'refund');
    assert.match(sent[sent.length - 1].subject, /Review ready: Nora → Arash \(refund\)/);
  } finally {
    require.cache[mailPath] = saved.mail; require.cache[aiPath] = saved.ai; delete require.cache[dPath]; global.fetch = saved.fetch;
  }
});
