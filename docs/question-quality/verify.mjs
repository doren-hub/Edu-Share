// Offline consistency check. No API, environment file, DB, or storage access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { excerptAppearsInJoined } from '../../src/lib/source-excerpt.ts';
const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');
const json = (name) => JSON.parse(read(name));
const meta = json('generation.json');
assert.equal(createHash('sha256').update(read('system-prompt.txt').trimEnd()).digest('hex'), meta.systemSha256);
const scores = json('scores.json');
const baseline = read('baseline.md');
const summary = baseline.split('## 集計\n')[1]?.split('\n## ')[0];
assert.ok(summary, 'saved summary section');
let total = 0;
let candidates = 0;
let totalRate = 0;
let majorDefects = 0;
for (const source of json('sources.json')) {
  // The archive adds exactly one LF; the CLI input and app user string do not.
  const expectedInput = `document_type: ${source.documentType}\nsession_entropy: ${meta.nonce}\n\n抜粋:\n--- 抜粋 1 (PDF p.${source.pdfPage}) ---\n${source.content}`;
  const savedInput = read(`${source.id}.input.txt`);
  assert.ok(savedInput.endsWith('\n'), `${source.id}: archive final LF`);
  const cliInput = savedInput.slice(0, -1);
  assert.equal(cliInput, expectedInput, `${source.id}: reconstructed CLI input / app user`);
  const response = json(`${source.id}.response.json`);
  assert.equal(response.is_error, false);
  assert.ok(response.modelUsage[meta.model]);
  assert.equal(json(`${source.id}.execution.json`).exitCode, 0);
  const questions = JSON.parse(response.result);
  assert.ok(questions.length >= 6 && questions.length <= 9);
  assert.equal(new Set(questions.map(q => q.id)).size, questions.length);
  assert.equal(scores[source.id].length, questions.length);
  assert.ok(questions.some(q => q.type === 'essay'));
  assert.ok(questions.some(q => q.type === 'multiple_choice'));
  let rate = 0;
  let sourceMajorDefects = 0;
  for (const [index, q] of questions.entries()) {
    assert.ok(q.prompt.trim());
    assert.ok(excerptAppearsInJoined(q.sourceExcerpt, source.content), `${source.id} ${q.id}: excerpt`);
    const s = scores[source.id][index];
    assert.equal(s.id, q.id);
    assert.equal(s.type, q.type);
    if (q.type === 'multiple_choice') {
      assert.equal(q.options.length, 4);
      assert.ok(q.options.every(o => typeof o === 'string' && o.trim()));
      assert.ok(Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4);
      assert.ok(Number.isInteger(s.P));
    } else {
      assert.equal(q.type, 'essay');
      assert.ok(q.referenceAnswer.trim());
      assert.equal(s.P, null);
    }
    const values = ['S', 'U', 'D', 'P', 'L'].map(k => s[k]).filter(v => v !== null);
    assert.ok(values.every(v => Number.isInteger(v) && v >= 0 && v <= 3));
    // Count each question once, including when both S and U are <= 1.
    sourceMajorDefects += Number(s.S <= 1 || s.U <= 1);
    rate += values.reduce((a, b) => a + b, 0) / (values.length * 3) * 100;
    candidates += Number(values.every(v => v >= 2));
    total++;
  }
  totalRate += rate / questions.length;
  majorDefects += sourceMajorDefects;
  const summaryRows = summary.split('\n').filter(line => line.startsWith(`| ${source.id} |`));
  assert.equal(summaryRows.length, 1, `${source.id}: saved summary row`);
  const savedMajorDefects = summaryRows[0].split('|')[6].trim();
  assert.equal(String(sourceMajorDefects), savedMajorDefects, `${source.id}: saved major defects`);
  console.log(`${source.id}: ${questions.length} questions; mean ${(rate / questions.length).toFixed(2)}%; major defects ${sourceMajorDefects}`);
}
const savedTotal = summary.match(/重大欠陥は(\d+)\/(\d+)問/);
assert.ok(savedTotal, 'saved total major defects');
assert.equal(majorDefects, Number(savedTotal[1]), 'total saved major defects');
assert.equal(total, Number(savedTotal[2]), 'total saved questions');
console.log(`Total ${total}; major defects ${majorDefects}; candidates ${candidates}; equal-source mean ${(totalRate / json('sources.json').length).toFixed(2)}%`);
