-- PONO-PLUS 段階1 初期マイグレーション
-- 出典: PONO-PLUS_段階1_新DBスキーマ設計_v2.md (md5 7418945f0282d23ad0b793b2433e1d85)
-- 対象: Cloudflare D1 (SQLite)
-- 原則: 全業務テーブルに tenant_id 必須 / flg1..10 型の汎用列を作らない / 日時はUTC ISO8601 / 経過時間はINTEGER(分)
-- 【会話合意 2026-08-15】現行データは移行しない。旧ID保持用の legacy_* 列は作らない

PRAGMA foreign_keys = ON;

-- ============================================================
-- 3. SaaS 基盤
-- ============================================================

CREATE TABLE tenants (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  name_kana         TEXT,
  cutoff_day        INTEGER NOT NULL DEFAULT 31,
  timezone          TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  status            TEXT NOT NULL DEFAULT 'active',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  CHECK (cutoff_day BETWEEN 1 AND 31),
  CHECK (status IN ('active','suspended','terminated'))
);
CREATE INDEX idx_tenants_status ON tenants(status);

CREATE TABLE worksites (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  name         TEXT NOT NULL,
  address      TEXT,
  is_primary   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX idx_worksites_tenant ON worksites(tenant_id);

CREATE TABLE plans (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  max_employees  INTEGER,
  monthly_price  INTEGER,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE contracts (
  id                 TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL REFERENCES tenants(id),
  plan_id            TEXT NOT NULL REFERENCES plans(id),
  started_on         TEXT NOT NULL,
  ended_on           TEXT,
  termination_reason TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_contracts_tenant ON contracts(tenant_id, started_on);

CREATE TABLE policy_documents (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  version       TEXT NOT NULL,
  body_url      TEXT NOT NULL,
  effective_at  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (kind, version)
);

-- account_id に FK を張らない: 退会でアカウントを物理削除しても同意の事実は残す (設計 3.4)
-- tenant_id にも FK を張らない: テナント解約後も同意の事実は残すため
CREATE TABLE consent_logs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  document_id   TEXT NOT NULL REFERENCES policy_documents(id),
  consented_at  TEXT NOT NULL,
  ip_address    TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_consent_account ON consent_logs(account_id, consented_at);

CREATE TABLE audit_logs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT,
  actor_id      TEXT,
  actor_role    TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT,
  ip_address    TEXT,
  occurred_at   TEXT NOT NULL
);
CREATE INDEX idx_audit_tenant_time ON audit_logs(tenant_id, occurred_at);
CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id);

CREATE TABLE retention_policies (
  id             TEXT PRIMARY KEY,
  data_kind      TEXT NOT NULL UNIQUE,
  retain_months  INTEGER NOT NULL,
  basis          TEXT NOT NULL,
  legal_source   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE deletion_jobs (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  kind           TEXT NOT NULL,
  scheduled_at   TEXT NOT NULL,
  executed_at    TEXT,
  result_summary TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_deletion_scheduled ON deletion_jobs(scheduled_at) WHERE executed_at IS NULL;

-- ============================================================
-- 4. 認証・権限
-- ============================================================

-- 平文パスワード列は存在しない (現行 su1_rem1 / su2_rem1 の201件を再発させない)
CREATE TABLE accounts (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT REFERENCES tenants(id),
  login_id             TEXT NOT NULL,
  email                TEXT,
  password_hash        TEXT NOT NULL,
  password_algo        TEXT NOT NULL,
  password_updated_at  TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'active',
  last_login_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (tenant_id, login_id),
  CHECK (status IN ('active','suspended','locked'))
);

-- is_hr_line: 人事権系統に属するか。段階2でストレスチェック結果から構造的に排除するための列
-- 根拠: 労働安全衛生規則第52条の10第2項 (改修設計書 5.3(1) / 7.2)
CREATE TABLE roles (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  is_hr_line    INTEGER NOT NULL,
  description   TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE account_roles (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  role_id      TEXT NOT NULL REFERENCES roles(id),
  scope_type   TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  granted_at   TEXT NOT NULL,
  revoked_at   TEXT,
  UNIQUE (account_id, role_id, scope_type, scope_id),
  CHECK (scope_type IN ('tenant','worksite'))
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  tenant_id    TEXT,
  issued_at    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  ip_address   TEXT,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE password_reset_tokens (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id),
  token_hash   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE login_attempts (
  id            TEXT PRIMARY KEY,
  login_id      TEXT NOT NULL,
  tenant_id     TEXT,
  succeeded     INTEGER NOT NULL,
  ip_address    TEXT,
  attempted_at  TEXT NOT NULL
);
CREATE INDEX idx_login_attempts ON login_attempts(login_id, attempted_at);

-- ============================================================
-- 5. マスタ
-- ============================================================

CREATE TABLE employees (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  worksite_id       TEXT REFERENCES worksites(id),
  account_id        TEXT REFERENCES accounts(id),
  employee_code     TEXT,
  name              TEXT NOT NULL,
  name_kana         TEXT,
  birth_on          TEXT,
  -- 現行 pd_sec1（1=男性 / 2=女性）に相当。index2.html で実証
  -- 新設計では数値コードではなく意味のある文字列で保持する
  gender            TEXT,
  hired_on          TEXT,
  resigned_on       TEXT,
  employment_type   TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active',
  photo_object_key  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  UNIQUE (tenant_id, employee_code),
  CHECK (employment_type IN ('regular','part_time','cleaner','other')),
  CHECK (gender IS NULL OR gender IN ('male','female','other','undisclosed'))
);
CREATE INDEX idx_employees_tenant ON employees(tenant_id, status);
CREATE INDEX idx_employees_worksite ON employees(worksite_id);

-- ============================================================
-- 6. シフト
-- ============================================================

CREATE TABLE shift_types (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  start_time   TEXT,
  end_time     TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (tenant_id, code)
);

-- clock_out は日跨ぎを 24時超え表記で保持する (例 30:00)。負値バグを構造的に発生させない
CREATE TABLE shifts (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  worksite_id      TEXT REFERENCES worksites(id),
  employee_id      TEXT NOT NULL REFERENCES employees(id),
  worked_on        TEXT NOT NULL,
  shift_type_id    TEXT REFERENCES shift_types(id),
  clock_in         TEXT,
  clock_out        TEXT,
  break_minutes    INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  worked_minutes   INTEGER NOT NULL DEFAULT 0,
  is_absent        INTEGER NOT NULL DEFAULT 0,
  is_late          INTEGER NOT NULL DEFAULT 0,
  is_early_leave   INTEGER NOT NULL DEFAULT 0,
  note             TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT,
  UNIQUE (employee_id, worked_on, shift_type_id),
  CHECK (worked_minutes >= 0),
  CHECK (break_minutes >= 0),
  CHECK (overtime_minutes >= 0)
);
CREATE INDEX idx_shifts_tenant_date ON shifts(tenant_id, worked_on);
CREATE INDEX idx_shifts_employee_date ON shifts(employee_id, worked_on);

-- 現行 tb_m_shift1（user1flg1shift1insert）に相当。シフトの確定状態
-- 対象期間は「従業員 × 締め期間の開始日」で一意。現行の (u_id, c_id, day1) に対応
CREATE TABLE shift_confirmations (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL REFERENCES tenants(id),
  employee_id      TEXT NOT NULL REFERENCES employees(id),
  period_start_on  TEXT NOT NULL,
  is_confirmed     INTEGER NOT NULL DEFAULT 0,
  confirmed_at     TEXT,
  confirmed_by     TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (employee_id, period_start_on)
);
CREATE INDEX idx_shift_conf_tenant ON shift_confirmations(tenant_id, period_start_on);

-- ============================================================
-- 7. 勤怠評価
-- ============================================================

CREATE TABLE attendance_summaries (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  employee_id       TEXT NOT NULL REFERENCES employees(id),
  period_start_on   TEXT NOT NULL,
  period_end_on     TEXT NOT NULL,
  work_days         INTEGER NOT NULL DEFAULT 0,
  worked_minutes    INTEGER NOT NULL DEFAULT 0,
  overtime_minutes  INTEGER NOT NULL DEFAULT 0,
  late_count        INTEGER NOT NULL DEFAULT 0,
  early_leave_count INTEGER NOT NULL DEFAULT 0,
  absence_count     INTEGER NOT NULL DEFAULT 0,
  calculated_at     TEXT NOT NULL,
  UNIQUE (employee_id, period_start_on)
);
CREATE INDEX idx_att_tenant_period ON attendance_summaries(tenant_id, period_start_on);
