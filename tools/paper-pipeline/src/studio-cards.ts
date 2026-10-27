/** Studio 出力カードの相対時刻。1時間超は「昨日」「2日前」になる。 */
export const STUDIO_RELATIVE_TIME =
  /(?:\d+\s*(?:秒前|分前|時間前|日前|週間前|か月前|ヶ月前)|たった今|昨日|おととい|just now|\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?)\s+ago|yesterday)/i;

/** 単語帳の出力カード。NotebookLM は「単語帳」「暗記カード」など名前を変える */
export const FLASHCARD_CARD = /フラッシュ|単語帳|暗記カード|単語カード|Flashcard/i;

/** Material icon identity takes precedence over an arbitrary generated title. */
export function studioKindFromIcon(icon: string): "quiz" | "flashcards" | "slides" | "video" | "other" | null {
  if (icon === "quiz") return "quiz";
  if (["copy", "cards_star", "flashcards"].includes(icon)) return "flashcards";
  if (icon === "tablet") return "slides";
  if (["videocam", "subscriptions"].includes(icon)) return "video";
  if (["audio_spark", "flowchart", "stacked_bar_chart", "format_list_bulleted", "auto_tab_group", "sticky_note", "add", "add_2", "sync"].includes(icon)) return "other";
  return null;
}

/** カード文字列の先頭付近（未読などのプレフィックスを除く）から Material アイコン名を抽出する */
export function extractStudioIcon(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  const words = t.split(" ");
  for (let i = 0; i < Math.min(words.length, 3); i++) {
    const w = words[i].toLowerCase();
    if (w === "未読" || w === "unread") continue;
    if (studioKindFromIcon(w) !== null) return w;
    break;
  }
  return null;
}

export type StudioCardKind = "quiz" | "flashcards" | "slides" | "video" | "other" | null;

const NON_VIDEO =
  /フラッシュカード|単語帳|暗記カード|単語カード|クイズ|マインドマップ|インフォグラフィ|スライド資料|Slide deck/i;

export const NON_SLIDE_CARD =
  /フラッシュカード|単語帳|暗記カード|単語カード|クイズ|マインドマップ|インフォグラフィ|Data Table|音声解説|Audio overview|新しいメモ|sticky_note|Add note|レポートを作成/i;

/**
 * カード文字列から種別を判定する。
 * アイコン名（quiz, copy, tablet, videocam 等）が先頭付近にあればタイトル語より優先する。
 * アイコン名が無ければタイトル語で判定する。
 */
export function detectStudioCardKind(text: string): StudioCardKind {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;

  const icon = extractStudioIcon(t);
  if (icon) {
    const kind = studioKindFromIcon(icon);
    if (kind !== null) return kind;
  }

  if (isExplainerVideoCardText(t) || /\b(動画解説|Video overview|ビデオ概要)\b/i.test(t)) {
    return "video";
  }
  if (/クイズ|\bQuiz\b/i.test(t)) {
    return "quiz";
  }
  if (FLASHCARD_CARD.test(t)) {
    return "flashcards";
  }
  if (/スライド資料|Slide deck|スライドデッキ/i.test(t)) {
    return "slides";
  }
  if (NON_SLIDE_CARD.test(t)) {
    return "other";
  }

  return null;
}

const EXPLAINER_DURATION =
  /\b(\d{1,2}):(\d{2})\s*·\s*(解説|Explainer|説明動画|説明)\b/gi;

export type VideoKickoffScan = {
  durationsSec: number[];
  explainerCount: number;
  shortCount: number;
};

function durationSec(mm: string, ss: string): number {
  return Number(mm) * 60 + Number(ss);
}

function uniqueDurations(values: number[]): number[] {
  return [...new Set(values.filter((n) => Number.isFinite(n) && n > 0))];
}

export function listVideoDurationsSec(text: string): number[] {
  const found: number[] = [];
  const add = (mm: string, ss: string) => {
    const sec = durationSec(mm, ss);
    if (sec > 0 && !found.includes(sec)) found.push(sec);
  };
  for (const m of text.matchAll(new RegExp(EXPLAINER_DURATION.source, "gi"))) {
    add(m[1], m[2]);
  }
  for (const m of text.matchAll(/\b(\d{1,2}):(\d{2})\b[^\n]{0,48}play_arrow/gi)) {
    add(m[1], m[2]);
  }
  for (const m of text.matchAll(/play_arrow[^\n]{0,48}\b(\d{1,2}):(\d{2})\b/gi)) {
    add(m[1], m[2]);
  }
  return uniqueDurations(found);
}

export function isExplainerVideoCardText(text: string): boolean {
  if (NON_VIDEO.test(text)) return false;
  if (listVideoDurationsSec(text).length > 0) return true;
  return false;
}

export function scanStudioVideoOutputs(texts: string[]): VideoKickoffScan {
  const durationsSec = uniqueDurations(texts.flatMap((t) => listVideoDurationsSec(t)));
  return {
    durationsSec,
    explainerCount: durationsSec.filter((s) => s >= 120).length,
    shortCount: durationsSec.filter((s) => s < 120).length,
  };
}

/** タイル（subscriptions 動画解説）だけでは既存動画とみなさない。 */
export function shouldKickoffVideo(scan: VideoKickoffScan): boolean {
  if (scan.explainerCount > 0) return false;
  if (scan.shortCount >= 2) return false;
  return true;
}

/** 再生成しない既存動画がある。MP4 未保存でも Studio 生成は終わっている。 */
export function studioVideoGenerationDone(scan: VideoKickoffScan): boolean {
  return scan.durationsSec.length > 0 && !shouldKickoffVideo(scan);
}

/** 生成タイルではなく、Studio に並んでいるスライド出力か */
export function isSlideDeckCardText(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/スライド資料を生成|スライドを生成中|Generating slide/i.test(t)) return false;
  if (/\b\d{1,2}:\d{2}\s*·\s*(解説|Explainer|説明)/.test(t)) return false;
  if (/chevron_forward/.test(t) && !/件のソース/.test(t)) return false;

  const kind = detectStudioCardKind(t);
  if (kind !== null) {
    if (kind !== "slides") return false;
    return /件のソース/.test(t) || STUDIO_RELATIVE_TIME.test(t);
  }

  if (NON_SLIDE_CARD.test(t)) return false;
  return /件のソース/.test(t) && STUDIO_RELATIVE_TIME.test(t);
}

/** カスタマイズの「プレゼンターのスライド」。詳細カードや両方を含む親は除外 */
export function isPresenterSlideFormatText(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/詳細なスライド|Detailed Deck|Detailed slides?/i.test(t)) return false;
  return /プレゼンターのスライド|Presenter Slides|Presenter'?s slides/i.test(t);
}

const STUDIO_CREATION_TILES_VISIBLE =
  /(?:tablet\s*)?(?:スライド資料|Slide deck)\s*chevron_forward|(?:subscriptions\s*)?(?:動画解説|Video overview)\s*chevron_forward/i;

/** Studio の成果物ビューア（クイズ・単語帳・スライド等の個別表示）が開いているか */
export function isStudioArtifactViewerText(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/をカスタマイズ|後で生成|Generate later/i.test(t)) return false;
  if (STUDIO_CREATION_TILES_VISIBLE.test(t)) return false;
  if (/個のソースを表示/.test(t) && /チャットパネル|collapse_content|expand_content/.test(t)) {
    return true;
  }
  if (/\bclose_fullscreen\b/.test(t)) {
    return true;
  }
  if (
    /適切なコンテンツ[\s\S]{0,160}不適切なコンテンツ|Good content[\s\S]{0,160}Bad content/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/(?:アプリ|\bApp\b|\bStudio\b)\s*chevron_right/i.test(t)) {
    return true;
  }
  return false;
}

/** スライド生成完了の通知バナー・トースト表示か */
export function isSlideReadyNotificationText(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  return /(?:スライド資料|スライドデッキ|スライド)\s*(?:「[^」]*」\s*)?(?:の準備ができました|の準備完了|が完成しました|の生成が完了しました)|Slide deck (?:is )?ready|Slides are ready/i.test(
    t,
  );
}

/** スライド出力カードが生成中か。生成タイル＋ページ内の sync だけでは真にしない */
export function isSlideGenerationInProgress(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || isStudioArtifactViewerText(t)) return false;
  if (
    /スライド資料を生成|スライドを生成中|スライド資料を作成中|スライド資料\s*の生成を開始しています|Generating slide/i.test(
      t,
    )
  ) {
    return true;
  }
  if (!/\bsync\b/i.test(t)) return false;
  const withoutSync = t.replace(/\bsync\b/gi, " ").replace(/\s+/g, " ").trim();
  if (/chevron_forward/.test(withoutSync) && !/件のソース/.test(withoutSync)) return false;
  return isSlideDeckCardText(withoutSync) || (detectStudioCardKind(withoutSync) === "slides" && !NON_SLIDE_CARD.test(withoutSync));
}

/** 動画出力カードが生成中か。生成タイルだけの場合は真にしない */
export function isVideoGenerationInProgress(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || isStudioArtifactViewerText(t)) return false;
  if (
    /動画を生成中|動画解説を生成|動画解説を作成中|動画解説\s*の生成を開始しています|Generating video/i.test(
      t,
    )
  ) {
    return true;
  }
  if (!/\bsync\b/i.test(t)) return false;
  const kind = studioKindFromIcon(t.split(" ")[0]);
  if (kind === "video" && !/chevron_forward|chevron_right/i.test(t)) {
    return true;
  }
  return /sync\s*(?:subscriptions\s*)?(?:動画解説|Video overview)|(?:動画解説|Video overview)\s*sync/i.test(
    t,
  );
}

/** 既存スライドや生成中・完了通知があれば、もう一枚作らない。ビューア表示中も未生成扱いしない */
export function shouldKickoffSlides(texts: string[]): boolean {
  const nonEmpty = texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  const nonViewer = nonEmpty.filter((t) => !isStudioArtifactViewerText(t));
  if (nonViewer.length === 0 && nonEmpty.length > 0) return false;
  if (nonViewer.some((t) => isSlideGenerationInProgress(t) || isSlideReadyNotificationText(t))) {
    return false;
  }
  return !nonViewer.some((t) => isSlideDeckCardText(t));
}

export function formatVideoScan(scan: VideoKickoffScan): string {
  if (scan.durationsSec.length === 0) return "動画カード 0 件";
  const clock = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `動画カード ${scan.durationsSec.length} 件（${scan.durationsSec.map(clock).join(", ")}）`;
}

/** 読み込み中のツールバーや成果物ビューアだけを「出力が無い」と誤判定しない */
export function studioOutputScanIncomplete(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  if (/Loading Notebook/i.test(t)) return true;
  if (isStudioArtifactViewerText(t)) return true;
  if (/\b\d{1,2}:\d{2}\s*·\s*(解説|Explainer|説明)\b/.test(t)) return false;
  if (STUDIO_RELATIVE_TIME.test(t)) return false;
  return true;
}

/** チャット欄のカスタマイズ（Studio の生成ダイアログではない） */
export function isChatCustomizeLabel(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  return /photo_spark|keep_pin|絵文字|メモに保存/.test(t);
}

/** Studio が生成中かどうか。タイルは「生成しています」ではなく sync アイコンになる。 */
export function textLooksLikeGenerating(t: string): boolean {
  if (
    /生成しています|Generating|動画を生成中|スライドを生成中|スライド資料を生成|作成しています/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/\bsync\b/i.test(t) && /スライド資料|動画解説|Video overview|Slide deck/i.test(t)) return true;
  if (/の生成を開始しています/.test(t)) return true;
  return false;
}

export function isStudioGenerateLabel(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (isChatCustomizeLabel(t)) return false;
  if (/ノートブックを作成|後で生成|Generate later|スケジュール/.test(t)) return false;
  return /^(今すぐ)?生成$|^(今すぐ)?作成$|今すぐ生成|Generate now|動画を生成|スライド.*生成/i.test(t);
}

/** NotebookLM の動画ダウンロード（ビューア / その他メニュー） */
export function looksLikeVideoDownloadLabel(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/ノートブックを作成|ソースを追加|Google アプリ/.test(t)) return false;
  if (/\bdownload\b/i.test(t) || /ダウンロード/.test(t)) return true;
  return /動画をダウンロード|Download video|Download MP4|MP4 をダウンロード|動画（MP4）/i.test(t);
}

export function looksLikeOverflowMenuLabel(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/more_vert|more_horiz/i.test(t)) return true;
  if (/その他の操作|More options|More actions/i.test(t)) return true;
  return /^(その他|メニュー|More)$/i.test(t);
}

/**
 * Studio のビューアが持つ文字列を取り出す。
 * 文字列、{ text }、{ flashcardContentBlock: [{ type: "text", content }] } の形がある。
 */
export function studioText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (!v || typeof v !== "object") return "";
  if (Array.isArray(v)) {
    return v.map((x) => studioText(x)).filter(Boolean).join("\n").trim();
  }
  const o = v as Record<string, unknown>;
  for (const key of ["text", "content"]) {
    const t = o[key];
    if (typeof t === "string" && t.trim()) return t.trim();
  }
  for (const key of ["flashcardContentBlock", "contentBlock", "blocks"]) {
    if (Array.isArray(o[key])) {
      const t = studioText(o[key]);
      if (t) return t;
    }
  }
  return "";
}
