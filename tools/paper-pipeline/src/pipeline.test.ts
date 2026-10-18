import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import type { AppConfig } from "./config.ts";
import { emptyState, loadState, saveState } from "./state.ts";
import { MAX_DESC_REPAIR_ATTEMPTS, repairPaperDescriptions } from "./pipeline.ts";
import { harvestBackoffMs } from "./waiting.ts";

for (const outcome of ["failure", "success", "scan"] as const) {
  test(`説明補修: ${outcome}・予約を開く前に永続化し、クールダウンと上限を守る`, async () => {
    const root = mkdtempSync(join(tmpdir(), "desc-repair-"));
    try {
      const state = emptyState({ filename: "paper.pdf", paperDir: join(root, "paper"), inboxPdfPath: join(root, "paper.pdf") });
      state.eduShareTestId = "test";
      state.eduShareTestUrl = "https://example.test/tests/test";
      saveState(state);
      const cfg = { workDir: root, onlyFilename: "paper.pdf", scispaceFolderUrl: "https://example.test/folder" } as AppConfig;
      let now = Date.parse("2026-10-19T00:00:00Z");
      let opened = 0;
      const reload = () => loadState(state.paperDir, state);
      const deps = {
        now: () => now,
        extractPdfText: async () => outcome === "scan" ? "image" : "text ".repeat(100),
        recoverStuckPage: async () => {
          const saved = reload();
          assert.ok(Date.parse(saved.descRepairRetryAt) > now);
          assert.ok(saved.descRepairAttempts > 0);
          return true;
        },
        captureSciSpaceCardMeta: async (_page: Page, opts: { state: typeof state }) => {
          opened++;
          if (outcome === "failure") throw new Error("test capture failure");
          opts.state.tldr = "本研究では、量子コンピュータの計算精度を向上させる新しい誤り訂正手法を検証した。実験により、従来手法と比較して誤り率が大幅に低下し、計算資源を効率的に利用できることを明らかにした。";
        },
        applySciSpaceMetaToPaperPage: async () => {},
      };
      const run = () => repairPaperDescriptions({} as Page, cfg, deps);
      await run();
      assert.equal(opened, outcome === "scan" ? 0 : 1);
      await run();
      assert.equal(opened, outcome === "scan" ? 0 : 1);
      if (outcome === "failure") {
        now += harvestBackoffMs(0);
        await run();
        assert.equal(opened, 2);
        for (let i = 2; i < MAX_DESC_REPAIR_ATTEMPTS; i++) {
          now = Date.parse(reload().descRepairRetryAt);
          await run();
        }
        assert.match(reload().descRepairGaveUp, /上限/);
        now += 86_400_000;
        await run();
        assert.equal(opened, MAX_DESC_REPAIR_ATTEMPTS);
      } else if (outcome === "success") {
        assert.equal(reload().descRepairAttempts, 0);
        assert.equal(reload().descRepairRetryAt, "");
      } else {
        assert.match(reload().descRepairGaveUp, /スキャン/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
