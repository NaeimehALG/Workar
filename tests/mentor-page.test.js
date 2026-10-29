const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function load(rows, { ok = true, throws = false } = {}) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only-key';
  process.env.SITE_URL = 'https://www.workar.me';
  const calls = [];
  global.fetch = async url => { calls.push(String(url)); if (throws) throw new Error('down'); return { ok, json: async () => rows, text: async () => html }; };
  delete require.cache[require.resolve('../api/mentor-page.js')];
  return { handler: require('../api/mentor-page.js'), calls };
}
function res() {
  return { code: 0, body: '', headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; } };
}

test('a live mentor gets their own title, description, photo and canonical URL, all escaped', async () => {
  const { handler, calls } = load([{ id: 'abc-123', name: 'Sara <b>"A"</b>', headline: 'Senior PM | Stantec', bio: 'I help engineers <script>x</script> move into PM.', avatarUrl: 'https://cdn.example/p.jpg' }]);
  const r = res(); await handler({ query: { id: 'abc-123' }, headers: {} }, r);
  assert.equal(r.code, 200);
  assert.match(calls[0], /approved=not\.is\.false/); assert.match(calls[0], /banned=not\.is\.true/); assert.match(calls[0], /role=eq\.mentor/);
  assert.match(r.body, /<title>Sara &lt;b&gt;&quot;A&quot;&lt;\/b&gt; · Senior PM \| Stantec · Workar<\/title>/);
  assert.match(r.body, /<link rel="canonical" href="https:\/\/www\.workar\.me\/mentor\/abc-123">/);
  assert.match(r.body, /<meta property="og:image" content="https:\/\/cdn\.example\/p\.jpg">/);
  assert.ok(!/<script>x<\/script>/.test(r.body));
  assert.ok(!/og:image:width/.test(r.body));
  assert.match(r.body, /application\/ld\+json/);
});

test('a photo that is not https falls back to the site image', async () => {
  const { handler } = load([{ id: 'abc', name: 'Sam', avatarUrl: 'javascript:alert(1)' }]);
  const r = res(); await handler({ query: { id: 'abc' }, headers: {} }, r);
  assert.match(r.body, /<meta property="og:image" content="https:\/\/www\.workar\.me\/og-image\.jpg\?v=2">/);
});

test('unknown, hidden or invalid mentors and database errors serve the plain page', async () => {
  for (const [rows, opts, id] of [[[], {}, 'nobody'], [[], { ok: false }, 'abc'], [null, { throws: true }, 'abc'], [[{ id: 'x', name: 'X' }], {}, '../etc']]) {
    const { handler } = load(rows, opts);
    const r = res(); await handler({ query: { id }, headers: {} }, r);
    if (opts.throws) { assert.ok(r.code === 200 || r.code === 302); continue; }
    assert.equal(r.code, 200);
    assert.match(r.body, /<title>Workar · One-on-One Career Mentoring<\/title>/);
  }
});

test('the mentor sitemap lists live mentors only by their clean URL', async () => {
  const { handler, calls } = load([{ id: 'a1' }, { id: 'b-2' }, { id: 'bad id' }]);
  const r = res(); await handler({ query: { sitemap: '1' }, headers: {} }, r);
  assert.equal(r.code, 200);
  assert.match(calls[0], /approved=not\.is\.false/);
  assert.match(r.body, /<loc>https:\/\/www\.workar\.me\/mentor\/a1<\/loc>/);
  assert.match(r.body, /<loc>https:\/\/www\.workar\.me\/mentor\/b-2<\/loc>/);
  assert.ok(!/bad id/.test(r.body));
});
