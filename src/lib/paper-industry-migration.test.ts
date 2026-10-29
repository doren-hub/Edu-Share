import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const expected = [
  "AI・データ", "IT・通信", "半導体・電子デバイス", "エネルギー・資源", "宇宙・天文",
  "基礎科学（物理・数学）", "医療・ライフサイエンス", "農業・食品", "ロボティクス",
  "建設・インフラ", "経済・金融", "言語・教育", "その他",
];

test("036: 13業界の表記・順序・再実行と既存論文の保護", async () => {
  // In-memory PostgreSQL fixtures only; no connection to any local/remote service.
  const db = new PGlite();
  const read = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), "utf8");
  try {
    const table = read("006_picklist_options.sql").match(/create table if not exists public\.picklist_options \([\s\S]*?\n\);/)![0];
    const index = read("011_exam_subject_period_department_scope.sql").match(/create unique index picklist_options_global_cat_value[\s\S]*?;/)![0];
    await db.exec(`${table}
      alter table public.picklist_options drop constraint picklist_options_category_value_unique;
      alter table public.picklist_options add column scope_school_name text;
      alter table public.picklist_options add column scope_department_value text;
      ${index}
      insert into public.picklist_options (category, value, sort_order) values
        ('paper_industry', 'IT・通信', -100), ('paper_industry', 'その他', 0),
        ('paper_industry', '農業・食品', -200), ('paper_industry', '教育・研究', 1),
        ('paper_industry', 'AI', 2), ('paper_industry', '電子ペーパー', 3),
        ('school_name', 'fixture school', 7);
      create table public.tests (paper_industry text, industries text[]);
      insert into public.tests values ('教育・研究', array['教育・研究', 'AI']);
    `);
    const migration = read("036_paper_industry_options_13.sql");
    for (let i = 0; i < 2; i++) {
      await db.exec(migration);
      const rows = await db.query<{ value: string }>("select value from public.picklist_options where category = 'paper_industry' order by sort_order, value");
      assert.deepEqual(rows.rows.map(row => row.value), expected);
      assert.deepEqual((await db.query("select value, sort_order from public.picklist_options where category = 'school_name'")).rows,
        [{ value: "fixture school", sort_order: 7 }]);
      assert.deepEqual((await db.query("select * from public.tests")).rows,
        [{ paper_industry: "教育・研究", industries: ["教育・研究", "AI"] }]);
    }
  } finally {
    await db.close();
  }
});
