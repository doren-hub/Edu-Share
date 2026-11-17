import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditAuthors } from "./audit-authors.ts";

test("auditAuthors: 固定の入力に対して「未設定」「おかしい値」「補える候補」を正しく分類・抽出する", async () => {
  const root = mkdtempSync(join(tmpdir(), "audit-authors-test-"));
  try {
    // 1. 未設定: filesPaste / author ともになし、PDF 1ページ目から補える
    const paper1Dir = join(root, "paper1");
    mkdirSync(paper1Dir);
    writeFileSync(
      join(paper1Dir, "state.json"),
      JSON.stringify({
        filename: "paper1.pdf",
        title: "自然言語処理の研究",
        author: "",
        filesPaste: "",
      }),
    );
    writeFileSync(join(paper1Dir, "paper1.pdf"), "dummy-pdf");

    // 2. おかしい値: 既存の state.json で author 欄がなく、filesPaste が "Authors: III"
    //    DOI から Crossref 照会で補える
    const paper2Dir = join(root, "paper2");
    mkdirSync(paper2Dir);
    writeFileSync(
      join(paper2Dir, "state.json"),
      JSON.stringify({
        filename: "paper2.pdf",
        title: "Wave Mechanics",
        doi: "10.1234/wave.1",
        filesPaste: "Authors: III",
      }),
    );

    // 3. おかしい値: 既存の state.json で author 欄がなく、filesPaste が "2024 · DOI"、補完元なし
    const paper3Dir = join(root, "paper3");
    mkdirSync(paper3Dir);
    writeFileSync(
      join(paper3Dir, "state.json"),
      JSON.stringify({
        filename: "paper3.pdf",
        title: "Some Paper",
        filesPaste: "2024 · DOI",
      }),
    );

    // 4. 正常な著者: "Jane Doe"
    const paper4Dir = join(root, "paper4");
    mkdirSync(paper4Dir);
    writeFileSync(
      join(paper4Dir, "state.json"),
      JSON.stringify({
        filename: "paper4.pdf",
        title: "Valid Paper",
        author: "Jane Doe",
        filesPaste: "",
      }),
    );

    // 5. 参考文献の DOI: 本文後方に引用 DOI があっても誤って拾わず、題名不一致の Crossref は採用しない
    const paper5Dir = join(root, "paper5");
    mkdirSync(paper5Dir);
    writeFileSync(
      join(paper5Dir, "state.json"),
      JSON.stringify({
        filename: "paper5.pdf",
        title: "Autonomous Systems Survey",
        filesPaste: "",
      }),
    );
    writeFileSync(join(paper5Dir, "paper5.pdf"), "dummy-pdf");

    const fakeDeps = {
      extractPdfText: async (path: string) => {
        if (path.includes("paper1")) {
          return `
自然言語処理の研究
山田 太郎†
†東京大学
要旨
...
`;
        }
        if (path.includes("paper5")) {
          // 3000 文字以降の参考文献セクションに他論文の DOI がある
          return "A".repeat(3500) + "\nReferences\n[1] Smith et al. https://doi.org/10.1000/cited.ref\n";
        }
        return undefined;
      },
      fetchCrossrefWork: async (doi: string) => {
        if (doi === "10.1234/wave.1") {
          return {
            title: "Wave Mechanics",
            authors: ["Hugh Everett, III"],
            year: "1957",
            venue: "Rev. Mod. Phys.",
            doi,
          };
        }
        if (doi === "10.1000/cited.ref") {
          return {
            title: "Cited Paper Title",
            authors: ["Wrong Cited Author"],
            year: "2010",
            venue: "Cited Venue",
            doi,
          };
        }
        return null;
      },
    };

    const res = await auditAuthors({ workDir: root, deps: fakeDeps });

    assert.equal(res.total, 5);
    assert.equal(res.okCount, 1);
    assert.equal(res.unsetCount, 2);
    assert.equal(res.invalidCount, 2);
    assert.equal(res.recoverableCount, 2);
    assert.equal(res.items.length, 4);

    const item1 = res.items.find((i) => i.paper === "paper1");
    assert.ok(item1);
    assert.equal(item1.status, "unset");
    assert.equal(item1.candidateAuthor, "山田 太郎");
    assert.equal(item1.candidateSource, "pdf");

    const item2 = res.items.find((i) => i.paper === "paper2");
    assert.ok(item2);
    assert.equal(item2.status, "invalid");
    assert.equal(item2.candidateAuthor, "Hugh Everett, III");
    assert.equal(item2.candidateSource, "doi");

    const item3 = res.items.find((i) => i.paper === "paper3");
    assert.ok(item3);
    assert.equal(item3.status, "invalid");
    assert.equal(item3.candidateAuthor, null);
    assert.equal(item3.candidateSource, null);

    const item5 = res.items.find((i) => i.paper === "paper5");
    assert.ok(item5);
    assert.equal(item5.status, "unset");
    assert.equal(item5.candidateAuthor, null);
    assert.equal(item5.candidateSource, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
