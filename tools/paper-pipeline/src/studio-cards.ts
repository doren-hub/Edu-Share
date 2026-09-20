/** Studio 出力カードの相対時刻。1時間超は「昨日」「2日前」になる。 */
export const STUDIO_RELATIVE_TIME =
  /(?:\d+\s*(?:秒前|分前|時間前|日前|週間前|か月前|ヶ月前)|たった今|昨日|おととい|just now|\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?)\s+ago|yesterday)/i;

const NON_VIDEO =
  /フラッシュカード|単語帳|クイズ|マインドマップ|インフォグラフィ|スライド資料|Slide deck/i;

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

export function formatVideoScan(scan: VideoKickoffScan): string {
  if (scan.durationsSec.length === 0) return "動画カード 0 件";
  const clock = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return `動画カード ${scan.durationsSec.length} 件（${scan.durationsSec.map(clock).join(", ")}）`;
}

/** チャット欄のカスタマイズ（Studio の生成ダイアログではない） */
export function isChatCustomizeLabel(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  return /photo_spark|keep_pin|絵文字|メモに保存/.test(t);
}

/** Studio が生成中かどうか。タイルは「生成しています」ではなく sync アイコンになる。 */
export function textLooksLikeGenerating(t: string): boolean {
  if (/生成しています|Generating|動画を生成中|スライドを生成中|作成しています/i.test(t)) return true;
  if (/\bsync\b/i.test(t) && /スライド資料|動画解説|Video overview|Slide deck/i.test(t)) return true;
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
