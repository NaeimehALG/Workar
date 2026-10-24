// Every email to a user is BCC'd to the admin, except sign-in emails and emails already sent to the team.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('admin gets a hidden copy of user emails, but not of sign-in emails', async () => {
  const sent = [], savedFetch = global.fetch;
  process.env.RESEND_API_KEY = 'k'; process.env.ADMIN_EMAIL = 'boss@x.test'; process.env.WORKAR_CONTACT_EMAIL = 'team@x.test'; delete process.env.COPY_ALL_EMAILS_TO;
  global.fetch = async (url, o) => { sent.push(JSON.parse(o.body)); return { ok: true, text: async () => '' }; };
  try {
    delete require.cache[require.resolve('../api/_mail')];
    const M = require('../api/_mail');
    await M.sendMail('mentor@x.test', 'Your profile is live', '<p>hi</p>');
    await M.sendMail('mentor@x.test', 'Confirm your email', '<p>link</p>', null, { noCopy: true });
    await M.sendMail('boss@x.test', 'Your Workar day', '<p>digest</p>');
    assert.deepEqual(sent[0].bcc, ['team@x.test']);
    assert.equal(sent[1].bcc, undefined);
    assert.equal(sent[2].bcc, undefined);
  } finally { global.fetch = savedFetch; delete process.env.RESEND_API_KEY; delete process.env.WORKAR_CONTACT_EMAIL; delete require.cache[require.resolve('../api/_mail')]; }
});
