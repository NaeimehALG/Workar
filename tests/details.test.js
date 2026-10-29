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
