// LinkedIn queue → Typefully, with mocks. Nothing is sent without TYPEFULLY_API_KEY; late posts are skipped.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../api/_linkedin');

test('picks the Workar social set', () => {
  assert.equal(L.pickSocialSet({ results: [{ id: 1, name: 'Naeimeh' }, { id: 2, name: 'Workar' }] }), 2);
  assert.equal(L.pickSocialSet({ results: [{ id: 7, name: 'Only one' }] }), 7);
  assert.equal(L.pickSocialSet({ results: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] }), null);
});

test('queued posts become scheduled Typefully drafts with their image; late ones are skipped', async () => {
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'; process.env.TYPEFULLY_API_KEY = 'tk';
  delete process.env.TYPEFULLY_SOCIAL_SET_ID;
  const future = new Date(Date.now() + 3 * 3600e3).toISOString(), past = new Date(Date.now() - 3600e3).toISOString();
  const rows = [{ id: 'a', publishAt: future, text: 'Tip of the day', imageUrl: 'https://workar.me/social/a.png', altText: 'x', format: 'image' },
                { id: 'b', publishAt: future, text: 'Question?', format: 'text' }, { id: 'c', publishAt: past, text: 'late' }, { id: 'z', publishAt: new Date(Date.now() + 5 * 24 * 3600e3).toISOString(), text: 'next week' }];
  const calls = [], patches = [];
  const saved = global.fetch;
  global.fetch = async (url, opt = {}) => {
    url = String(url); calls.push({ url, opt });
    const j = (b, s = 200) => ({ ok: s < 300, status: s, json: async () => b, arrayBuffer: async () => new ArrayBuffer(4) });
    if (url.includes('/linkedin_queue?status=eq.queued')) return j(rows);
    if (url.includes('/profiles?select=name')) return j([{ name: 'Sara Ahmadi' }]);
    if (url.includes('/linkedin_queue?id=eq.')) { patches.push({ id: decodeURIComponent(url.split('id=eq.')[1]), body: JSON.parse(opt.body) }); return j({}); }
    if (url.endsWith('/social-sets?limit=50')) return j({ results: [{ id: 's1', name: 'Workar' }] });
    if (url.endsWith('/media/upload')) return j({ media_id: 'm1', upload_url: 'https://upload.test/x' }, 201);
    if (url.startsWith('https://upload.test')) return j({});
    if (url.includes('/media/m1')) return j({ status: 'ready' });
    if (url.startsWith('https://workar.me/social/')) return j({});
    if (url.endsWith('/drafts')) return j({ id: 'd' + calls.length }, 201);
    return j({}, 404);
  };
  try {
    const problems = [];
    const out = await L.run(problems);
    assert.equal(out.linkedinScheduled, 2);
    assert.equal(problems.length, 1); assert.match(problems[0], /already passed/);   // the skipped late post is reported
    const drafts = calls.filter(c => c.url.endsWith('/drafts')).map(c => JSON.parse(c.opt.body));
    assert.deepEqual(drafts[0].platforms.linkedin.posts[0].media_ids, ['m1']);
    assert.equal(drafts[1].platforms.linkedin.posts[0].media_ids, undefined);
    assert.equal(drafts[0].publish_at, future);
    assert.equal(patches.find(p => p.id === 'c').body.status, 'skipped');
    assert.equal(patches.filter(p => p.body.status === 'scheduled').length, 2);
    assert.ok(!patches.some(p => p.id === 'z'));   // a later post waits in the queue
    delete process.env.TYPEFULLY_API_KEY;
    calls.length = 0;
    assert.deepEqual(await L.run([]), { linkedinScheduled: 0 }); assert.equal(calls.length, 0);
  } finally { global.fetch = saved; }
});
