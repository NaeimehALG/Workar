const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

test('backup runs only on Sundays unless forced', async () => {
  const B = require('../api/_backup');
  assert.strictEqual(B.isBackupDay(new Date('2026-10-18T15:00:00Z')), true);
  assert.strictEqual(B.isBackupDay(new Date('2026-10-17T15:00:00Z')), false);
  const out = await B.run([], { now: new Date('2026-10-17T15:00:00Z') });
  assert.strictEqual(out.backup, 'not today');
});

test('backup emails a gzipped copy of every table and the member emails', async () => {
  process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'; process.env.RESEND_API_KEY = 'r';
  let mail;
  global.fetch = async (url, opts) => {
    if (url.includes('resend')) { mail = JSON.parse(opts.body); return { ok: true, json: async () => ({}) }; }
    if (url.includes('/auth/v1/admin/users')) return { ok: true, json: async () => ({ users: [{ id: 'u1', email: 'a@b.c' }, { id: 'anon', is_anonymous: true }] }) };
    if (url.includes('/rest/v1/profiles')) return { ok: true, json: async () => [{ id: 'u1', name: 'Nora' }] };
    if (url.includes('/rest/v1/exams?')) return { ok: false, status: 404 };
    return { ok: true, json: async () => [] };
  };
  delete require.cache[require.resolve('../api/_backup')];
  const B = require('../api/_backup');
  const problems = [];
  const out = await B.run(problems, { force: true });
  assert.deepStrictEqual(problems, []);
  assert.ok(out.backupKB >= 1);
  assert.match(mail.subject, /Workar weekly backup/);
  const data = JSON.parse(zlib.gunzipSync(Buffer.from(mail.attachments[0].content, 'base64')));
  assert.deepStrictEqual(data.tables.profiles, [{ id: 'u1', name: 'Nora' }]);
  assert.strictEqual(data.tables.exams, undefined);
  assert.deepStrictEqual(data.members.map(m => m.id), ['u1']);
});
