// Sign in with LinkedIn: the photo is copied into Workar storage and the profile is marked verified.
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('linkedin_photo copies the LinkedIn picture and marks the profile verified', async () => {
  const mailPath = require.resolve('../api/_mail'), agPath = require.resolve('../api/agents');
  const realM = require('../api/_mail');
  const patched = [], uploads = [];
  require.cache[mailPath].exports = Object.assign({}, realM, {
    userFromToken: async () => ({ id: 'u1', email: 'u1@x.test' }),
    rows: async () => [{ id: 'u1', name: '', avatarUrl: null, linkedinVerified: false }],
    patch: async (p, b) => { patched.push(b); return { ok: true }; }
  });
  delete require.cache[agPath];
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  const savedFetch = global.fetch;
  global.fetch = async (url, o = {}) => {
    url = String(url);
    if (url.includes('/auth/v1/admin/users/')) return { ok: true, json: async () => ({ identities: [{ provider: 'linkedin_oidc', identity_data: { name: 'Nora A', picture: 'https://media.licdn.com/p.jpg' } }] }) };
    if (url.startsWith('https://media.licdn.com/')) return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    if (url.includes('/storage/v1/object/avatars/')) { uploads.push(url); return { ok: true, text: async () => '' }; }
    return { ok: true, json: async () => ({}), text: async () => '' };
  };
  try {
    const handler = require('../api/agents');
    let out = null, code = 0;
    const res = { status(c) { code = c; return this; }, json(j) { out = j; return this; }, end() { return this; } };
    await handler({ method: 'POST', headers: { authorization: 'Bearer t' }, body: { task: 'linkedin_photo' } }, res);
    assert.equal(code, 200);
    assert.equal(out.verified, true);
    assert.equal(uploads.length, 1);
    assert.equal(patched[0].linkedinVerified, true);
    assert.equal(patched[0].name, 'Nora A');
    assert.match(patched[0].avatarUrl, /\/storage\/v1\/object\/public\/avatars\/u1\/linkedin-\d+\.jpg$/);
  } finally { global.fetch = savedFetch; delete require.cache[agPath]; delete require.cache[mailPath]; }
});
