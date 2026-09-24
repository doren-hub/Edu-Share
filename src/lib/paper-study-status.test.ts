import assert from "node:assert/strict";
import test from "node:test";
import {
  PAPER_STUDY_STATUS_LABEL,
  PAPER_STUDY_STATUSES,
  humanizePaperStudyStatusDbError,
  paperMatchesStudyStatus,
  paperStudyStatusFromStored,
  parsePaperStudyStatus,
} from "./paper-study-status.ts";

test("学習ステータスは5つで、表示名が付く", () => {
  assert.deepEqual(PAPER_STUDY_STATUSES, [
    "unconfirmed",
    "checking",
    "confirmed",
    "learning",
    "completed",
  ]);
  assert.deepEqual(
    PAPER_STUDY_STATUSES.map((status) => PAPER_STUDY_STATUS_LABEL[status]),
    ["未確認", "確認中", "確認済み", "学習中", "学習済み"],
  );
});

test("画面から渡せる値だけを受け付ける", () => {
  assert.equal(parsePaperStudyStatus("unconfirmed"), "unconfirmed");
  assert.equal(parsePaperStudyStatus("checking"), "checking");
  assert.equal(parsePaperStudyStatus("confirmed"), "confirmed");
  assert.equal(parsePaperStudyStatus("content_confirmed"), null);
  assert.equal(parsePaperStudyStatus("learning"), "learning");
  assert.equal(parsePaperStudyStatus("completed"), "completed");
  assert.equal(parsePaperStudyStatus("未確認"), null);
  assert.equal(parsePaperStudyStatus(""), null);
  assert.equal(parsePaperStudyStatus(null), null);
});

test("保存値以外は未確認になる", () => {
  assert.equal(paperStudyStatusFromStored("learning"), "learning");
  assert.equal(paperStudyStatusFromStored("checking"), "checking");
  assert.equal(paperStudyStatusFromStored("confirmed"), "confirmed");
  assert.equal(paperStudyStatusFromStored("content_confirmed"), "unconfirmed");
  assert.equal(paperStudyStatusFromStored("completed"), "completed");
  assert.equal(paperStudyStatusFromStored(null), "unconfirmed");
  assert.equal(paperStudyStatusFromStored("unconfirmed"), "unconfirmed");
  assert.equal(paperStudyStatusFromStored("ready"), "unconfirmed");
});

test("絞り込みは未設定を未確認として扱う", () => {
  assert.equal(paperMatchesStudyStatus(undefined, ""), true);
  assert.equal(paperMatchesStudyStatus(undefined, "unconfirmed"), true);
  assert.equal(paperMatchesStudyStatus(undefined, "learning"), false);
  assert.equal(paperMatchesStudyStatus("learning", "learning"), true);
  assert.equal(paperMatchesStudyStatus("completed", "unconfirmed"), false);
});

test("テーブル未作成と過去問は文言にする", () => {
  assert.match(
    humanizePaperStudyStatusDbError(
      'relation "public.paper_study_statuses" does not exist',
    ),
    /026_paper_study_status\.sql/,
  );
  assert.match(
    humanizePaperStudyStatusDbError("paper_study_status_not_paper"),
    /過去問/,
  );
  assert.equal(humanizePaperStudyStatusDbError("timeout"), "");
});
