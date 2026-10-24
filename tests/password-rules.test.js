const test = require('node:test'); const assert = require('node:assert');
const fs = require('fs'); const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const src = html.match(/function pwStrong\(p\)\{[^\n]*\}/)[0];
const pwStrong = new Function(src + '; return pwStrong;')();
test('password rules match Supabase (10+ chars, letters and digits)', () => {
  assert.equal(pwStrong('abc12'), false);
  assert.equal(pwStrong('abcdefghij'), false);
  assert.equal(pwStrong('1234567890'), false);
  assert.equal(pwStrong('workar2026x'), true);
});
test('sign-in field does not demand the new length (old accounts can still sign in)', () => {
  assert.match(html, /\$\{auto==='new-password'\?'minlength="10"':''\}/);
});
test('server refuses weak passwords before creating the account', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'api', 'agents.js'), 'utf8');
  assert.match(js, /password\.length < 10/);
});
