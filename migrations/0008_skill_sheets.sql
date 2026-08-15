-- PONO-PLUS 段階1 マイグレーション 0008
-- 目的: スキルシート（機能権限表 区分9）
--
-- ⚠ 勤怠評価とは別機能である【会話合意 2026-08-16】。
--    数字の項目（遅刻・早退・当欠）は重なるが、次の点で本質的に違う:
--      ・単位が「年度の月別一覧」（勤怠評価は締め日基準の期間）
--      ・本人が自分の分を直接見る画面がある（user3skill2Template.php_back で実証）
--      ・管理者が本人について書く「業務内容」を持つ＝人事評価の性格
--      ・本人に見える項目と管理者にしか見えない項目が分かれている
--
-- 現行との対応（user2skill1Template.php / user3skill2Template.php_back で実証）:
--   SKILL_U_ID     -> employee_id
--   SKILL_Y + SKILL_M -> period_year_month（'YYYY-MM'）
--   SKILL_LATE     -> late_count      （手入力）
--   SKILL_LEAVES   -> early_leave_count（手入力）
--   SKILL_ABSENCE  -> absence_count   （手入力）
--   SKILL_OVERTIME -> overtime_count  （手入力。🔴 本人の画面には出さない）
--   SKILL_COMMENT  -> comment         （業務内容）
--
-- 🔴 現行から意図的に変えた点:
--   ① comment_visible_to_employee を追加。
--      現行は業務内容が必ず本人に見えており、管理者が率直に書けない構造だった
--      （user3skill2Template.php_back L64 で本人画面に出力される）。
--      本人に見せる前提の記述と内部メモを書き分けられるようにする。
--   ② SKILL_AGE を持たない。
--      現行は hidden で年齢を送って保存していたが、birth_on から都度算出できる。
--      保存すると陳腐化する（店舗情報と同じ判断）。
--   ③ 出勤数・ありがとう数の列を持たない。
--      現行も別テーブルから引いて表示しているだけで、skill には保存していない。
--      新実装も shifts / thanks から都度算出する。

CREATE TABLE skill_sheets (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  employee_id        TEXT NOT NULL REFERENCES employees(id),
  period_year_month  TEXT NOT NULL,
  late_count         INTEGER NOT NULL DEFAULT 0,
  early_leave_count  INTEGER NOT NULL DEFAULT 0,
  absence_count      INTEGER NOT NULL DEFAULT 0,
  -- 🔴 本人の画面には出さない（現行のマスタ③画面に列が無い）
  overtime_count     INTEGER NOT NULL DEFAULT 0,
  comment            TEXT,
  -- 1 = 本人にも見せる / 0 = 管理者のみ。既定は「管理者のみ」（安全側）
  comment_visible_to_employee INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT,
  UNIQUE (employee_id, period_year_month),
  CHECK (late_count >= 0),
  CHECK (early_leave_count >= 0),
  CHECK (absence_count >= 0),
  CHECK (overtime_count >= 0),
  CHECK (comment_visible_to_employee IN (0,1)),
  CHECK (period_year_month LIKE '____-__')
);
CREATE INDEX idx_skill_tenant_period ON skill_sheets(tenant_id, period_year_month);
CREATE INDEX idx_skill_employee ON skill_sheets(employee_id, period_year_month);
