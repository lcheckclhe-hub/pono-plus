-- PONO-PLUS 段階1 マイグレーション 0004
-- 目的: 「店舗情報」（機能権限表 区分4）＝ 月次の人事指標レポート
--
-- ⚠ 名称に反して店舗マスタではない。実体は募集・採用・離職を月ごとに記録する機能である
--    （company1Template.php / company1updateAction.php で実証・Session 04）。
--    店舗の名称・住所は worksites（0001）が持つ。
--
-- 現行との対応:
--   COMPANY1_Y + COMPANY1_M   -> period_year_month（'YYYY-MM'）
--   COMPANY1_RECRUIT          -> recruit_count
--   COMPANY1_HIRE             -> hire_count
--   COMPANY1_TURNOVER         -> turnover_count
--   COMPANY1_REMARKS2「予備管理」-> note（名称を「備考」に改める【会話合意 2026-08-16】）
--
-- 🔴 現行から意図的に外した列:
--   COMPANY1_SERVICE / COMPANY1_AGE（平均勤続・平均年齢）
--     保存時にサーバー側で算出して保存していたが、従業員データが変われば過去月の値も
--     変わるべきものであり、保存すると陳腐化する。新システムは都度算出する。
--   COMPANY1_OVERTIME
--     入力欄が画面に存在せず、常に空のまま保存されていた【コード実証】。
--   article_counter1_com3（年間集計）
--     【会話合意 2026-08-15 ⑥】集計テーブルは作らない。年間の値は都度合算する。

CREATE TABLE worksite_monthly_reports (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  -- 現行は 1アカウント = 1店舗だったが、新設計は会社の下に複数店舗を持てる
  worksite_id        TEXT REFERENCES worksites(id),
  period_year_month  TEXT NOT NULL,
  recruit_count      INTEGER NOT NULL DEFAULT 0,
  hire_count         INTEGER NOT NULL DEFAULT 0,
  turnover_count     INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  -- 同一店舗・同一年月は1件（現行 getcompany1c の重複チェックを制約で担保する）
  UNIQUE (tenant_id, worksite_id, period_year_month),
  CHECK (recruit_count >= 0),
  CHECK (hire_count >= 0),
  CHECK (turnover_count >= 0),
  CHECK (period_year_month LIKE '____-__')
);
CREATE INDEX idx_wmr_tenant_period ON worksite_monthly_reports(tenant_id, period_year_month);
