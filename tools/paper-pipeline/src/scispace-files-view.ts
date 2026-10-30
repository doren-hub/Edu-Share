/** Files タブはトグルなので、選択済みや直前のクリックでは押さない */
export const FILES_TAB_CLICK_GAP_MS = 15_000;

export function filesTabClickAllowed(opts: {
  alreadySelected: boolean;
  lastClickAt: number;
  now: number;
  gapMs?: number;
}): boolean {
  if (opts.alreadySelected) return false;
  return opts.now - opts.lastClickAt >= (opts.gapMs ?? FILES_TAB_CLICK_GAP_MS);
}

/** SciSpace フォルダの Files 表か、ノートのチャット/Home かを本文から分ける。 */
export function looksLikeSciSpaceFilesTable(text: string, hasTableRows = true): boolean {
  if (!hasTableRows) return false;
  const t = text.replace(/\s+/g, " ");
  if (!/Upload PDFs/i.test(t)) return false;
  if (!/Files\s*\(\d+/i.test(t)) return false;
  if (/Uploaded on/i.test(t)) return true;
  if (/\bTL;DR\b/.test(t) && /\.pdf\b/i.test(t)) return true;
  if (/Files\s*\(0\)/i.test(t) && /drag|drop|no files|empty/i.test(t)) return true;
  // 絞り込み 0 件でも Files 表（Sort と Upload PDFs がある）。タブを押すと閉じる
  if (/\bSort\b/i.test(t) && /no results|Try searching/i.test(t)) return true;
  if (/\bSort\b/i.test(t) && /\bNotebooks\s*\(\d+\)/i.test(t)) return true;
  return false;
}

/** 先頭 15 件だけ出して Load More がある Files 表。スクロールでは残りが出ない */
export function filesListNeedsLoadMore(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  if (!/\bLoad More\b/i.test(t)) return false;
  return /Showing\s+\d+\s+of\s+\d+\s+files/i.test(t);
}

/** Files ツールバーのファイル名検索。Column Settings / チャット欄は使わない */
export function isFilesListSearchHint(hint: string): boolean {
  const h = hint.replace(/\s+/g, " ");
  if (/chat|ask|message|prompt|composer|column/i.test(h)) return false;
  return /search|filter|find|検索|file|folder/i.test(h);
}

/** 画面の改行や連続空白でファイル名が割れても、同じ PDF として扱う */
export function pageShowsPdfFilename(body: string, filename: string): boolean {
  const page = body.replace(/\s+/g, "");
  const name = filename.replace(/\s+/g, "");
  if (!page || !name) return false;
  const stem = name.replace(/\.pdf$/i, "");
  return [name, stem].filter((value) => value.length >= 4).some((value) => page.includes(value));
}

export function looksLikeSciSpaceChatHome(text: string): boolean {
  const t = text.replace(/\s+/g, " ");
  const hits = [/\bNew Chat\b/i, /\bHome\b/, /\bAgent Gallery\b/i, /\bChat with PDF\b/i].filter((r) =>
    r.test(t),
  ).length;
  if (hits < 3) return false;
  return !looksLikeSciSpaceFilesTable(t);
}

/** PDF 名の比較では語中の改行を含め、すべての空白を無視する。 */
export function filenameWithoutWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

export const SCISPACE_HEADLESS_FOLDER_TIMEOUT_MS = 60_000;
export const SCISPACE_HEADED_FOLDER_TIMEOUT_MS = 15 * 60_000;

export type SciSpaceWaitState = "ready" | "login" | "bot_challenge" | "loading";

export interface SciSpaceFolderElements {
  hasTable: boolean;
  hasFilesTab: boolean;
  hasUploadBtn: boolean;
}

export function classifySciSpaceWaitState(params: {
  isBotChallenge?: boolean;
  isLogin?: boolean;
  hasTable?: boolean;
  hasUploadBtn?: boolean;
  hasFilesTab?: boolean;
}): {
  state: SciSpaceWaitState;
  stateLabel: string;
} {
  if (params.isBotChallenge) {
    return { state: "bot_challenge", stateLabel: "ボット判定" };
  }
  if (params.isLogin) {
    return { state: "login", stateLabel: "ログイン画面" };
  }
  if (params.hasTable && params.hasUploadBtn) {
    return { state: "ready", stateLabel: "Files 表確認" };
  }
  return { state: "loading", stateLabel: "読み込み中" };
}

export function formatSciSpaceWaitLog(params: {
  leftSeconds: number;
  url: string;
  title: string;
  state: SciSpaceWaitState;
  elements: Partial<SciSpaceFolderElements>;
}): string {
  const stateLabels: Record<SciSpaceWaitState, string> = {
    login: "ログイン画面",
    bot_challenge: "ボット判定",
    loading: "読み込み中",
    ready: "Files 表確認",
  };
  const label = stateLabels[params.state] ?? params.state;
  const elements = [
    `table:${params.elements.hasTable ? "あり" : "なし"}`,
    `filesTab:${params.elements.hasFilesTab ? "あり" : "なし"}`,
    `uploadBtn:${params.elements.hasUploadBtn ? "あり" : "なし"}`,
  ].join(", ");
  const shortTitle = params.title ? `"${params.title.slice(0, 40)}"` : '""';
  const shortUrl = params.url ? params.url.slice(0, 80) : "(url不明)";
  return `SciSpace 待ち（残り約 ${params.leftSeconds}s, 状態: ${label}） url=${shortUrl} title=${shortTitle} 要素=[${elements}]`;
}

