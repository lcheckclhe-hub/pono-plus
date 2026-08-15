/**
 * PONO-PLUS 段階1 — 業務ロジックレイヤ
 *
 * シフト計算 / 認証 / 従業員登録 / 退会・解約削除。
 * 統合元: domain/shift.ts + services/auth.ts + services/registration.ts + services/deletion.ts
 */
import {
  parseClock, normalizeClockOut, addDays, nowUtc, toJstCalendarDate,
  hashPassword, verifyPassword, needsRehash, equalizeTiming, ALGO_LABEL, sha256Hex, tenureYearsMonths,
} from "./core.ts";
import type { CalendarDate, ClockTime, Minutes } from "./core.ts";

export { sha256Hex };

// ===============================================================
// shift.ts
// ===============================================================
/**
 * シフト計算
 *
 * 実働時間 = (退勤 − 出勤) + 残業 − 休憩   … 改修設計書 v6 4.13.1【コード実証】
 * 現行のバグ B-1/B-2/B-4 をここで構造的に排除する。
 */

export interface ShiftInput {
  clockIn: ClockTime;
  clockOut: ClockTime;
  breakMinutes: Minutes;
  overtimeMinutes: Minutes;
}

export class ShiftValidationError extends Error {}

/**
 * 実働時間を分で返す。
 * B-2: 日跨ぎは normalizeClockOut で 24 超え表記に正規化してから引くため負値にならない。
 * B-4: タイムスタンプ整形を経由しないため9時間オフセットが発生しない。
 */
export function calcWorkedMinutes(input: ShiftInput): Minutes {
  const { clockIn, breakMinutes, overtimeMinutes } = input;
  if (breakMinutes < 0 || overtimeMinutes < 0) {
    throw new ShiftValidationError("break/overtime must be >= 0");
  }
  const inMin = parseClock(clockIn);
  const outMin = parseClock(normalizeClockOut(clockIn, input.clockOut));
  const span = outMin - inMin;
  const worked = span + overtimeMinutes - breakMinutes;
  if (worked < 0) {
    // 休憩が拘束時間を超えるなど、入力自体が矛盾している場合のみ到達する
    throw new ShiftValidationError(
      `worked_minutes would be negative (span=${span}, overtime=${overtimeMinutes}, break=${breakMinutes})`
    );
  }
  return worked;
}

/**
 * 締め日基準の集計期間を返す。
 * 現行 getCutoffRange 相当（設計書 4.13.2）。cutoffDay=31 は月末締め。
 * ⚠【設計案】現行の分岐の細部（月末が31日未満の月の扱い）は未確認のため、
 *   ここでは「当月の存在する最終日」に丸める実装とする。
 */
export function getCutoffRange(yearMonth: string, cutoffDay: number): { start: CalendarDate; end: CalendarDate } {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) throw new ShiftValidationError(`invalid yearMonth: ${yearMonth}`);
  if (!Number.isInteger(cutoffDay) || cutoffDay < 1 || cutoffDay > 31) {
    throw new ShiftValidationError(`invalid cutoffDay: ${cutoffDay}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new ShiftValidationError(`invalid month: ${yearMonth}`);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (cutoffDay >= lastDay) {
    // 月末締め: 当月1日 〜 当月末日
    const start = `${m[1]}-${m[2]}-01`;
    const end = `${m[1]}-${m[2]}-${String(lastDay).padStart(2, "0")}`;
    return { start, end };
  }
  // 例: cutoffDay=20 → 前月21日 〜 当月20日
  const end = `${m[1]}-${m[2]}-${String(cutoffDay).padStart(2, "0")}`;
  const prev = new Date(Date.UTC(year, month - 2, 1));
  const py = prev.getUTCFullYear();
  const pm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  const prevLast = new Date(Date.UTC(py, prev.getUTCMonth() + 1, 0)).getUTCDate();
  const startDay = Math.min(cutoffDay + 1, prevLast);
  const start = `${py}-${pm}-${String(startDay).padStart(2, "0")}`;
  return { start, end };
}

/**
 * 勤務区分別の件数を集計する。
 * B-1: 現行の集計SQLは `COUNT(shift_flg1>'0')` を区分1の件数として保存しており、
 *      常に合計と同値になっていた（設計書 4.13.3）。ここでは区分ごとに厳密一致で数える。
 */
export function countByShiftType(
  rows: Array<{ shiftTypeCode: string | null }>,
  codes: string[]
): { byCode: Record<string, number>; total: number } {
  const byCode: Record<string, number> = {};
  for (const c of codes) byCode[c] = 0;
  let total = 0;
  for (const r of rows) {
    total += 1;
    if (r.shiftTypeCode !== null && Object.prototype.hasOwnProperty.call(byCode, r.shiftTypeCode)) {
      byCode[r.shiftTypeCode] += 1;
    }
  }
  return { byCode, total };
}

/**
 * ある勤務日が属する締め期間を返す。
 * 例: 締め日20日で 2026-07-25 → 期間は 2026-07-21〜2026-08-20（yearMonth = 2026-08）
 */
export function periodForDate(
  workedOn: CalendarDate,
  cutoffDay: number
): { yearMonth: string; start: CalendarDate; end: CalendarDate } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(workedOn);
  if (m === null) throw new ShiftValidationError(`invalid workedOn: ${workedOn}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();

  // 月末締めは当月がそのまま期間
  if (cutoffDay >= lastDay) {
    const ym = `${m[1]}-${m[2]}`;
    return { yearMonth: ym, ...getCutoffRange(ym, cutoffDay) };
  }
  // 締め日を過ぎていれば翌月の期間に属する
  const shift = d > cutoffDay ? 1 : 0;
  const target = new Date(Date.UTC(y, mo - 1 + shift, 1));
  const ym = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}`;
  return { yearMonth: ym, ...getCutoffRange(ym, cutoffDay) };
}

/** 期間内の日を列挙する（集計テーブルを持たない方針のため、都度算出で使う） */
export function eachDate(start: CalendarDate, end: CalendarDate): CalendarDate[] {
  const out: CalendarDate[] = [];
  let cur = start;
  let guard = 0;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
    if (++guard > 400) throw new ShiftValidationError("range too long");
  }
  return out;
}

// ===============================================================
// auth.ts
// ===============================================================
/**
 * 認証サービス
 *
 * 設計根拠:
 *  - 改修設計書 6.2.1/6.2.2: 現行は平文併存保存＋共有ソルト SHA-256
 *  - 同 4.14.1: セッションにロールを保存していなかった（本設計では意図的に保存しない）
 *  - PoC-F 報告書 6章: タイミング均一化・レート制限をハッシュ強度と一体で設計する
 */


const SESSION_TTL_MINUTES = 60 * 8;
const LOCKOUT_WINDOW_MINUTES = 15;
const LOCKOUT_THRESHOLD = 5;

export interface LoginInput {
  loginId: string;
  password: string;
  tenantId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export type LoginResult =
  | { ok: true; token: string; accountId: string; expiresAt: string }
  | { ok: false; reason: "invalid_credentials" | "rate_limited" | "account_inactive" };

function minutesAgoUtc(minutes: number): string {
  return nowUtc(new Date(Date.now() - minutes * 60_000));
}

function minutesAheadUtc(minutes: number): string {
  return nowUtc(new Date(Date.now() + minutes * 60_000));
}

export async function login(db: D1Database, input: LoginInput): Promise<LoginResult> {
  // レート制限（ハッシュが重いこと自体を DoS の的にしないため先に判定する）
  const recent = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM login_attempts
        WHERE login_id = ?1 AND succeeded = 0 AND attempted_at > ?2`
    )
    .bind(input.loginId, minutesAgoUtc(LOCKOUT_WINDOW_MINUTES))
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= LOCKOUT_THRESHOLD) {
    await recordAttempt(db, input, false);
    return { ok: false, reason: "rate_limited" };
  }

  const account = await db
    .prepare(
      `SELECT id, tenant_id, password_hash, status FROM accounts
        WHERE login_id = ?1 AND (tenant_id = ?2 OR (?2 IS NULL AND tenant_id IS NULL))`
    )
    .bind(input.loginId, input.tenantId)
    .first<{ id: string; tenant_id: string | null; password_hash: string; status: string }>();

  if (account === null) {
    // アカウント不存在でもハッシュ相当の時間を消費する（応答時間から存在を推測させない）
    await equalizeTiming();
    await recordAttempt(db, input, false);
    return { ok: false, reason: "invalid_credentials" };
  }

  const valid = await verifyPassword(input.password, account.password_hash);
  if (!valid) {
    await recordAttempt(db, input, false);
    return { ok: false, reason: "invalid_credentials" };
  }
  if (account.status !== "active") {
    await recordAttempt(db, input, false);
    return { ok: false, reason: "account_inactive" };
  }

  // パラメータが旧世代なら、検証成功したこの場で再ハッシュする
  if (needsRehash(account.password_hash)) {
    const { hash } = await hashPassword(input.password);
    await db
      .prepare(`UPDATE accounts SET password_hash = ?1, password_algo = ?2, password_updated_at = ?3 WHERE id = ?4`)
      .bind(hash, ALGO_LABEL, nowUtc(), account.id)
      .run();
  }

  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256Hex(token); // 平文トークンは保存しない
  const expiresAt = minutesAheadUtc(SESSION_TTL_MINUTES);

  await db
    .prepare(
      `INSERT INTO sessions (id, account_id, tenant_id, issued_at, expires_at, ip_address, user_agent)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`
    )
    .bind(tokenHash, account.id, account.tenant_id, nowUtc(), expiresAt, input.ip, input.userAgent)
    .run();

  await db.prepare(`UPDATE accounts SET last_login_at = ?1 WHERE id = ?2`).bind(nowUtc(), account.id).run();
  await recordAttempt(db, input, true);

  return { ok: true, token, accountId: account.id, expiresAt };
}

export async function logout(db: D1Database, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await db.prepare(`UPDATE sessions SET revoked_at = ?1 WHERE id = ?2`).bind(nowUtc(), tokenHash).run();
}

async function recordAttempt(db: D1Database, input: LoginInput, succeeded: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO login_attempts (id, login_id, tenant_id, succeeded, ip_address, attempted_at)
       VALUES (?1,?2,?3,?4,?5,?6)`
    )
    .bind(crypto.randomUUID(), input.loginId, input.tenantId, succeeded ? 1 : 0, input.ip, nowUtc())
    .run();
}

// ===============================================================
// registration.ts
// ===============================================================
/**
 * 従業員（アカウント）登録
 *
 * 画面仕様の出典: index2.html（md5 9fad12fc928bdd69efa697e08b2836da・デモ画面）
 *   氏名 / メールアドレス / ID / パスワード / LINE ID / 勤務時間帯 / 勤務形態 / 生年月日 / 性別
 *
 * ⚠ 現行画面の欠陥は再現しない（実行計画書 4.1 の B分類）:
 *   B-19 パスワードが type="text" で平文表示   → 入力型は実装側の責務。API はハッシュのみ保持
 *   B-20 4項目が name="pd_upd2" で重複         → フィールドを個別に受け取り、欠落を検証する
 *   B-22 日の選択肢に 29/30 が重複             → 日付を実在チェックする
 *   B-23 name 属性が無く氏名が送信されない     → 氏名は必須として検証する
 *   B-24 生年が 1950〜2005 固定                → 選択肢を固定せず、年齢範囲で検証する
 */

/** 現行 su2_w_style（index2.html で実証）→ 新設計の雇用形態 */
export const EMPLOYMENT_TYPE_BY_LEGACY: Record<string, string> = {
  "2": "regular", // 社員
  "3": "part_time", // アルバイト
  "4": "cleaner", // 清掃員
  "5": "other", // その他
  // "1" (マスタ②) は雇用形態ではなくロール。account_roles 側で表現する
};

/** 現行 pd_sec1（index2.html で実証）→ 新設計の性別 */
export const GENDER_BY_LEGACY: Record<string, string> = {
  "1": "male",
  "2": "female",
};

/** 現行 ki（index2.html で実証）→ 勤務時間帯コード */
export const SHIFT_GROUP_BY_LEGACY: Record<string, string> = {
  "1": "A",
  "2": "B",
  "3": "C",
  "4": "D",
};

export interface RegisterInput {
  name: string;
  email: string | null;
  loginId: string;
  password: string;
  lineId: string | null; // 段階1.5 の LINE 連携で使う。段階1では保持のみ
  shiftGroupCode: string | null; // 'A'..'D'
  employmentType: string; // 'regular' | 'part_time' | 'cleaner' | 'other'
  birthOn: CalendarDate | null;
  gender: string | null;
  worksiteId: string | null;
}

export interface ValidationIssue {
  field: string;
  code: string;
}

const MIN_AGE = 15; // 中学卒業年齢。年の選択肢を固定しない（B-24）
const MAX_AGE = 100;

/** 実在する日付か（2月30日・4月31日、および B-22 の重複選択肢を弾く） */
export function isRealDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12) return false;
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d >= 1 && d <= last;
}

export function validateRegistration(input: RegisterInput, today: CalendarDate): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (input.name.trim() === "") issues.push({ field: "name", code: "required" });
  if (input.loginId.trim() === "") issues.push({ field: "loginId", code: "required" });
  if (input.password.length < 12) issues.push({ field: "password", code: "too_short" });
  if (input.email !== null && input.email !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) {
    issues.push({ field: "email", code: "invalid_format" });
  }
  if (!Object.values(EMPLOYMENT_TYPE_BY_LEGACY).includes(input.employmentType)) {
    issues.push({ field: "employmentType", code: "invalid_value" });
  }
  if (input.gender !== null && !["male", "female", "other", "undisclosed"].includes(input.gender)) {
    issues.push({ field: "gender", code: "invalid_value" });
  }
  if (input.shiftGroupCode !== null && !Object.values(SHIFT_GROUP_BY_LEGACY).includes(input.shiftGroupCode)) {
    issues.push({ field: "shiftGroupCode", code: "invalid_value" });
  }
  if (input.birthOn !== null) {
    if (!isRealDate(input.birthOn)) {
      issues.push({ field: "birthOn", code: "not_a_real_date" });
    } else {
      const age = Number(today.slice(0, 4)) - Number(input.birthOn.slice(0, 4));
      if (age < MIN_AGE || age > MAX_AGE) issues.push({ field: "birthOn", code: "out_of_range" });
    }
  }
  return issues;
}

export class RegistrationError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super("validation failed");
    this.issues = issues;
  }
}

export interface RegisterResult {
  employeeId: string;
  accountId: string;
}

export async function registerEmployee(
  db: D1Database,
  tenantId: string,
  input: RegisterInput,
  today: CalendarDate
): Promise<RegisterResult> {
  const issues = validateRegistration(input, today);
  if (issues.length > 0) throw new RegistrationError(issues);

  const dup = await db
    .prepare(`SELECT id FROM accounts WHERE tenant_id = ?1 AND login_id = ?2`)
    .bind(tenantId, input.loginId)
    .first<{ id: string }>();
  if (dup !== null) throw new RegistrationError([{ field: "loginId", code: "already_taken" }]);

  const { hash } = await hashPassword(input.password);
  const t = nowUtc();
  const accountId = crypto.randomUUID();
  const employeeId = crypto.randomUUID();

  await db
    .prepare(
      `INSERT INTO accounts (id,tenant_id,login_id,email,password_hash,password_algo,password_updated_at,status,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'active',?7,?7)`
    )
    .bind(accountId, tenantId, input.loginId, input.email, hash, ALGO_LABEL, t)
    .run();

  await db
    .prepare(
      `INSERT INTO employees (id,tenant_id,worksite_id,account_id,name,birth_on,gender,employment_type,status,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'active',?9,?9)`
    )
    .bind(employeeId, tenantId, input.worksiteId, accountId, input.name, input.birthOn, input.gender, input.employmentType, t)
    .run();

  const role = await db.prepare(`SELECT id FROM roles WHERE code = 'employee'`).first<{ id: string }>();
  if (role !== null) {
    await db
      .prepare(`INSERT INTO account_roles (id,account_id,role_id,scope_type,scope_id,granted_at) VALUES (?1,?2,?3,'tenant',?4,?5)`)
      .bind(crypto.randomUUID(), accountId, role.id, tenantId, t)
      .run();
  }

  // ⚠ パスワードを平文でメール送信しない（現行 su1_rem1 の運用・設計書 6.2.1）
  return { employeeId, accountId };
}

// ===============================================================
// deletion.ts
// ===============================================================
/**
 * 退会・解約時の個人データ削除
 *
 * 設計根拠:
 *  - 改修設計書 v6 4.6【コード実証】現行には退会・アカウント削除の処理が存在せず、
 *    退会はメール運用だった（4.15.3）
 *  - 同 5.2⑦「関連テーブルの漏れがない設計」
 *  - スキーマ設計 9章：削除対象テーブル一覧はここ1箇所で管理する
 *
 * ⚠ テーブルを追加したら DELETION_PLAN に必ず追加すること。
 *    追加漏れは scripts/audit_schema.py の検査で検知する。
 */

/** 削除しないテーブル（残す理由を明記する） */
export const DELETION_EXEMPT: Record<string, string> = {
  audit_logs: "監査ログは削除しない（改修設計書 5.2⑤）",
  consent_logs: "同意した事実の記録は残す。氏名・メールは持たない設計（スキーマ 3.4）",
  plans: "テナント個別データではない",
  policy_documents: "テナント個別データではない",
  roles: "テナント個別データではない",
  retention_policies: "テナント個別データではない",
  deletion_jobs: "削除を実行した記録そのもの。追加漏れの検知に使うため残す（スキーマ 3.6）",
};

/**
 * 従業員1名の退会で削除する対象。
 * 子から親の順に並べる（外部キーの参照順）。
 */
export const EMPLOYEE_DELETION_ORDER: Array<{ table: string; by: "employee_id" | "account_id" | "login_id" }> = [
  { table: "attendance_summaries", by: "employee_id" },
  { table: "shift_confirmations", by: "employee_id" },
  { table: "shifts", by: "employee_id" },
  { table: "employees", by: "employee_id" },
  { table: "sessions", by: "account_id" },
  { table: "password_reset_tokens", by: "account_id" },
  { table: "account_roles", by: "account_id" },
  { table: "login_attempts", by: "login_id" },
  { table: "accounts", by: "account_id" },
];

/**
 * テナント解約で削除する対象（従業員分の削除後に実行する）。
 * ⚠ tenants を消す前に、tenants を参照する全テーブルを消しておくこと。
 *    accounts.tenant_id も FK であるため、従業員に紐づかない管理者アカウントが
 *    残っていると外部キー制約で解約が失敗する（統合テストで検出）。
 */
export const TENANT_DELETION_ORDER: string[] = [
  "shift_confirmations",
  "shifts",
  "attendance_summaries",
  "employees",
  "shift_types",
  "worksites",
  "contracts",
  "accounts",
  "tenants",
];

export interface DeletionResult {
  jobId: string;
  kind: string;
  deleted: Record<string, number>;
  photosDeleted: number;
  executedAt: string;
}

/**
 * 従業員の退会。写真（R2）も併せて削除する。
 * D1 に BLOB を置かない設計のため、R2 の削除漏れが孤児オブジェクトになる。
 */
export async function deleteEmployee(
  db: D1Database,
  photos: R2Bucket,
  tenantId: string,
  employeeId: string
): Promise<DeletionResult> {
  const emp = await db
    .prepare(`SELECT id, tenant_id, account_id, photo_object_key FROM employees WHERE id = ?1 AND tenant_id = ?2`)
    .bind(employeeId, tenantId)
    .first<{ id: string; tenant_id: string; account_id: string | null; photo_object_key: string | null }>();
  if (emp === null) throw new Error("employee not found in tenant scope");

  const loginId = emp.account_id === null
    ? null
    : (await db.prepare(`SELECT login_id FROM accounts WHERE id = ?1`).bind(emp.account_id).first<{ login_id: string }>())
        ?.login_id ?? null;

  const deleted: Record<string, number> = {};
  for (const step of EMPLOYEE_DELETION_ORDER) {
    let key: string | null;
    let col: string;
    if (step.by === "employee_id") {
      key = employeeId;
      col = step.table === "employees" ? "id" : "employee_id";
    } else if (step.by === "account_id") {
      key = emp.account_id;
      col = step.table === "accounts" ? "id" : "account_id";
    } else {
      key = loginId;
      col = "login_id";
    }
    if (key === null) {
      deleted[step.table] = 0;
      continue;
    }
    const res = await db.prepare(`DELETE FROM ${step.table} WHERE ${col} = ?1`).bind(key).run();
    deleted[step.table] = res.meta?.changes ?? 0;
  }

  let photosDeleted = 0;
  if (emp.photo_object_key !== null) {
    await photos.delete(emp.photo_object_key);
    photosDeleted = 1;
  }

  const jobId = crypto.randomUUID();
  const executedAt = nowUtc();
  await db
    .prepare(
      `INSERT INTO deletion_jobs (id, tenant_id, kind, scheduled_at, executed_at, result_summary, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`
    )
    .bind(jobId, tenantId, "employee_withdrawal", executedAt, executedAt, JSON.stringify({ deleted, photosDeleted }), executedAt)
    .run();

  return { jobId, kind: "employee_withdrawal", deleted, photosDeleted, executedAt };
}

/** テナントの解約。全従業員を削除したうえでテナント本体を消す */
export async function deleteTenant(db: D1Database, photos: R2Bucket, tenantId: string): Promise<DeletionResult> {
  const emps = await db
    .prepare(`SELECT id FROM employees WHERE tenant_id = ?1`)
    .bind(tenantId)
    .all<{ id: string }>();

  const deleted: Record<string, number> = {};
  let photosDeleted = 0;
  for (const e of emps.results ?? []) {
    const r = await deleteEmployee(db, photos, tenantId, e.id);
    for (const [t, n] of Object.entries(r.deleted)) deleted[t] = (deleted[t] ?? 0) + n;
    photosDeleted += r.photosDeleted;
  }

  // 従業員に紐づかないアカウント（会社管理者など）の依存レコードを先に消す
  const accts = await db
    .prepare(`SELECT id, login_id FROM accounts WHERE tenant_id = ?1`)
    .bind(tenantId)
    .all<{ id: string; login_id: string }>();
  for (const a of accts.results ?? []) {
    for (const [table, col, key] of [
      ["sessions", "account_id", a.id],
      ["password_reset_tokens", "account_id", a.id],
      ["account_roles", "account_id", a.id],
      ["login_attempts", "login_id", a.login_id],
    ] as const) {
      const res = await db.prepare(`DELETE FROM ${table} WHERE ${col} = ?1`).bind(key).run();
      deleted[table] = (deleted[table] ?? 0) + (res.meta?.changes ?? 0);
    }
  }

  for (const table of TENANT_DELETION_ORDER) {
    const col = table === "tenants" ? "id" : "tenant_id";
    const res = await db.prepare(`DELETE FROM ${table} WHERE ${col} = ?1`).bind(tenantId).run();
    deleted[table] = (deleted[table] ?? 0) + (res.meta?.changes ?? 0);
  }

  const jobId = crypto.randomUUID();
  const executedAt = nowUtc();
  await db
    .prepare(
      `INSERT INTO deletion_jobs (id, tenant_id, kind, scheduled_at, executed_at, result_summary, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`
    )
    .bind(jobId, tenantId, "tenant_termination", executedAt, executedAt, JSON.stringify({ deleted, photosDeleted }), executedAt)
    .run();

  return { jobId, kind: "tenant_termination", deleted, photosDeleted, executedAt };
}

// ===============================================================
// shiftService.ts — シフト登録・更新・集計
// ===============================================================
/**
 * 🔴 現行の shift1update / shift2update / shift3update / shift23update の
 *    4本を1本に集約したもの（実行計画書 2.2 集約候補①）。
 *
 * 4本の差分は次の3点だけだった（改修設計書 4.10・4.13.1・4.13.2・4.13.6）:
 *   ① 入口のロール（user1session / user2session / user3session）
 *      → ロール判定は呼び出し側（ディスパッチャ＋authz）に集約したため不要
 *   ② LINE 通知の有無
 *      → 段階1.5 のため未実装
 *   ③ 日跨ぎ判定の有無（shift23update にだけ無く実働が負値になっていた・B-2）
 *      → normalizeClockOut で1箇所に集約。分岐そのものを無くした
 */
export interface ShiftUpsertInput {
  employeeId: string;
  workedOn: CalendarDate;
  shiftTypeId: string | null;
  clockIn: ClockTime | null;
  clockOut: ClockTime | null;
  breakMinutes: Minutes;
  overtimeMinutes: Minutes;
  isAbsent: boolean;
  isLate: boolean;
  isEarlyLeave: boolean;
  note: string | null;
  worksiteId: string | null;
}

export class ShiftServiceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * シフトを登録または更新する。
 * ⚠ tenant_id は引数で受け取らず、呼び出し側の principal から渡す。
 *    従業員が自テナントのものであることを必ず突き合わせる（B-6）。
 */
export async function upsertShift(
  db: D1Database,
  tenantId: string,
  input: ShiftUpsertInput,
  today: CalendarDate = toJstCalendarDate(nowUtc())
): Promise<{ shiftId: string; workedMinutes: Minutes }> {
  // 🔴 締め済み期間への登録を拒否する【会話合意 2026-08-15】
  //    現行は shift23updateAction にのみ同等のチェックがあり
  //    （shift3update ではコメントアウト、shift1/2 には無し）、
  //    4本で挙動が食い違っていた。全体に適用する方針で統一する。
  //    ⚠ 現行は date("Y-m") 同士の比較だったが、締め日が月末以外の場合に
  //      同一締め期間内の前月分まで拒否してしまう。本実装は
  //      「その勤務日が属する締め期間が終了しているか」で判定する。
  const tenant = await db
    .prepare(`SELECT cutoff_day FROM tenants WHERE id = ?1`)
    .bind(tenantId)
    .first<{ cutoff_day: number }>();
  if (tenant === null) throw new ShiftServiceError("tenant_not_found", "tenant not found");
  const period = periodForDate(input.workedOn, tenant.cutoff_day);
  if (period.end < today) {
    throw new ShiftServiceError("period_closed", `period ${period.start}..${period.end} is closed`);
  }

  const emp = await db
    .prepare(`SELECT id, tenant_id FROM employees WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(input.employeeId, tenantId)
    .first<{ id: string }>();
  if (emp === null) throw new ShiftServiceError("employee_not_found", "employee not found in tenant scope");

  if (input.shiftTypeId !== null) {
    const st = await db
      .prepare(`SELECT id FROM shift_types WHERE id = ?1 AND tenant_id = ?2`)
      .bind(input.shiftTypeId, tenantId)
      .first<{ id: string }>();
    if (st === null) throw new ShiftServiceError("shift_type_not_found", "shift type not found in tenant scope");
  }

  let workedMinutes = 0;
  let storedClockOut: string | null = null;
  if (!input.isAbsent && input.clockIn !== null && input.clockOut !== null) {
    // 日跨ぎは 24時超え表記に正規化してから保存する（B-2）
    storedClockOut = normalizeClockOut(input.clockIn, input.clockOut);
    workedMinutes = calcWorkedMinutes({
      clockIn: input.clockIn,
      clockOut: storedClockOut,
      breakMinutes: input.breakMinutes,
      overtimeMinutes: input.overtimeMinutes,
    });
  }

  const t = nowUtc();
  const existing = await db
    .prepare(
      `SELECT id FROM shifts
        WHERE employee_id = ?1 AND worked_on = ?2
          AND ((shift_type_id IS NULL AND ?3 IS NULL) OR shift_type_id = ?3)`
    )
    .bind(input.employeeId, input.workedOn, input.shiftTypeId)
    .first<{ id: string }>();

  if (existing !== null) {
    await db
      .prepare(
        `UPDATE shifts SET worksite_id=?1, clock_in=?2, clock_out=?3, break_minutes=?4,
           overtime_minutes=?5, worked_minutes=?6, is_absent=?7, is_late=?8, is_early_leave=?9,
           note=?10, updated_at=?11, deleted_at=NULL
         WHERE id=?12 AND tenant_id=?13`
      )
      .bind(
        input.worksiteId, input.clockIn, storedClockOut, input.breakMinutes,
        input.overtimeMinutes, workedMinutes, input.isAbsent ? 1 : 0, input.isLate ? 1 : 0,
        input.isEarlyLeave ? 1 : 0, input.note, t, existing.id, tenantId
      )
      .run();
    return { shiftId: existing.id, workedMinutes };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO shifts (id,tenant_id,worksite_id,employee_id,worked_on,shift_type_id,clock_in,clock_out,
         break_minutes,overtime_minutes,worked_minutes,is_absent,is_late,is_early_leave,note,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16)`
    )
    .bind(
      id, tenantId, input.worksiteId, input.employeeId, input.workedOn, input.shiftTypeId,
      input.clockIn, storedClockOut, input.breakMinutes, input.overtimeMinutes, workedMinutes,
      input.isAbsent ? 1 : 0, input.isLate ? 1 : 0, input.isEarlyLeave ? 1 : 0, input.note, t
    )
    .run();
  return { shiftId: id, workedMinutes };
}

export interface PeriodSummary {
  periodStartOn: CalendarDate;
  periodEndOn: CalendarDate;
  workDays: number;
  workedMinutes: Minutes;
  overtimeMinutes: Minutes;
  lateCount: number;
  earlyLeaveCount: number;
  absenceCount: number;
  byShiftType: Record<string, number>;
}

/**
 * 締め日基準の期間集計。
 * 🔴 集計テーブルを持たず、その都度クエリで算出する【会話合意 2026-08-14】。
 *    現行の article_counter1_shift1/2/3 は COUNT(shift_flg1>'0') により
 *    区分1の件数が常に合計と同値になっており、1,490行が誤った値だった（B-1）。
 */
export async function summarizePeriod(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  yearMonth: string,
  cutoffDay: number
): Promise<PeriodSummary> {
  const { start, end } = getCutoffRange(yearMonth, cutoffDay);
  const rows = await db
    .prepare(
      `SELECT s.worked_minutes, s.overtime_minutes, s.is_absent, s.is_late, s.is_early_leave, t.code AS type_code
         FROM shifts s LEFT JOIN shift_types t ON t.id = s.shift_type_id
        WHERE s.tenant_id = ?1 AND s.employee_id = ?2
          AND s.worked_on >= ?3 AND s.worked_on <= ?4
          AND s.deleted_at IS NULL`
    )
    .bind(tenantId, employeeId, start, end)
    .all<{
      worked_minutes: number; overtime_minutes: number;
      is_absent: number; is_late: number; is_early_leave: number; type_code: string | null;
    }>();

  const list = rows.results ?? [];
  const codes = (await db.prepare(`SELECT code FROM shift_types WHERE tenant_id = ?1 ORDER BY sort_order`)
    .bind(tenantId).all<{ code: string }>()).results ?? [];

  const counted = countByShiftType(
    list.map((r) => ({ shiftTypeCode: r.type_code })),
    codes.map((c) => c.code)
  );

  return {
    periodStartOn: start,
    periodEndOn: end,
    workDays: list.filter((r) => r.is_absent === 0).length,
    workedMinutes: list.reduce((a, r) => a + r.worked_minutes, 0),
    overtimeMinutes: list.reduce((a, r) => a + r.overtime_minutes, 0),
    lateCount: list.filter((r) => r.is_late === 1).length,
    earlyLeaveCount: list.filter((r) => r.is_early_leave === 1).length,
    absenceCount: list.filter((r) => r.is_absent === 1).length,
    byShiftType: counted.byCode,
  };
}

/**
 * シフトの確定／確定解除
 *
 * 現行 `user1flg1shift1insert`（`shift_r1_flg1`）に相当。4本すべてが呼んでいた。
 * 照合報告 5.1 で「新実装に無い」と判明したため追加。
 */
export async function setShiftConfirmation(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  yearMonth: string,
  cutoffDay: number,
  confirmed: boolean,
  actorAccountId: string
): Promise<{ periodStartOn: CalendarDate; isConfirmed: boolean }> {
  const emp = await db
    .prepare(`SELECT id FROM employees WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(employeeId, tenantId)
    .first<{ id: string }>();
  if (emp === null) throw new ShiftServiceError("employee_not_found", "employee not found in tenant scope");

  const { start } = getCutoffRange(yearMonth, cutoffDay);
  const t = nowUtc();
  const existing = await db
    .prepare(`SELECT id FROM shift_confirmations WHERE employee_id = ?1 AND period_start_on = ?2`)
    .bind(employeeId, start)
    .first<{ id: string }>();

  if (existing !== null) {
    await db
      .prepare(
        `UPDATE shift_confirmations SET is_confirmed=?1, confirmed_at=?2, confirmed_by=?3, updated_at=?4
          WHERE id=?5 AND tenant_id=?6`
      )
      .bind(confirmed ? 1 : 0, confirmed ? t : null, confirmed ? actorAccountId : null, t, existing.id, tenantId)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO shift_confirmations (id,tenant_id,employee_id,period_start_on,is_confirmed,confirmed_at,confirmed_by,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)`
      )
      .bind(crypto.randomUUID(), tenantId, employeeId, start, confirmed ? 1 : 0,
            confirmed ? t : null, confirmed ? actorAccountId : null, t)
      .run();
  }
  return { periodStartOn: start, isConfirmed: confirmed };
}

/** 指定期間が確定済みか */
export async function isPeriodConfirmed(
  db: D1Database, tenantId: string, employeeId: string, periodStartOn: CalendarDate
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT is_confirmed FROM shift_confirmations WHERE tenant_id=?1 AND employee_id=?2 AND period_start_on=?3`)
    .bind(tenantId, employeeId, periodStartOn)
    .first<{ is_confirmed: number }>();
  return row !== null && row.is_confirmed === 1;
}

/**
 * 初期セットアップ（ブートストラップ）
 *
 * 🔴 設計の欠落として検出（2026-08-15）:
 *   従業員登録APIは認証必須、ログインAPIはアカウント存在が前提、
 *   SQL 直接投入は scrypt ハッシュを作れない。
 *   → 最初のテナントと管理者を作る経路が存在しなかった。
 *
 * 安全策:
 *   ① 環境変数 SETUP_TOKEN と一致する場合のみ実行できる
 *   ② テナントが1件も存在しないときだけ動作する（2回目以降は拒否）
 *   ③ SETUP_TOKEN が未設定なら常に拒否する
 */
export interface SetupInput {
  tenantName: string;
  cutoffDay: number;
  adminLoginId: string;
  adminPassword: string;
  adminEmail: string | null;
}

export type SetupResult =
  | { ok: true; tenantId: string; accountId: string }
  | { ok: false; reason: "disabled" | "invalid_token" | "already_initialized" | "invalid_input" };

export async function bootstrapSetup(
  db: D1Database,
  configuredToken: string | undefined,
  providedToken: string,
  input: SetupInput
): Promise<SetupResult> {
  if (configuredToken === undefined || configuredToken === "") return { ok: false, reason: "disabled" };
  // 長さが違う時点で不一致。等長なら定数時間で比較する
  if (providedToken.length !== configuredToken.length) return { ok: false, reason: "invalid_token" };
  let diff = 0;
  for (let i = 0; i < configuredToken.length; i++) diff |= providedToken.charCodeAt(i) ^ configuredToken.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: "invalid_token" };

  const existing = await db.prepare(`SELECT COUNT(*) AS n FROM tenants`).first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) return { ok: false, reason: "already_initialized" };

  if (input.tenantName.trim() === "" || input.adminLoginId.trim() === "" || input.adminPassword.length < 12) {
    return { ok: false, reason: "invalid_input" };
  }
  if (!Number.isInteger(input.cutoffDay) || input.cutoffDay < 1 || input.cutoffDay > 31) {
    return { ok: false, reason: "invalid_input" };
  }

  const t = nowUtc();
  const tenantId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const { hash } = await hashPassword(input.adminPassword);

  await db
    .prepare(
      `INSERT INTO tenants (id,name,cutoff_day,timezone,status,created_at,updated_at)
       VALUES (?1,?2,?3,'Asia/Tokyo','active',?4,?4)`
    )
    .bind(tenantId, input.tenantName, input.cutoffDay, t)
    .run();

  await db
    .prepare(
      `INSERT INTO accounts (id,tenant_id,login_id,email,password_hash,password_algo,password_updated_at,status,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'active',?7,?7)`
    )
    .bind(accountId, tenantId, input.adminLoginId, input.adminEmail, hash, ALGO_LABEL, t)
    .run();

  const role = await db.prepare(`SELECT id FROM roles WHERE code = 'tenant_admin'`).first<{ id: string }>();
  if (role === null) return { ok: false, reason: "invalid_input" };
  await db
    .prepare(`INSERT INTO account_roles (id,account_id,role_id,scope_type,scope_id,granted_at) VALUES (?1,?2,?3,'tenant',?4,?5)`)
    .bind(crypto.randomUUID(), accountId, role.id, tenantId, t)
    .run();

  // 勤務時間帯 A〜D（現行 shift_flg1 の 1〜4 に相当）
  for (const [i, code] of ["A", "B", "C", "D"].entries()) {
    await db
      .prepare(
        `INSERT INTO shift_types (id,tenant_id,code,name,sort_order,is_active,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,1,?6,?6)`
      )
      .bind(crypto.randomUUID(), tenantId, code, `${code}グループ`, i + 1, t)
      .run();
  }

  return { ok: true, tenantId, accountId };
}

// ===============================================================
// 勤怠評価（WBS ブロック8・改修設計書 5.1 優先5）
// ===============================================================
/**
 * 現行の評価項目は「遅刻・早退・欠勤・残業・勤続・年齢」（改修設計書 5.1）。
 *
 * 🔴 現行との違い（B分類）:
 *   - 勤続年数を 1年=365.25日で近似していた（設計書 4.10）→ 暦日ベースで算出する
 *   - 集計テーブル（article_counter1_shift1/2/3）に保存していた値は
 *     区分別カウントが誤っていた（B-1）→ 集計は都度算出する
 *
 * ⚠ 評価の「点数化」ルールは現行ソース未受領のため実装しない【未確認】。
 *   本関数は点数の材料となる実績値のみを返す。
 */
export interface EvaluationInput {
  employeeId: string;
  yearMonth: string;
  cutoffDay: number;
  /** 評価基準日。既定は今日（JST） */
  asOf?: CalendarDate;
}

export interface EvaluationResult {
  employeeId: string;
  periodStartOn: CalendarDate;
  periodEndOn: CalendarDate;
  /** 出勤した日数（欠勤を除く） */
  workDays: number;
  workedMinutes: Minutes;
  overtimeMinutes: Minutes;
  lateCount: number;
  earlyLeaveCount: number;
  absenceCount: number;
  /** 出勤率（欠勤を含む登録日数に対する出勤日数）。登録が0件なら null */
  attendanceRate: number | null;
  /** 勤続（暦日ベース）。hired_on 未設定なら null */
  tenure: { years: number; months: number } | null;
  /** 年齢（暦日ベース）。birth_on 未設定なら null */
  age: number | null;
  byShiftType: Record<string, number>;
}

/** 暦日ベースの満年齢。365.25日近似は使わない（設計書 4.10） */
export function ageOn(birthOn: CalendarDate, asOf: CalendarDate): number {
  const [by, bm, bd] = birthOn.split("-").map(Number);
  const [ay, am, ad] = asOf.split("-").map(Number);
  let age = ay - by;
  if (am < bm || (am === bm && ad < bd)) age -= 1;
  return age < 0 ? 0 : age;
}

export async function evaluateAttendance(
  db: D1Database,
  tenantId: string,
  input: EvaluationInput
): Promise<EvaluationResult> {
  const emp = await db
    .prepare(
      `SELECT id, birth_on, hired_on FROM employees
        WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`
    )
    .bind(input.employeeId, tenantId)
    .first<{ id: string; birth_on: string | null; hired_on: string | null }>();
  if (emp === null) throw new ShiftServiceError("employee_not_found", "employee not found in tenant scope");

  const asOf = input.asOf ?? toJstCalendarDate(nowUtc());
  const sum = await summarizePeriod(db, tenantId, input.employeeId, input.yearMonth, input.cutoffDay);

  const registeredDays = sum.workDays + sum.absenceCount;
  return {
    employeeId: input.employeeId,
    periodStartOn: sum.periodStartOn,
    periodEndOn: sum.periodEndOn,
    workDays: sum.workDays,
    workedMinutes: sum.workedMinutes,
    overtimeMinutes: sum.overtimeMinutes,
    lateCount: sum.lateCount,
    earlyLeaveCount: sum.earlyLeaveCount,
    absenceCount: sum.absenceCount,
    attendanceRate: registeredDays === 0 ? null : Math.round((sum.workDays / registeredDays) * 1000) / 10,
    tenure: emp.hired_on === null ? null : tenureYearsMonths(emp.hired_on, asOf),
    age: emp.birth_on === null ? null : ageOn(emp.birth_on, asOf),
    byShiftType: sum.byShiftType,
  };
}

/**
 * 集計結果を attendance_summaries に確定保存する。
 * ⚠ 通常の閲覧は evaluateAttendance（都度算出）を使う。
 *   本関数は締め後の記録を残す用途に限る。
 */
export async function persistAttendanceSummary(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  yearMonth: string,
  cutoffDay: number
): Promise<{ id: string }> {
  const sum = await summarizePeriod(db, tenantId, employeeId, yearMonth, cutoffDay);
  const t = nowUtc();
  const existing = await db
    .prepare(`SELECT id FROM attendance_summaries WHERE employee_id = ?1 AND period_start_on = ?2`)
    .bind(employeeId, sum.periodStartOn)
    .first<{ id: string }>();

  if (existing !== null) {
    await db
      .prepare(
        `UPDATE attendance_summaries SET work_days=?1, worked_minutes=?2, overtime_minutes=?3,
           late_count=?4, early_leave_count=?5, absence_count=?6, calculated_at=?7
         WHERE id=?8 AND tenant_id=?9`
      )
      .bind(sum.workDays, sum.workedMinutes, sum.overtimeMinutes, sum.lateCount,
            sum.earlyLeaveCount, sum.absenceCount, t, existing.id, tenantId)
      .run();
    return { id: existing.id };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO attendance_summaries (id,tenant_id,employee_id,period_start_on,period_end_on,
         work_days,worked_minutes,overtime_minutes,late_count,early_leave_count,absence_count,calculated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
    )
    .bind(id, tenantId, employeeId, sum.periodStartOn, sum.periodEndOn, sum.workDays,
          sum.workedMinutes, sum.overtimeMinutes, sum.lateCount, sum.earlyLeaveCount, sum.absenceCount, t)
    .run();
  return { id };
}
