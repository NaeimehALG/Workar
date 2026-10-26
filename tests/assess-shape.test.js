const test = require('node:test'); const assert = require('node:assert');
const AI = require('../api/_ai');
function load(answer) {
  AI.askJSON = async () => answer;
  delete require.cache[require.resolve('../api/_autopilot')];
  return require('../api/_autopilot');
}
test('a single-object or wrapped AI answer still gives a verdict', async () => {
  process.env.ANTHROPIC_API_KEY = 'x';
  const p = { id: 'u1', name: 'A' };
  for (const ans of [{ id: 'u1', verdict: 'approve' }, { applications: [{ id: 'u1', verdict: 'approve' }] }, [{ id: 'wrong', verdict: 'approve' }], [{ id: 'u1', verdict: 'approve' }]]) {
    const AP = load(ans);
    const m = (await AP._assess([p])).map;
    assert.equal(m.u1 && m.u1.verdict, 'approve', JSON.stringify(ans));
  }
});
test('a failed AI call is reported, not silently dropped', async () => {
  process.env.ANTHROPIC_API_KEY = 'x';
  AI.askJSON = async () => { throw new Error('timeout'); };
  delete require.cache[require.resolve('../api/_autopilot')];
  const AP = require('../api/_autopilot');
  const r = await AP._assess([{ id: 'u1' }]);
  assert.deepEqual(r.map, {});
  assert.match(r.error, /failed/);
});
test('reviews go to the AI in small batches', async () => {
  process.env.ANTHROPIC_API_KEY = 'x';
  let calls = 0;
  AI.askJSON = async (sys, txt) => { calls++; return JSON.parse(txt).map(x => ({ id: x.id, verdict: 'ask' })); };
  delete require.cache[require.resolve('../api/_autopilot')];
  const AP = require('../api/_autopilot');
  const apps = Array.from({ length: 9 }, (_, i) => ({ id: 'u' + i }));
  const r = await AP._assess(apps);
  assert.equal(Object.keys(r.map).length, 9);
  assert.equal(calls, 3);
});
