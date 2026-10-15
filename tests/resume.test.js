const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

test('resume reader extracts text from a real .docx', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-'));
  const file = path.join(dir, 'cv.docx');
  const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Jane Doe</w:t></w:r></w:p><w:p><w:r><w:t>Data Analyst &amp; Engineer</w:t><w:tab/><w:t>2019</w:t></w:r></w:p></w:body></w:document>';
  // Build the zip with Python's zipfile so the archive layout matches what Word writes.
  execFileSync('python3', ['-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)
z.writestr('[Content_Types].xml','<Types/>')
z.writestr('word/document.xml',sys.argv[2])
z.close()`, file, xml]);
  const { docxText } = require('../api/agents');
  assert.equal(docxText(fs.readFileSync(file)), 'Jane Doe\nData Analyst & Engineer\t2019');
  assert.equal(docxText(Buffer.from('not a zip')), '');
});
