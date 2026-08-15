-- PONO-PLUS 段階1 マイグレーション 0007
-- 目的: ありがとう情報（機能権限表 区分7）
--
-- 現行との対応（thanks2Template.php / thanks2updateAction.php で実証）:
--   THANKS1_U_ID     -> from_employee_id（送った人）
--   THANKS1_P_ID     -> to_employee_id（受け取った人）
--   THANKS1_C_ID     -> tenant_id
--   THANKS1_REMARKS1 -> message（画面ラベル「フリー入力」）
--   THANKS1_UPDATE2  -> thanked_on（画面で選ぶ日付）
--   THANKS1_UPDATE1  -> period_year_month（締め日基準で決まる集計対象月）
--
-- 🔴 現行が持っていた集計テーブル5本は作らない【会話合意 2026-08-15 ⑥】:
--   article_counter1（444件）        送った人の月間カウント
--   article_counter1_total（2,314件） ユーザー別の月毎カウント
--   article_counter1_total1（978件）  アカウント別の月毎カウント
--   article_counter1_total2（94件）   累計
--   article_counter1_rank（890件）    獲得順位
--   ➡ 1回の「ありがとう」で本体1件＋集計5件の計6回書き込んでいた。
--      すべて thanks の実データから都度算出できるため、保存しない。
--
-- ⚠ period_year_month は締め日基準で決まるため、thanked_on から一意に導けない。
--    テナントの cutoff_day に依存するので列として保持する。

CREATE TABLE thanks (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  from_employee_id   TEXT NOT NULL REFERENCES employees(id),
  to_employee_id     TEXT NOT NULL REFERENCES employees(id),
  message            TEXT,
  thanked_on         TEXT NOT NULL,
  -- 締め日を考慮した集計対象月（'YYYY-MM'）
  period_year_month  TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  -- 🔴 自分自身には送れない（ランキングの自作自演を防ぐ）【会話合意 2026-08-16】
  CHECK (from_employee_id <> to_employee_id),
  CHECK (period_year_month LIKE '____-__')
);
CREATE INDEX idx_thanks_tenant_period ON thanks(tenant_id, period_year_month);
CREATE INDEX idx_thanks_to ON thanks(to_employee_id, period_year_month);
CREATE INDEX idx_thanks_from ON thanks(from_employee_id, period_year_month);
