-- PONO-PLUS 段階1 マイグレーション 0011
-- 目的: 雇用形態に 'assistant_manager'（副店長）を加える
--
-- 経緯（引継ぎシート Session 05 §5.6 / Session 06 で判断（a）を採用）:
--   現行 su2_w_style の値域は user2skillTemplate.php で確定している。
--     1=副店長 / 2=社員 / 3=アルバイト / 4=清掃員 / 5=（名称なし）
--   0001 では 1 を「マスタ②というロールであって雇用形態ではない」と解釈して
--   除外したが、現行画面は 1〜5 を雇用形態の選択肢として【並列に】並べている。
--   また副店長は人事権の有無と一対一で対応しないため、ロールに畳むと
--   段階2の is_hr_line 判定を誤らせる。よって雇用形態の値として復活させる。
--
-- ============================================================
-- 🔴 手順が特殊な理由（Session 06 で実証）
-- ============================================================
-- SQLite は CHECK 制約を後から変更できないため employees を作り直す。
-- employees は8箇所から外部キーで参照されている（shifts / shift_period_flags /
-- attendance_summaries / daily_reports / photo_posts / thanks×2 / skill_sheets）。
--
-- D1 はすべてのクエリを暗黙のトランザクションで実行し、PRAGMA foreign_keys は
-- 変更できない。代わりに PRAGMA defer_foreign_keys で違反の検査をトランザクション
-- 末尾まで遅らせる（Cloudflare D1 ドキュメント）。
--
-- ⚠ ただし defer だけでは足りない。DROP TABLE は暗黙の DELETE を伴い、
--   子行の数だけ「遅延違反カウンタ」が上がる。ALTER TABLE ... RENAME で
--   別名の表を employees に改名しても、このカウンタは戻らず COMMIT で
--   FOREIGN KEY constraint failed になる（実証: 全文が成功して COMMIT だけ失敗）。
--
-- ➡ カウンタを戻すには【親行を INSERT し直す】必要がある。
--   よって「退避 → DROP → 同名で作り直す → 入れ直す」の順にする。
--   RENAME は使わない。
--
-- 退避表は CREATE TABLE ... AS SELECT で作る。制約も外部キーも持たない
-- 素の表になるため、この間だけ CHECK 制約の外に置ける。

PRAGMA defer_foreign_keys = true;

-- 1. 退避（制約なしの素の表）
CREATE TABLE employees_stage AS SELECT * FROM employees;

-- 2. 破棄（ここで遅延違反カウンタが子行の数だけ上がる）
DROP TABLE employees;

-- 3. 同じ名前で作り直す
--    ⚠ 列は 0001 → 0002（default_shift_type_id）→ 0003（profile_text / profile_note）
--      の順に増えている。実機の列順を変えないため同じ順で並べる。
CREATE TABLE employees (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL REFERENCES tenants(id),
  worksite_id           TEXT REFERENCES worksites(id),
  account_id            TEXT REFERENCES accounts(id),
  employee_code         TEXT,
  name                  TEXT NOT NULL,
  name_kana             TEXT,
  birth_on              TEXT,
  gender                TEXT,
  hired_on              TEXT,
  resigned_on           TEXT,
  employment_type       TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  photo_object_key      TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  deleted_at            TEXT,
  default_shift_type_id TEXT REFERENCES shift_types(id),
  profile_text          TEXT,
  profile_note          TEXT,
  UNIQUE (tenant_id, employee_code),
  CHECK (employment_type IN ('assistant_manager','regular','part_time','cleaner','other')),
  CHECK (gender IS NULL OR gender IN ('male','female','other','undisclosed'))
);

-- 4. 入れ直す（親行が戻ることで遅延違反カウンタが下がる。ここが要）
INSERT INTO employees
  (id, tenant_id, worksite_id, account_id, employee_code, name, name_kana, birth_on,
   gender, hired_on, resigned_on, employment_type, status, photo_object_key,
   created_at, updated_at, deleted_at, default_shift_type_id, profile_text, profile_note)
SELECT
   id, tenant_id, worksite_id, account_id, employee_code, name, name_kana, birth_on,
   gender, hired_on, resigned_on, employment_type, status, photo_object_key,
   created_at, updated_at, deleted_at, default_shift_type_id, profile_text, profile_note
FROM employees_stage;

-- 5. 後始末（退避表は誰からも参照されていないので安全に落とせる）
DROP TABLE employees_stage;

-- 6. 索引を張り直す（DROP TABLE で一緒に消えている）
CREATE INDEX idx_employees_tenant ON employees(tenant_id, status);
CREATE INDEX idx_employees_worksite ON employees(worksite_id);
