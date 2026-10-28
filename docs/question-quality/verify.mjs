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
let total = 0;
let candidates = 0;
let totalRate = 0;
for (const source of json('sources.json')) {
  const expectedInput = `document_type: ${source.documentType}\nsession_entropy: ${meta.nonce}\n\n抜粋:\n--- 抜粋 1 (PDF p.${source.pdfPage}) ---\n${source.content}\n`;
  assert.equal(read(`${source.id}.input.txt`), expectedInput);
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
    rate += values.reduce((a, b) => a + b, 0) / (values.length * 3) * 100;
    candidates += Number(values.every(v => v >= 2));
    total++;
  }
  totalRate += rate / questions.length;
  console.log(`${source.id}: ${questions.length} questions; mean ${(rate / questions.length).toFixed(2)}%`);
}
console.log(`Total ${total}; candidates ${candidates}; equal-source mean ${(totalRate / json('sources.json').length).toFixed(2)}%`);
