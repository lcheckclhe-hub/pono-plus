-- PONO-PLUS 段階1 マイグレーション 0005
-- 目的: 業務日報（機能権限表 区分10）
--
-- 現行との対応（dreport2Template.php / dreport2updateAction.php で実証）:
--   tb_m_dr（106件）        -> daily_report_categories
--     DR_ID / DR_REMARKS1   -> id / name
--     ⚠ マスタ①メニューの「業務日報 > マスターデータ」がこのカテゴリ定義画面である
--   tb_m_d_report（231件）  -> daily_reports
--     REPORT_DAY            -> reported_on
--     REPORT_CATE1          -> category_id
--     REPORT_TIME1 / 2      -> start_time / end_time（日跨ぎは end_time を 24時超え表記で保持）
--     REPORT_REMARKS1       -> body
--     REPORT_PIC1           -> photo_object_key（R2。公開ディレクトリに置かない）
--
-- 🔴 現行から意図的に外した列:
--   REPORT_DATE_TIME1 / 2  検索用の日時。start_time/end_time と reported_on から導けるため持たない
--   REPORT_TIME3           差を「時間単位の小数」で保持していた。
--                          不変条件③「経過時間は INTEGER の分」に反するため duration_minutes に置換
--   REPORT_TIME4           差を 'HH:MM:SS' で二重に保持していた。表示側で整形する

CREATE TABLE daily_report_categories (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE INDEX idx_drc_tenant ON daily_report_categories(tenant_id, is_active);

-- end_time は日跨ぎを 24時超え表記で保持する（shifts と同じ作法・0001 参照）。
-- 負値バグを構造的に発生させない。
CREATE TABLE daily_reports (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  employee_id       TEXT NOT NULL REFERENCES employees(id),
  category_id       TEXT REFERENCES daily_report_categories(id),
  reported_on       TEXT NOT NULL,
  start_time        TEXT NOT NULL,
  end_time          TEXT NOT NULL,
  duration_minutes  INTEGER NOT NULL DEFAULT 0,
  body              TEXT,
  photo_object_key  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  CHECK (duration_minutes >= 0)
);
CREATE INDEX idx_dr_tenant_date ON daily_reports(tenant_id, reported_on);
CREATE INDEX idx_dr_employee_date ON daily_reports(employee_id, reported_on);
