const test = require('node:test');
const assert = require('node:assert');
const AP = require('../api/_autopilot');

test('auto-filled details: only empty ones, only allowed values', () => {
  const p = { id: 'z', bio: 'x'.repeat(100), field: '', seniority: null, industries: null, skills: null, helpsWith: [] };
  const out = AP._detailsClean({ id: 'z', field: 'Technology & Data', seniority: 'mid-level', industries: ['Software', 'Software', ''],
    skills: ['Software engineering', 'Data science'], helpsWith: ['career_switch', 'made_up_service'] }, p);
  assert.deepEqual(out, { field: 'Technology & Data', seniority: 'mid-level', industries: ['Software'], skills: ['Software engineering', 'Data science'], helpsWith: ['career_switch'] });
});

test('auto-filled details never overwrite what the mentor chose', () => {
  const p = { id: 'a', field: 'Engineering', seniority: 'senior', industries: ['Utilities'], skills: ['Grid'], helpsWith: ['leadership'] };
  assert.deepEqual(AP._detailsClean({ field: 'Other', seniority: 'executive', industries: ['X'], skills: ['Y'], helpsWith: ['resume_review'] }, p), {});
});

test('unknown field or seniority values are dropped', () => {
  const p = { id: 'b', field: null, seniority: '' };
  assert.deepEqual(AP._detailsClean({ field: 'Tech', seniority: 'junior' }, p), {});
});

test('resume fill: only empty fields, bio only when missing, no invented shapes', () => {
  const p = { id: 'r', name: 'R', headline: 'Engineer', profession: '', company: 'Acme', bio: 'short', experience: '', degree: '', university: '', certifications: [], languages: ['English'] };
  const out = AP._resumeClean({ headline: 'Other', profession: 'Software Engineer', company: 'Other Co', yearsExperience: '7',
    degree: 'B.Sc. Computer Science', university: 'UBC', certifications: ['AWS Certified', 'AWS Certified'], languages: ['French'], bio: 'I am a software engineer. '.repeat(5) }, p);
  assert.equal(out.headline, undefined);          // already filled by the mentor
  assert.equal(out.company, undefined);
  assert.equal(out.languages, undefined);
  assert.equal(out.profession, 'Software Engineer');
  assert.equal(out.experience, '7');
  assert.equal(out.education, 'B.Sc. Computer Science, UBC');
  assert.deepEqual(out.certifications, ['AWS Certified']);
  assert.ok(out.bio.length >= 80);
});

test('resume fill never replaces a real bio', () => {
  const p = { id: 's', bio: 'x'.repeat(200), experience: '5', headline: 'h', profession: 'p', company: 'c', degree: 'd', university: 'u', certifications: ['a'], languages: ['English'] };
  assert.deepEqual(AP._resumeClean({ bio: 'y'.repeat(200), yearsExperience: 9 }, p), {});
});

test('resume files are only read from plain "<owner>/<file>" paths', async () => {
  const { resumeBlock } = require('../api/agents');
  const saved = global.fetch; let called = 0;
  global.fetch = async () => { called++; return { ok: false }; };
  try {
    for (const bad of ['../../../auth/v1/admin/users', 'abc/../other/cv.pdf', 'cv.pdf', 'abc//cv.pdf', 'abc/./cv.pdf']) {
      await assert.rejects(resumeBlock(bad), /file-not-found/);
    }
    assert.equal(called, 0);
  } finally { global.fetch = saved; }
});

test('the optional fill steps stop when the time limit is near', async () => {
  const AP = require('../api/_autopilot');
  const saved = global.fetch; let called = 0;
  global.fetch = async () => { called++; return { ok: true, json: async () => [] }; };
  process.env.ANTHROPIC_API_KEY = 'k';
  try {
    await AP.fillFromResume([{ id: 'u1', resumePath: 'u1/cv.pdf', bio: '' }], { deadline: Date.now() + 1000 });
    await AP.fillFromResume([{ id: 'u2', resumePath: 'someone-else/cv.pdf', bio: '' }], {});
    assert.equal(called, 0);
  } finally { global.fetch = saved; }
});
