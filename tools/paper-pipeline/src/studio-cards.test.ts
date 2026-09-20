import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STUDIO_RELATIVE_TIME,
  formatVideoScan,
  isChatCustomizeLabel,
  isExplainerVideoCardText,
  isStudioGenerateLabel,
  listVideoDurationsSec,
  looksLikeOverflowMenuLabel,
  looksLikeVideoDownloadLabel,
  scanStudioVideoOutputs,
  shouldKickoffSlides,
  shouldKickoffVideo,
  studioOutputScanIncomplete,
  studioVideoGenerationDone,
  isSlideDeckCardText,
  textLooksLikeGenerating,
} from "./studio-cards.ts";

test("STUDIO_RELATIVE_TIME: 昨日・日前も出力カードとみなす", () => {
  assert.match("2日前", STUDIO_RELATIVE_TIME);
  assert.match("昨日", STUDIO_RELATIVE_TIME);
  assert.match("41 分前", STUDIO_RELATIVE_TIME);
  assert.match("1時間前", STUDIO_RELATIVE_TIME);
  assert.match("3 days ago", STUDIO_RELATIVE_TIME);
  assert.doesNotMatch("動画解説 chevron_forward", STUDIO_RELATIVE_TIME);
});

test("読み込み直後のツールバーだけでは出力カード未確定", () => {
  const toolbar =
    "add ノートブックを作成 content_copy コピー trending_up アナリティクス share 共有 settings 設定 PRO ソース subscriptions 動画解説 chevron_forward tablet スライド資料";
  assert.equal(studioOutputScanIncomplete(toolbar), true);
  assert.equal(studioOutputScanIncomplete("Loading Notebook..."), true);
  assert.equal(
    studioOutputScanIncomplete(
      "マルチターンAIの目に見えないドリフト 6:05 · 解説 · 1 件のソース · 5 時間前",
    ),
    false,
  );
});

test("タイルだけの Studio 文は既存動画ではない", () => {
  const tile =
    "subscriptions 動画解説 chevron_forward tablet スライド資料 chevron_forward";
  assert.equal(isExplainerVideoCardText(tile), false);
  assert.deepEqual(listVideoDurationsSec(tile), []);
  assert.equal(shouldKickoffVideo(scanStudioVideoOutputs([tile])), true);
});

test("解説動画カード（7:47 · 解説）は再生成しない", () => {
  const card =
    "subscriptions 未読 The Proper Form of Schwarzschild’s Point Mass Field 7:47 · 解説 · 1 件のソース · 昨日 play_arrow more_vert";
  assert.equal(isExplainerVideoCardText(card), true);
  assert.deepEqual(listVideoDurationsSec(card), [7 * 60 + 47]);
  const scan = scanStudioVideoOutputs([card]);
  assert.equal(scan.explainerCount, 1);
  assert.equal(shouldKickoffVideo(scan), false);
  assert.equal(studioVideoGenerationDone(scan), true);
});

test("同じノートに動画が2本あるときは再生成しない", () => {
  const body = [
    "subscriptions 未読 シュヴァルツシルトの点質量 7:12 · 解説 · 1 件のソース · 2日前 play_arrow",
    "subscriptions 未読 Point-mass field 8:05 · 解説 · 1 件のソース · 昨日 play_arrow",
  ].join("\n");
  const scan = scanStudioVideoOutputs([body]);
  assert.equal(scan.explainerCount, 2);
  assert.equal(shouldKickoffVideo(scan), false);
  assert.match(formatVideoScan(scan), /2 件/);
});

test("ショートが1本だけのときは説明動画を作り直してよい", () => {
  const card = "subscriptions 0:45 · 解説 · 1 件のソース · 3 分前 play_arrow";
  const scan = scanStudioVideoOutputs([card]);
  assert.equal(scan.shortCount, 1);
  assert.equal(scan.explainerCount, 0);
  assert.equal(shouldKickoffVideo(scan), true);
  assert.equal(studioVideoGenerationDone(scan), false);
});

test("ショートが2本あるときはこれ以上作らない", () => {
  const body = "0:40 · 解説 play_arrow\n0:55 · 解説 play_arrow";
  const scan = scanStudioVideoOutputs([body]);
  assert.equal(scan.shortCount, 2);
  assert.equal(shouldKickoffVideo(scan), false);
  assert.equal(studioVideoGenerationDone(scan), true);
});

test("studioVideoGenerationDone: タイルだけでは生成完了にしない", () => {
  assert.equal(studioVideoGenerationDone(scanStudioVideoOutputs(["動画解説 chevron_forward"])), false);
});

test("チャットの photo_spark カスタマイズは Studio 生成ではない", () => {
  assert.equal(isChatCustomizeLabel("photo_spark カスタマイズ"), true);
  assert.equal(isStudioGenerateLabel("photo_spark カスタマイズ"), false);
  assert.equal(isStudioGenerateLabel("生成"), true);
  assert.equal(isStudioGenerateLabel("作成"), true);
  assert.equal(isStudioGenerateLabel("今すぐ生成"), true);
  assert.equal(isStudioGenerateLabel("ノートブックを作成"), false);
});

test("Studio タイルの sync は生成中とみなす", () => {
  const nearby =
    "tablet スライド資料 chevron_forward subscriptions 動画解説 chevron_forward sync 動画解";
  assert.equal(textLooksLikeGenerating(nearby), true);
  assert.equal(textLooksLikeGenerating("生成しています"), true);
  assert.equal(textLooksLikeGenerating("スライド資料を生成して... 1件のソースに基づく"), true);
  assert.equal(
    textLooksLikeGenerating("tablet スライド資料 chevron_forward subscriptions 動画解説 chevron_forward"),
    false,
  );
});

test("compact なスライドカードは再生成しない", () => {
  assert.equal(isSlideDeckCardText("Context Equilibria 1件のソース · 1分前"), true);
  assert.equal(
    isSlideDeckCardText("tablet The LLM Performance Cliff 1 件のソース · 5 時間前 more_vert"),
    true,
  );
  assert.equal(isSlideDeckCardText("コンテキストドリフト クイズ 1件のソース · 7時間前"), false);
  assert.equal(isSlideDeckCardText("6:05 · 解説 · 1 件のソース · 5 時間前"), false);
  assert.equal(isSlideDeckCardText("tablet スライド資料 chevron_forward"), false);
  assert.equal(
    shouldKickoffSlides([
      "Context... 1件のソース · 1分前",
      "コンテキストドリフト クイズ 1件のソース · 7時間前",
    ]),
    false,
  );
  assert.equal(shouldKickoffSlides(["tablet スライド資料 chevron_forward"]), true);
  assert.equal(shouldKickoffSlides(["スライド資料を生成して... 1件のソースに基づく"]), false);
});

test("動画ダウンロードは download / ダウンロード / メニュー表記", () => {
  assert.equal(looksLikeVideoDownloadLabel("download"), true);
  assert.equal(looksLikeVideoDownloadLabel("download download"), true);
  assert.equal(looksLikeVideoDownloadLabel("ダウンロード"), true);
  assert.equal(looksLikeVideoDownloadLabel("動画をダウンロード"), true);
  assert.equal(looksLikeVideoDownloadLabel("more_vert"), false);
  assert.equal(looksLikeOverflowMenuLabel("more_vert"), true);
  assert.equal(looksLikeOverflowMenuLabel("more_vert more_vert"), true);
  assert.equal(looksLikeOverflowMenuLabel("more_horiz"), true);
});
