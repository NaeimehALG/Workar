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
    const m = await AP._assess([p]);
    assert.equal(m.u1 && m.u1.verdict, 'approve', JSON.stringify(ans));
  }
});
