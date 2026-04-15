import type { StoredQuestion } from "@/lib/types";
import { isStoredQuestionLike } from "@/lib/is-stored-question";

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (ch === "," && !inQuote) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function normalizeHeader(s: string): string {
  return s
    .trim()
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function pickFirst(obj: Record<string, string>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 拡張子や全角英字のヘッダー差、Question hint 列などに対応 */
function pickNotebookLmRationaleCell(r: Record<string, string>): string {
  const direct = pickFirst(r, [
    "rationale",
    "rationales",
    "explanation",
    "explanations",
    "note",
    "notes",
    "解説",
  ]);
  if (direct) return direct;
  for (const [k, v] of Object.entries(r)) {
    if (!v.trim()) continue;
    const kn = k.toLowerCase();
    if (kn.includes("解説")) return v.trim();
    if (kn === "rationale" || kn.startsWith("rationale_") || kn.endsWith("_rationale"))
      return v.trim();
    if (
      kn === "explanation" ||
      kn.startsWith("explanation_") ||
      kn.endsWith("_explanation")
    ) {
      return v.trim();
    }
  }
  return "";
}

function pickNotebookLmHintCell(r: Record<string, string>): string {
  const direct = pickFirst(r, [
    "hint",
    "hints",
    "ヒント",
    "clue",
    "clues",
    "tip",
    "tips",
    "nudge",
  ]);
  if (direct) return direct;
  for (const [k, v] of Object.entries(r)) {
    if (!v.trim()) continue;
    const kn = k.toLowerCase();
    if (kn.includes("ヒント")) return v.trim();
    if (kn === "hint" || kn.startsWith("hint_") || kn.endsWith("_hint")) return v.trim();
    if (kn === "clue" || kn.startsWith("clue_") || kn.endsWith("_clue")) return v.trim();
    if (kn === "tip" || kn.startsWith("tip_")) return v.trim();
  }
  return "";
}

/** 受験 API 用: DB や手編集でキー表記がずれたヒントを拾う（sourceExcerpt は解説と混同するため使わない） */
export function csvMcHintTextForStripClient(q: {
  notebookLmCsvHint?: string;
}): string {
  const direct = q.notebookLmCsvHint?.trim();
  if (direct) return direct;
  const rec = q as Record<string, unknown>;
  for (const key of ["notebook_lm_csv_hint", "NotebookLmCsvHint"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function buildHeaderIndex(headers: string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  headers.forEach((h, i) => {
    idx[normalizeHeader(h)] = i;
  });
  return idx;
}

function rowToObject(headers: string[], row: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((h, i) => {
    obj[normalizeHeader(h)] = (row[i] ?? "").trim();
  });
  return obj;
}

function parseAnswerIndex(answerRaw: string, options: string[]): number {
  const a = answerRaw.trim();
  if (!a) return -1;

  // NotebookLM クイズ CSV: "D. 204.2 MT"（先頭1文字 + 区切り + 選択肢本文）
  const letterThenRest = a.match(/^([A-Ea-e])\s*[.)\uFF1A:]\s*(.+)$/);
  if (letterThenRest) {
    const rest = letterThenRest[2]!.trim();
    if (rest) {
      const byRest = options.findIndex((x) => x.trim() === rest);
      if (byRest >= 0) return byRest;
    }
    const n = letterThenRest[1]!.toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
    if (n >= 0 && n < options.length) return n;
  }

  const asNum = Number(a);
  if (Number.isInteger(asNum)) {
    if (asNum >= 1 && asNum <= options.length) return asNum - 1;
    if (asNum >= 0 && asNum < options.length) return asNum;
  }
  const up = a.toUpperCase();
  if (/^[A-Z]$/.test(up)) {
    const n = up.charCodeAt(0) - "A".charCodeAt(0);
    if (n >= 0 && n < options.length) return n;
  }
  const byValue = options.findIndex((x) => x.trim() === a);
  return byValue;
}

function toQuizQuestions(rows: Record<string, string>[]): StoredQuestion[] {
  const out: StoredQuestion[] = [];
  let n = 0;
  for (const r of rows) {
    const prompt = pickFirst(r, ["question", "prompt", "問題", "問い"]);
    if (!prompt) continue;
    const options = [
      pickFirst(r, ["option_a", "a", "choice_a", "選択肢_a"]),
      pickFirst(r, ["option_b", "b", "choice_b", "選択肢_b"]),
      pickFirst(r, ["option_c", "c", "choice_c", "選択肢_c"]),
      pickFirst(r, ["option_d", "d", "choice_d", "選択肢_d"]),
      pickFirst(r, ["option_e", "e", "choice_e", "選択肢_e"]),
    ].filter(Boolean);
    if (options.length < 2) continue;
    const answerRaw = pickFirst(r, ["correct_answer", "answer", "正解"]);
    const correctIndex = parseAnswerIndex(answerRaw, options);
    if (correctIndex < 0) continue;
    const rationaleRaw = pickNotebookLmRationaleCell(r);
    const rationale = rationaleRaw || undefined;
    const hintRaw = pickNotebookLmHintCell(r);
    const hint = hintRaw || undefined;
    out.push({
      id: `nb-quiz-${n++}`,
      type: "multiple_choice",
      prompt,
      options,
      correctIndex,
      ...(rationale ? { notebookLmCsvRationale: rationale } : {}),
      ...(hint ? { notebookLmCsvHint: hint } : {}),
    });
  }
  return out;
}

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = t;
  }
}

/** NFKC 後に数字（ASCII か全角）を含むか。数値系の設問・誤答候補の判定に使う。 */
function answerLooksNumeric(s: string): boolean {
  const t = s.trim().normalize("NFKC");
  return /\d/.test(t);
}

/**
 * 文字列末尾付近の「数値ブロック」の直後を単位として取る（例: 204.2 MT → MT、15% → %）。
 */
function extractTrailingUnit(s: string): string {
  const t = s.trim().normalize("NFKC");
  let lastNumEnd = -1;
  for (let k = 0; k < t.length; k++) {
    const m = t.slice(k).match(/^([+-]?[\d,]+(?:\.\d+)?)/);
    if (m) lastNumEnd = k + m[0].length;
  }
  if (lastNumEnd < 0) return "";
  return t.slice(lastNumEnd).trim();
}

function normalizeUnitKey(unit: string): string {
  return unit.trim().normalize("NFKC").toLowerCase();
}

type ParsedNumericAnswer = {
  prefix: string;
  numberRaw: string;
  value: number;
  unitSuffix: string;
};

/** 正解文字列から末尾寄りの数値と単位を分解（合成誤答の組み立て用）。 */
function parseNumericAnswerParts(s: string): ParsedNumericAnswer | null {
  const t = s.trim().normalize("NFKC");
  let last: { start: number; end: number; raw: string; value: number } | null = null;
  for (let k = 0; k < t.length; k++) {
    const m = t.slice(k).match(/^([+-]?[\d,]+(?:\.\d+)?)/);
    if (m) {
      const raw = m[0]!;
      const value = Number(raw.replace(/,/g, ""));
      if (Number.isFinite(value)) last = { start: k, end: k + raw.length, raw, value };
    }
  }
  if (!last) return null;
  const prefix = t.slice(0, last.start).trimEnd();
  const unitSuffix = t.slice(last.end).trim();
  return {
    prefix,
    numberRaw: last.raw,
    value: last.value,
    unitSuffix,
  };
}

function formatNumberForDisplay(value: number, templateRawNoComma: string): string {
  const sign = value < 0 ? "-" : "";
  const v = Math.abs(value);
  if (templateRawNoComma.includes(".")) {
    const dec = templateRawNoComma.split(".")[1]!.length;
    let s = v.toFixed(dec);
    s = s.replace(/(\.\d*?)0+$/, "$1");
    if (s.endsWith(".")) s = s.slice(0, -1);
    return sign + s;
  }
  return sign + String(Math.round(v));
}

function rebuildNumericAnswer(parts: ParsedNumericAnswer, newNumStr: string): string {
  const { prefix, unitSuffix: u } = parts;
  const n = newNumStr.trim();
  if (prefix) {
    if (!u) return `${prefix} ${n}`.trim();
    if (u.startsWith("%") || u.startsWith("°") || u.startsWith("‰")) return `${prefix} ${n}${u}`.trim();
    return `${prefix} ${n} ${u}`.trim();
  }
  if (!u) return n;
  if (u.startsWith("%") || u.startsWith("°") || u.startsWith("‰")) return `${n}${u}`;
  return `${n} ${u}`;
}

/** 長い語句でも計算量が暴れないよう、距離計算は先頭 maxLen 文字に限る。 */
function levenshteinDistanceBounded(a: string, b: string, maxLen = 96): number {
  const x = a.length > maxLen ? a.slice(0, maxLen) : a;
  const y = b.length > maxLen ? b.slice(0, maxLen) : b;
  const n = y.length;
  let prev = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  let cur = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[n]!;
}

/** 正解に近い順に並べ、同距離帯の中だけシャッフルする。 */
function orderByNumericSimilarityThenShuffle(correct: string, arr: string[]): string[] {
  const pc = parseNumericAnswerParts(correct);
  if (!pc) {
    shuffleInPlace(arr);
    return arr;
  }
  const scored = arr.map((a) => {
    const p = parseNumericAnswerParts(a);
    const d = p ? Math.abs(p.value - pc.value) : Number.POSITIVE_INFINITY;
    return { a, d };
  });
  scored.sort((u, v) => u.d - v.d);
  const out: string[] = [];
  let i = 0;
  while (i < scored.length) {
    let j = i + 1;
    while (j < scored.length && scored[j]!.d === scored[i]!.d) j++;
    const slice = scored.slice(i, j).map((x) => x.a);
    shuffleInPlace(slice);
    out.push(...slice);
    i = j;
  }
  return out;
}

/**
 * プールに十分な数値誤答がないとき、同じ単位のまま数値だけ変えた選択肢を合成する。
 * 正解に近い値（小さな倍率・オフセット）を優先して試す。
 */
function synthesizeNumericWrongOptions(
  correct: string,
  already: string[],
  count: number,
): string[] {
  const parsed = parseNumericAnswerParts(correct);
  if (!parsed || count <= 0) return [];
  const correctUnit = normalizeUnitKey(extractTrailingUnit(correct));
  const templateNum = parsed.numberRaw.replace(/,/g, "");
  const banned = new Set<string>([correct, ...already]);
  const out: string[] = [];
  const v = parsed.value;
  const multipliers = [
    1.02, 0.98, 1.05, 0.95, 1.1, 0.9, 1.25, 0.8, 1.5, 0.5, 2, 0.25, 1.75, 0.6,
  ];
  const offsets = [1, -1, 2, -2, 5, -5, 10, -10, 100, -100];
  const tryPush = (x: number) => {
    if (!Number.isFinite(x) || out.length >= count) return;
    const numStr = formatNumberForDisplay(x, templateNum);
    const str = rebuildNumericAnswer(parsed, numStr);
    if (str === correct || banned.has(str) || out.includes(str)) return;
    if (!answerLooksNumeric(str)) return;
    if (normalizeUnitKey(extractTrailingUnit(str)) !== correctUnit) return;
    out.push(str);
    banned.add(str);
  };
  const rel = Math.max(1e-9, Math.abs(v) * 0.01);
  const fine = [
    v + rel,
    v - rel,
    v + rel * 2,
    v - rel * 2,
    v + rel * 5,
    v - rel * 5,
  ];
  for (const x of fine) tryPush(x);
  for (const m of multipliers) tryPush(v * m);
  for (const d of offsets) tryPush(v + d);
  const step = Math.max(1e-9, Math.abs(v) * 0.05 || 0.05);
  tryPush(v + step);
  tryPush(v - step);
  if (v !== 0) tryPush(v / 2);
  let guard = 0;
  while (out.length < count && guard < 120) {
    guard++;
    const f = 0.92 + Math.random() * 0.16;
    tryPush(v * f);
    tryPush(v + (Math.random() - 0.5) * 2 * rel);
  }
  return out.slice(0, count);
}

function pickNumericDistractors(
  correct: string,
  candidates: string[],
  maxWrong: number,
): string[] {
  const correctUnit = normalizeUnitKey(extractTrailingUnit(correct));
  const numeric = [...new Set(candidates.filter((a) => answerLooksNumeric(a)))];
  const sameUnit = orderByNumericSimilarityThenShuffle(
    correct,
    numeric.filter((a) => normalizeUnitKey(extractTrailingUnit(a)) === correctUnit),
  );
  const otherNumeric = orderByNumericSimilarityThenShuffle(
    correct,
    numeric.filter((a) => normalizeUnitKey(extractTrailingUnit(a)) !== correctUnit),
  );
  const wrong: string[] = [];
  for (const a of sameUnit) {
    if (wrong.length >= maxWrong) break;
    if (a !== correct) wrong.push(a);
  }
  for (const a of otherNumeric) {
    if (wrong.length >= maxWrong) break;
    if (a !== correct && !wrong.includes(a)) wrong.push(a);
  }
  if (wrong.length < maxWrong) {
    const synth = synthesizeNumericWrongOptions(
      correct,
      wrong,
      maxWrong - wrong.length,
    );
    for (const s of synth) {
      if (wrong.length >= maxWrong) break;
      if (!wrong.includes(s)) wrong.push(s);
    }
  }
  return wrong.slice(0, maxWrong);
}

/**
 * 正解語句に編集距離が近いプール候補を優先し、足りなければ類似文字列を合成する。
 */
function synthesizeTextWrongOptions(
  correct: string,
  already: string[],
  count: number,
): string[] {
  const s = correct.normalize("NFKC").trim();
  if (!s || count <= 0) return [];
  const banned = new Set<string>([correct, ...already]);
  const out: string[] = [];
  const tryPush = (t: string) => {
    const u = t.normalize("NFKC").trim();
    if (!u || u === correct || banned.has(u) || out.includes(u)) return;
    out.push(u);
    banned.add(u);
  };
  const chars = [...s];
  for (let i = 0; i < chars.length && out.length < count + 12; i++) {
    tryPush(chars.filter((_, j) => j !== i).join(""));
  }
  for (let i = 0; i < chars.length - 1 && out.length < count + 12; i++) {
    const sw = [...chars];
    const a = sw[i]!;
    const b = sw[i + 1]!;
    sw[i] = b;
    sw[i + 1] = a;
    tryPush(sw.join(""));
  }
  for (let i = 0; i < chars.length && out.length < count + 12; i++) {
    tryPush(chars.slice(0, i).join("") + chars[i]! + chars.slice(i).join(""));
  }
  if (s.length >= 2) {
    tryPush(s.slice(0, -1));
    tryPush(s.slice(1));
  }
  const confusable: Record<string, string> = {
    は: "わ",
    わ: "は",
    を: "お",
    お: "を",
    へ: "え",
    あ: "お",
    い: "え",
    う: "お",
    つ: "っ",
    っ: "つ",
  };
  for (let i = 0; i < chars.length && out.length < count + 12; i++) {
    const ch = chars[i]!;
    const rep = confusable[ch];
    if (rep) {
      tryPush(chars.slice(0, i).join("") + rep + chars.slice(i + 1).join(""));
    }
  }
  let guard = 0;
  while (out.length < count && guard < 200) {
    guard++;
    if (s.length < 2) break;
    const i = Math.floor(Math.random() * s.length);
    const kind = Math.floor(Math.random() * 3);
    if (kind === 0) {
      tryPush(s.slice(0, i) + s.slice(i + 1));
    } else if (kind === 1 && i < s.length - 1) {
      const arr = [...s];
      [arr[i], arr[i + 1]] = [arr[i + 1]!, arr[i]!];
      tryPush(arr.join(""));
    } else {
      tryPush(s.slice(0, i) + s[i]! + s.slice(i));
    }
  }
  return out.slice(0, count);
}

function pickTextDistractors(correct: string, candidates: string[], maxWrong: number): string[] {
  const uniq = [...new Set(candidates.filter((a) => a !== correct))];
  if (uniq.length === 0) {
    return synthesizeTextWrongOptions(correct, [], maxWrong);
  }
  uniq.sort((a, b) => {
    const da = levenshteinDistanceBounded(correct, a);
    const db = levenshteinDistanceBounded(correct, b);
    return da - db;
  });
  const best = levenshteinDistanceBounded(correct, uniq[0]!);
  const similar = uniq.filter(
    (x) => levenshteinDistanceBounded(correct, x) <= best + 3,
  );
  const pool = similar.length >= maxWrong ? similar : uniq;
  shuffleInPlace(pool);
  let wrong = pool.slice(0, maxWrong);
  if (wrong.length < maxWrong) {
    const synth = synthesizeTextWrongOptions(
      correct,
      wrong,
      maxWrong - wrong.length,
    );
    wrong = [...wrong, ...synth].slice(0, maxWrong);
  }
  return wrong;
}

/** 単語帳 JSON から「裏面」に相当する文字列だけ集める（MC の正解文・essay の referenceAnswer）。 */
export function collectVocabBackStringsFromQuestionsJson(json: unknown): string[] {
  const out = new Set<string>();
  if (!Array.isArray(json)) return [];
  for (const item of json) {
    if (!isStoredQuestionLike(item)) continue;
    if (item.type === "multiple_choice") {
      const a = item.options[item.correctIndex];
      if (typeof a === "string" && a.trim()) out.add(a.trim());
    } else if (item.type === "essay") {
      const r = item.referenceAnswer?.trim();
      if (r) out.add(r);
    }
  }
  return [...out];
}

/** 論文テスト 1 行分から、単語帳プール用の裏面文字列を集める。 */
export function collectPaperVocabBacksFromTestRow(row: {
  notebooklm_vocab_questions_json?: unknown;
  notebooklm_questions_json?: unknown;
}): string[] {
  const s = new Set<string>();
  for (const b of collectVocabBackStringsFromQuestionsJson(row.notebooklm_vocab_questions_json)) {
    s.add(b);
  }
  if (notebooklmJsonIsVocabLike(row.notebooklm_questions_json)) {
    for (const b of collectVocabBackStringsFromQuestionsJson(row.notebooklm_questions_json)) {
      s.add(b);
    }
  }
  return [...s];
}

/** Vocab CSV: build MC options using other cards' backs as distractors. */
function buildVocabMultipleChoiceQuestions(
  pairs: Array<{ prompt: string; answer: string }>,
  /** 論文ドキュメント横断の単語帳「裏面」プール（誤答候補に合流） */
  sharedAnswerBacks: string[] = [],
): StoredQuestion[] | null {
  if (pairs.length < 3) return null;
  const localAnswers = pairs.map((p) => p.answer);
  const answerPool = [...new Set([...localAnswers, ...sharedAnswerBacks])];
  const out: StoredQuestion[] = [];
  let n = 0;
  for (const p of pairs) {
    const others = [...new Set(answerPool.filter((a) => a !== p.answer))];
    const maxWrong = 3;
    const wrong = answerLooksNumeric(p.answer)
      ? pickNumericDistractors(p.answer, others, maxWrong)
      : pickTextDistractors(p.answer, others, maxWrong);
    if (wrong.length < 1) continue;
    const options = [...wrong, p.answer];
    shuffleInPlace(options);
    const correctIndex = options.indexOf(p.answer);
    if (correctIndex < 0) continue;
    out.push({
      id: `nb-vocab-${n++}`,
      type: "multiple_choice",
      prompt: p.prompt,
      options,
      correctIndex,
      sourceExcerpt: p.answer,
    });
  }
  if (out.length < 3) return null;
  return out;
}

function toFlashcardQuestions(rows: Record<string, string>[]): StoredQuestion[] {
  const pairs: Array<{ prompt: string; answer: string }> = [];
  for (const r of rows) {
    const front = pickFirst(r, [
      "正面（问题）",
      "正面(问题)",
      "front",
      "term",
      "question",
      "表",
      "用語",
    ]);
    const back = pickFirst(r, [
      "背面（答案）",
      "背面(答案)",
      "back",
      "definition",
      "answer",
      "裏",
      "説明",
    ]);
    if (!front || !back) continue;
    pairs.push({ prompt: front, answer: back.trim() });
  }
  return buildVocabMultipleChoiceQuestions(pairs) ?? [];
}

/**
 * Normalize stored vocab pool (legacy essay or MC) into multiple-choice for sessions.
 */
export function vocabPoolJsonToMultipleChoice(
  json: unknown,
  sharedAnswerBacks: string[] = [],
): StoredQuestion[] | null {
  if (!Array.isArray(json) || json.length < 3) return null;
  const pairs: Array<{ prompt: string; answer: string }> = [];
  for (const item of json) {
    if (!isStoredQuestionLike(item)) continue;
    if (item.type === "multiple_choice") {
      const ans = item.options[item.correctIndex];
      if (!ans?.trim()) continue;
      pairs.push({ prompt: item.prompt, answer: ans.trim() });
    } else {
      const a = item.referenceAnswer?.trim();
      if (!a) continue;
      pairs.push({ prompt: item.prompt, answer: a });
    }
  }
  return buildVocabMultipleChoiceQuestions(pairs, sharedAnswerBacks);
}

/** True when the stored NotebookLM JSON pool is flashcard/vocab style (essay only, 3+). */
export function notebooklmJsonIsVocabLike(json: unknown): boolean {
  if (!Array.isArray(json) || json.length < 3) return false;
  return json.every((item) => {
    if (!item || typeof item !== "object") return false;
    return (item as { type?: string }).type === "essay";
  });
}

/** クイズ CSV 用プール（旧列に単語帳のみが残っている場合は除外） */
export function getNotebookLmQuizPoolJson(test: {
  notebooklm_questions_json?: unknown;
}): unknown {
  const q = test.notebooklm_questions_json;
  if (!Array.isArray(q) || q.length === 0) return null;
  if (notebooklmJsonIsVocabLike(q)) return null;
  return q;
}

/** 単語帳 CSV 用プール（専用列優先、未移行の essay のみ旧列も参照） */
export function getNotebookLmVocabPoolJson(test: {
  notebooklm_vocab_questions_json?: unknown;
  notebooklm_questions_json?: unknown;
}): unknown {
  const v = test.notebooklm_vocab_questions_json;
  if (Array.isArray(v) && v.length > 0) return v;
  const q = test.notebooklm_questions_json;
  if (notebooklmJsonIsVocabLike(q)) return q;
  return null;
}

export function countNotebookLmQuizPoolRows(json: unknown): number {
  if (!Array.isArray(json)) return 0;
  return json.filter(
    (x) => isStoredQuestionLike(x) && x.type === "multiple_choice",
  ).length;
}

export function countNotebookLmVocabPoolRows(json: unknown): number {
  return vocabPoolJsonToMultipleChoice(json)?.length ?? 0;
}

export function canStartNotebookLmQuizCsvPool(test: {
  notebooklm_questions_json?: unknown;
}): boolean {
  return countNotebookLmQuizPoolRows(getNotebookLmQuizPoolJson(test)) >= 3;
}

export function canStartNotebookLmVocabCsvPool(test: {
  notebooklm_vocab_questions_json?: unknown;
  notebooklm_questions_json?: unknown;
}): boolean {
  return countNotebookLmVocabPoolRows(getNotebookLmVocabPoolJson(test)) >= 3;
}

export function parseNotebookLmCsv(text: string): {
  questions: StoredQuestion[];
  mode: "quiz" | "flashcard";
} {
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error("CSV に有効な行がありません");
  }

  const headers = parseCsvLine(lines[0]!);
  const hidx = buildHeaderIndex(headers);
  const rows = lines.slice(1).map((line) => rowToObject(headers, parseCsvLine(line)));

  /** ヘッダーは normalizeHeader で NFKC 化されるため、全角括弧列名は半角 ( ) キーになる */
  const looksLikeFlash =
    hidx["正面（问题）"] !== undefined ||
    hidx["正面(问题)"] !== undefined ||
    hidx["背面（答案）"] !== undefined ||
    hidx["背面(答案)"] !== undefined ||
    hidx.front !== undefined ||
    hidx.back !== undefined ||
    hidx.term !== undefined ||
    hidx.definition !== undefined;

  const questions = looksLikeFlash ? toFlashcardQuestions(rows) : toQuizQuestions(rows);
  if (questions.length < 3) {
    throw new Error("CSV から有効な問題を 3 問以上抽出できませんでした");
  }
  return { questions, mode: looksLikeFlash ? "flashcard" : "quiz" };
}
