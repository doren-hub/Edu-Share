/**
 * PDF 本文のテキストと SciSpace メタ情報（題名・説明）のグラウンディング判定。
 * スキャン PDF の判定、題名の本文照合、説明（TL;DR）の本文照合を行う。
 */

/** スキャン（テキストなし）と判定する最小文字数（空白除外） */
export const MIN_PDF_TEXT_CHARS = 100;

/** 題名照合で参照する PDF 本文の先頭文字数（1〜2ページ相当） */
export const PDF_TITLE_CHECK_PREFIX_CHARS = 3000;

/** 題名の主要単語が本文先頭に含まれる最小割合 */
export const MIN_TITLE_WORD_MATCH_RATIO = 0.5;

/** 説明の主要単語が本文全体に含まれる最小割合 */
export const MIN_DESCRIPTION_WORD_MATCH_RATIO = 0.2;

/** 説明の主要単語のうち本文に含まれる最小単語数 */
export const MIN_DESCRIPTION_MATCHED_WORDS = 3;

/** 一般的なストップワード */
export const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are",
  "aren't", "as", "at", "be", "because", "been", "before", "being", "below", "between", "both",
  "but", "by", "can", "can't", "cannot", "could", "couldn't", "did", "didn't", "do", "does",
  "doesn't", "doing", "don't", "down", "during", "each", "few", "for", "from", "further", "had",
  "hadn't", "has", "hasn't", "have", "haven't", "having", "he", "he'd", "he'll", "he's", "her",
  "here", "here's", "hers", "herself", "him", "himself", "his", "how", "how's", "i", "i'd",
  "i'll", "i'm", "i've", "if", "in", "into", "is", "isn't", "it", "it's", "its", "itself",
  "let's", "me", "more", "most", "mustn't", "my", "myself", "no", "nor", "not", "of", "off",
  "on", "once", "only", "or", "other", "ought", "our", "ours", "ourselves", "out", "over", "own",
  "same", "shan't", "she", "she'd", "she'll", "she's", "should", "shouldn't", "so", "some", "such",
  "than", "that", "that's", "the", "their", "theirs", "them", "themselves", "then", "there",
  "there's", "these", "they", "they'd", "they'll", "they're", "they've", "this", "those", "through",
  "to", "too", "under", "until", "up", "very", "was", "wasn't", "we", "we'd", "we'll", "we're",
  "we've", "were", "weren't", "what", "what's", "when", "when's", "where", "where's", "which",
  "while", "who", "who's", "whom", "why", "why's", "with", "won't", "would", "wouldn't", "you",
  "you'd", "you'll", "you're", "you've", "your", "yours", "yourself", "yourselves",
  "paper", "study", "propose", "presents", "present", "approach",
]);

/** テキストから主要な単語（小文字・重複なし）を取り出す */
export function extractSignificantWords(text: string): string[] {
  const words: string[] = [];
  const lower = text.toLowerCase();

  // 1. ラテン文字・英数字の単語（空白区切り、3文字以上、ストップワード除外）
  const latinTokens = lower
    .replace(/[^\p{Script=Latin}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  words.push(...latinTokens);

  // 2. 日本語・CJK文字（漢字・ひらがな・カタカナ）：
  // 空白で区切られないため、文字の連続から 2文字の bigram を抽出して語彙とする。
  // ただし「した」「ける」等のひらがなのみの組は助詞・語尾ノイズとなるため除外する。
  const cjkChunks = lower.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  for (const chunk of cjkChunks) {
    if (chunk.length < 2) continue;
    for (let i = 0; i < chunk.length - 1; i++) {
      const bg = chunk.slice(i, i + 2);
      if (/^[\p{Script=Hiragana}]{2}$/u.test(bg)) continue;
      words.push(bg);
    }
  }

  return Array.from(new Set(words));
}

/** テキストがほとんど無い（スキャン）PDF かどうか */
export function isScannedPdfText(pdfText: string): boolean {
  const nonWhitespace = pdfText.replace(/\s+/g, "");
  return nonWhitespace.length < MIN_PDF_TEXT_CHARS;
}

/**
 * 題名が PDF 本文の先頭部分に十分含まれているか確かめる。
 * スキャン PDF の場合は常に false。
 */
export function isTitleGroundedInPdfText(title: string, pdfText: string): boolean {
  if (isScannedPdfText(pdfText)) return false;
  const cleanTitle = title.trim();
  if (!cleanTitle) return false;

  const prefix = pdfText.slice(0, PDF_TITLE_CHECK_PREFIX_CHARS).toLowerCase();
  const normalizedPrefix = prefix.replace(/\s+/g, " ");
  const normalizedTitle = cleanTitle.toLowerCase().replace(/\s+/g, " ");
  if (normalizedPrefix.includes(normalizedTitle)) return true;

  // 日本語など空白なしで連続する題名：空白・記号を除去しての直接照合
  const noSpaceTitle = cleanTitle.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const noSpacePrefix = prefix.replace(/[\s\p{P}\p{S}]/gu, "");
  if (noSpaceTitle.length >= 4 && noSpacePrefix.includes(noSpaceTitle)) return true;

  const words = extractSignificantWords(cleanTitle);
  if (words.length === 0) {
    // 主要単語が取れない場合は文字列として含まれているか判定
    return prefix.includes(cleanTitle.toLowerCase());
  }

  let matched = 0;
  for (const w of words) {
    if (prefix.includes(w)) {
      matched++;
    }
  }

  const ratio = matched / words.length;
  return ratio >= MIN_TITLE_WORD_MATCH_RATIO;
}

/**
 * 説明（TL;DR / 要約）の単語が PDF 本文と十分に重なっているか確かめる。
 * スキャン PDF の場合や、別の論文の要約が入った場合は false。
 */
export function isDescriptionGroundedInPdfText(description: string, pdfText: string): boolean {
  if (isScannedPdfText(pdfText)) return false;
  const cleanDesc = description.trim();
  if (!cleanDesc) return false;

  const fullLower = pdfText.toLowerCase();

  // 空白・記号を除去した長い連続一致があれば確実にグラウンディングされている
  const noSpaceDesc = cleanDesc.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  const noSpaceFull = fullLower.replace(/[\s\p{P}\p{S}]/gu, "");
  if (noSpaceDesc.length >= 15 && noSpaceFull.includes(noSpaceDesc.slice(0, 30))) {
    return true;
  }

  const words = extractSignificantWords(cleanDesc);
  if (words.length === 0) return false;

  let matched = 0;
  for (const w of words) {
    if (fullLower.includes(w)) {
      matched++;
    }
  }

  const ratio = matched / words.length;
  const minMatches = Math.min(MIN_DESCRIPTION_MATCHED_WORDS, words.length);
  return ratio >= MIN_DESCRIPTION_WORD_MATCH_RATIO && matched >= minMatches;
}

