-- 論文の業界選択肢を13個に見直す

-- 1. 新しい13個以外の旧選択肢・自由入力値を削除
delete from public.picklist_options
where category = 'paper_industry'
  and value not in (
    'AI・データ',
    'IT・通信',
    '半導体・電子デバイス',
    'エネルギー・資源',
    '宇宙・天文',
    '基礎科学（物理・数学）',
    '医療・ライフサイエンス',
    '農業・食品',
    'ロボティクス',
    '建設・インフラ',
    '経済・金融',
    '言語・教育',
    'その他'
  );

-- 2. 新しい選択肢を追加
insert into public.picklist_options (category, value, sort_order) values
  ('paper_industry', 'AI・データ', 10),
  ('paper_industry', 'IT・通信', 20),
  ('paper_industry', '半導体・電子デバイス', 30),
  ('paper_industry', 'エネルギー・資源', 40),
  ('paper_industry', '宇宙・天文', 50),
  ('paper_industry', '基礎科学（物理・数学）', 60),
  ('paper_industry', '医療・ライフサイエンス', 70),
  ('paper_industry', '農業・食品', 80),
  ('paper_industry', 'ロボティクス', 90),
  ('paper_industry', '建設・インフラ', 100),
  ('paper_industry', '経済・金融', 110),
  ('paper_industry', '言語・教育', 120),
  ('paper_industry', 'その他', 9999)
on conflict (category, value) where (
  scope_school_name is null
  and (scope_department_value is null or btrim(scope_department_value) = '')
) do nothing;

-- 3. 既存の IT・通信 や その他 を含め、並び順を指定順に揃える
update public.picklist_options
set sort_order = case value
  when 'AI・データ' then 10
  when 'IT・通信' then 20
  when '半導体・電子デバイス' then 30
  when 'エネルギー・資源' then 40
  when '宇宙・天文' then 50
  when '基礎科学（物理・数学）' then 60
  when '医療・ライフサイエンス' then 70
  when '農業・食品' then 80
  when 'ロボティクス' then 90
  when '建設・インフラ' then 100
  when '経済・金融' then 110
  when '言語・教育' then 120
  when 'その他' then 9999
  else sort_order
end
where category = 'paper_industry';

notify pgrst, 'reload schema';
