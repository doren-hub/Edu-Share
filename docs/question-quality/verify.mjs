// Offline consistency check. No API, environment file, DB, or storage access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { excerptAppearsInJoined } from '../../src/lib/source-excerpt.ts';

export const parseCells = (line) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());

export const findUniqueHeaderIndex = (headerCells, name, aliases = [name]) => {
  const indices = headerCells
    .map((col, idx) => (aliases.includes(col) ? idx : -1))
    .filter((idx) => idx !== -1);
  if (indices.length === 0) {
    assert.fail(`saved summary table is missing "${name}" header`);
  }
  if (indices.length > 1) {
    assert.fail(`saved summary table has duplicate "${name}" header`);
  }
  return indices[0];
};

export const extractSummarySection = (baselineMarkdown) => {
  const summary = baselineMarkdown.split('## 集計\n')[1]?.split('\n## ')[0];
  assert.ok(summary, 'saved summary section');
  return summary;
};

export const verifySummary = (summaryText, sourceResults) => {
  const tableLines = summaryText.split('\n').filter((line) => line.trim().startsWith('|'));
  assert.ok(tableLines.length >= 2, 'saved summary table exists');
  const headerCells = parseCells(tableLines[0]);
  const sourceColIndex = findUniqueHeaderIndex(headerCells, '資料', ['資料', '資料ID']);
  const majorDefectsColIndex = findUniqueHeaderIndex(headerCells, '重大欠陥');
  const candidatesColIndex = findUniqueHeaderIndex(headerCells, '採用候補');

  for (const source of sourceResults) {
    const summaryRows = tableLines.slice(2).filter((line) => {
      const cells = parseCells(line);
      return cells.length > sourceColIndex && cells[sourceColIndex] === source.id;
    });
    assert.equal(summaryRows.length, 1, `${source.id}: saved summary row`);
    const rowCells = parseCells(summaryRows[0]);
    assert.ok(rowCells.length > majorDefectsColIndex, `${source.id}: saved summary row missing "重大欠陥" cell`);
    const savedMajorDefects = rowCells[majorDefectsColIndex];
    assert.equal(savedMajorDefects, String(source.majorDefects), `${source.id}: saved major defects`);
    assert.ok(rowCells.length > candidatesColIndex, `${source.id}: saved summary row missing "採用候補" cell`);
    const savedCandidates = rowCells[candidatesColIndex];
    assert.equal(savedCandidates, `${source.candidates}/${source.questionsCount}`, `${source.id}: saved candidates`);
  }

  const totalMajorDefects = sourceResults.reduce((acc, s) => acc + s.majorDefects, 0);
  const totalQuestions = sourceResults.reduce((acc, s) => acc + s.questionsCount, 0);
  const totalCandidates = sourceResults.reduce((acc, s) => acc + s.candidates, 0);
  const calculatedRate = (sourceResults.reduce((acc, s) => acc + s.meanRate, 0) / sourceResults.length).toFixed(2);

  const savedTotal = summaryText.match(/重大欠陥は\s*(\d+)\/(\d+)\s*問/);
  assert.ok(savedTotal, 'saved total major defects');
  assert.equal(totalMajorDefects, Number(savedTotal[1]), 'total saved major defects');
  assert.equal(totalQuestions, Number(savedTotal[2]), 'total saved questions');

  const savedCandidates = summaryText.match(/採用候補は\s*(\d+)\/(\d+)\s*問/);
  assert.ok(savedCandidates, 'saved total candidates');
  assert.equal(totalCandidates, Number(savedCandidates[1]), 'total saved candidates');
  assert.equal(totalQuestions, Number(savedCandidates[2]), 'total saved questions for candidates');

  const savedRate = summaryText.match(/全体率は\s*\*{0,2}(\d+(?:\.\d+)?)%\*{0,2}/);
  assert.ok(savedRate, 'saved overall rate');
  assert.equal(calculatedRate, savedRate[1], 'total saved overall rate');
};

export const verifyOfflineQuality = (options = {}) => {
  const baseDir = options.baseDir ?? new URL('.', import.meta.url);
  const read = options.read ?? ((name) => readFileSync(new URL(name, baseDir), 'utf8'));
  const json = options.json ?? ((name) => JSON.parse(read(name)));
  const quiet = options.quiet ?? false;
  const log = quiet ? () => {} : (options.log ?? console.log);

  const meta = json('generation.json');
  assert.equal(createHash('sha256').update(read('system-prompt.txt').trimEnd()).digest('hex'), meta.systemSha256);
  const scores = json('scores.json');
  const baseline = read('baseline.md');
  const summary = extractSummarySection(baseline);

  const sources = json('sources.json');
  const sourceResults = [];

  for (const source of sources) {
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
    assert.equal(new Set(questions.map((q) => q.id)).size, questions.length);
    assert.equal(scores[source.id].length, questions.length);
    assert.ok(questions.some((q) => q.type === 'essay'));
    assert.ok(questions.some((q) => q.type === 'multiple_choice'));
    let rate = 0;
    let sourceMajorDefects = 0;
    let sourceCandidates = 0;
    for (const [index, q] of questions.entries()) {
      assert.ok(q.prompt.trim());
      assert.ok(excerptAppearsInJoined(q.sourceExcerpt, source.content), `${source.id} ${q.id}: excerpt`);
      const s = scores[source.id][index];
      assert.equal(s.id, q.id);
      assert.equal(s.type, q.type);
      if (q.type === 'multiple_choice') {
        assert.equal(q.options.length, 4);
        assert.ok(q.options.every((o) => typeof o === 'string' && o.trim()));
        assert.ok(Number.isInteger(q.correctIndex) && q.correctIndex >= 0 && q.correctIndex < 4);
        assert.ok(Number.isInteger(s.P));
      } else {
        assert.equal(q.type, 'essay');
        assert.ok(q.referenceAnswer.trim());
        assert.equal(s.P, null);
      }
      const values = ['S', 'U', 'D', 'P', 'L'].map((k) => s[k]).filter((v) => v !== null);
      assert.ok(values.every((v) => Number.isInteger(v) && v >= 0 && v <= 3));
      // Count each question once, including when both S and U are <= 1.
      sourceMajorDefects += Number(s.S <= 1 || s.U <= 1);
      rate += (values.reduce((a, b) => a + b, 0) / (values.length * 3)) * 100;
      sourceCandidates += Number(values.every((v) => v >= 2));
    }
    const meanRate = rate / questions.length;
    sourceResults.push({
      id: source.id,
      questionsCount: questions.length,
      majorDefects: sourceMajorDefects,
      candidates: sourceCandidates,
      meanRate,
    });
    log(`${source.id}: ${questions.length} questions; mean ${meanRate.toFixed(2)}%; major defects ${sourceMajorDefects}`);
  }

  verifySummary(summary, sourceResults);

  const totalQuestions = sourceResults.reduce((acc, s) => acc + s.questionsCount, 0);
  const totalMajorDefects = sourceResults.reduce((acc, s) => acc + s.majorDefects, 0);
  const totalCandidates = sourceResults.reduce((acc, s) => acc + s.candidates, 0);
  const calculatedRate = (sourceResults.reduce((acc, s) => acc + s.meanRate, 0) / sourceResults.length).toFixed(2);

  log(`Total ${totalQuestions}; major defects ${totalMajorDefects}; candidates ${totalCandidates}; equal-source mean ${calculatedRate}%`);

  return {
    total: totalQuestions,
    majorDefects: totalMajorDefects,
    candidates: totalCandidates,
    calculatedRate,
    sourceResults,
  };
};

const isDirectRun =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  verifyOfflineQuality();
}
