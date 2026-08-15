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
import type { CalendarDate, ClockTime, Minutes, UtcInstant } from "./core.ts";

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
  | { ok: true; token: string; accountId: string; tenantId: string | null; expiresAt: string }
  | { ok: false; reason: "invalid_credentials" | "rate_limited" | "account_inactive" }
  /** 同じログインIDが複数テナントに存在する場合のみ。会社の選択を求める */
  | { ok: false; reason: "tenant_required"; tenants: Array<{ id: string; name: string }> };

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

  // 🔴 現行のログイン画面は ID と PW の2項目のみで、会社を選ばせない
  //    （loginuser2Template.php / loginuser3Template.php で実証）。
  //    tenantId が指定されない場合は、ログインIDから会社を特定する。
  let account: { id: string; tenant_id: string | null; password_hash: string; status: string } | null;

  if (input.tenantId === null) {
    const candidates = await db
      .prepare(
        `SELECT a.id, a.tenant_id, a.password_hash, a.status, COALESCE(t.name, '') AS tenant_name
           FROM accounts a LEFT JOIN tenants t ON t.id = a.tenant_id
          WHERE a.login_id = ?1`
      )
      .bind(input.loginId)
      .all<{ id: string; tenant_id: string | null; password_hash: string; status: string; tenant_name: string }>();
    const rows = candidates.results ?? [];

    if (rows.length > 1) {
      // 登録時に全社で一意を強制しているため通常は起こらない。
      // 万一起きた場合のみ会社の選択を求める（推測で1件目を選ばない）
      await equalizeTiming();
      await recordAttempt(db, input, false);
      return {
        ok: false,
        reason: "tenant_required",
        tenants: rows
          .filter((r) => r.tenant_id !== null)
          .map((r) => ({ id: r.tenant_id as string, name: r.tenant_name })),
      };
    }
    account = rows.length === 1 ? rows[0] : null;
  } else {
    account = await db
      .prepare(
        `SELECT id, tenant_id, password_hash, status FROM accounts
          WHERE login_id = ?1 AND tenant_id = ?2`
      )
      .bind(input.loginId, input.tenantId)
      .first<{ id: string; tenant_id: string | null; password_hash: string; status: string }>();
  }

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

  return { ok: true, token, accountId: account.id, tenantId: account.tenant_id, expiresAt };
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

/**
 * ⚠ 旧 SHIFT_GROUP_BY_LEGACY（1〜4 = A〜Dグループ）は撤去した。
 *
 * 改修設計書 v6 4.5 の「A〜Dグループ」は特定の会社の設定値であり、仕様ではなかった
 * （引継ぎシート Session 03 第6章の訂正・shift1Template.php と tb_m_cate1 で実証）。
 * 勤務時間帯は会社ごとに最大21種を shift_types に定義する。
 * 登録時は shift_types.id を直接受け取り、自テナントに実在するかを検証する。
 */

export interface RegisterInput {
  name: string;
  nameKana: string | null;
  employeeCode: string | null; // 社内の従業員番号。UNIQUE (tenant_id, employee_code)
  email: string | null;
  loginId: string;
  password: string;
  /** 既定の勤務時間帯。shift_types.id（会社ごとに最大21種）。null = 未設定 */
  shiftTypeId: string | null;
  employmentType: string; // 'regular' | 'part_time' | 'cleaner' | 'other'
  birthOn: CalendarDate | null;
  hiredOn: CalendarDate | null; // 🔴 勤怠評価の「勤続」に必須（未設定だと常に null になる）
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
  if (input.birthOn !== null) {
    if (!isRealDate(input.birthOn)) {
      issues.push({ field: "birthOn", code: "not_a_real_date" });
    } else {
      const age = Number(today.slice(0, 4)) - Number(input.birthOn.slice(0, 4));
      if (age < MIN_AGE || age > MAX_AGE) issues.push({ field: "birthOn", code: "out_of_range" });
    }
  }
  // 入社日。未来日を弾く（勤続年数が負になるため）
  if (input.hiredOn !== null) {
    if (!isRealDate(input.hiredOn)) {
      issues.push({ field: "hiredOn", code: "not_a_real_date" });
    } else if (input.hiredOn > today) {
      issues.push({ field: "hiredOn", code: "in_the_future" });
    }
  }
  // 生年月日と入社日の前後関係
  if (input.birthOn !== null && input.hiredOn !== null && isRealDate(input.birthOn) && isRealDate(input.hiredOn)) {
    if (input.hiredOn <= input.birthOn) issues.push({ field: "hiredOn", code: "before_birth" });
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

/**
 * 空文字を null に落とす。
 * ⚠ UNIQUE (tenant_id, employee_code) は SQLite では NULL 同士を重複と見なさないが、
 *   空文字 "" は通常の値として扱われるため、2人目の登録が制約違反になる。
 */
function emptyToNull(v: string | null): string | null {
  if (v === null) return null;
  const s = v.trim();
  return s === "" ? null : s;
}

export async function registerEmployee(
  db: D1Database,
  tenantId: string,
  input: RegisterInput,
  today: CalendarDate
): Promise<RegisterResult> {
  const issues = validateRegistration(input, today);
  if (issues.length > 0) throw new RegistrationError(issues);

  // 🔴 ログインIDは全社で一意にする。
  //    現行のログイン画面が会社を選ばせないため（loginuser*Template.php で実証）、
  //    重複があると会社を特定できなくなる。
  //    スキーマ側の UNIQUE (tenant_id, login_id) は将来の拡張余地として残す。
  const dup = await db
    .prepare(`SELECT id FROM accounts WHERE login_id = ?1`)
    .bind(input.loginId)
    .first<{ id: string }>();
  if (dup !== null) throw new RegistrationError([{ field: "loginId", code: "already_taken" }]);

  // 従業員番号はテナント内で一意（スキーマの UNIQUE (tenant_id, employee_code)）。
  // DB の制約違反を待たず、他の入力エラーと同じ形で返す
  if (input.employeeCode !== null && input.employeeCode !== "") {
    const dupCode = await db
      .prepare(`SELECT id FROM employees WHERE tenant_id = ?1 AND employee_code = ?2 AND deleted_at IS NULL`)
      .bind(tenantId, input.employeeCode)
      .first<{ id: string }>();
    if (dupCode !== null) throw new RegistrationError([{ field: "employeeCode", code: "already_taken" }]);
  }

  // 勤務時間帯は自テナントに実在するものだけを許す（他社の ID を混入させない・B-6）
  if (input.shiftTypeId !== null && input.shiftTypeId !== "") {
    const st = await db
      .prepare(`SELECT id FROM shift_types WHERE id = ?1 AND tenant_id = ?2 AND is_active = 1`)
      .bind(input.shiftTypeId, tenantId)
      .first<{ id: string }>();
    if (st === null) throw new RegistrationError([{ field: "shiftTypeId", code: "not_found" }]);
  }

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
      `INSERT INTO employees
         (id,tenant_id,worksite_id,account_id,employee_code,name,name_kana,birth_on,gender,
          hired_on,employment_type,default_shift_type_id,status,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'active',?13,?13)`
    )
    .bind(
      employeeId,
      tenantId,
      input.worksiteId,
      accountId,
      emptyToNull(input.employeeCode),
      input.name,
      emptyToNull(input.nameKana),
      input.birthOn,
      input.gender,
      input.hiredOn,
      input.employmentType,
      emptyToNull(input.shiftTypeId),
      t
    )
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

// ---------------------------------------------------------------
// 従業員の参照・修正（T-4 / T-5 / T-6）
// ---------------------------------------------------------------
/**
 * ⚠ employees.status の値域は暫定である【未確認】。
 *   現行 su2_flg1 は3値を取り、187名中93名しかログインできない状態だが、
 *   値2・3の意味が未解消（改修設計書 10.2 ㉖ / スキーマ設計 5.2）。
 *   Action の受領後に見直す【会話合意 2026-08-15：暫定3値で進める】。
 */
export const EMPLOYEE_STATUSES = ["active", "suspended", "resigned"] as const;

export interface EmployeeRow {
  id: string;
  employeeCode: string | null;
  name: string;
  nameKana: string | null;
  employmentType: string;
  status: string;
  hiredOn: CalendarDate | null;
  birthOn: CalendarDate | null;
  gender: string | null;
  worksiteId: string | null;
  shiftTypeId: string | null;
  shiftTypeName: string | null;
  loginId: string | null;
  accountStatus: string | null;
}

interface EmployeeDbRow {
  id: string;
  employee_code: string | null;
  name: string;
  name_kana: string | null;
  employment_type: string;
  status: string;
  hired_on: string | null;
  birth_on: string | null;
  gender: string | null;
  worksite_id: string | null;
  default_shift_type_id: string | null;
  shift_type_name: string | null;
  login_id: string | null;
  account_status: string | null;
}

function toEmployeeRow(r: EmployeeDbRow): EmployeeRow {
  return {
    id: r.id,
    employeeCode: r.employee_code,
    name: r.name,
    nameKana: r.name_kana,
    employmentType: r.employment_type,
    status: r.status,
    hiredOn: r.hired_on,
    birthOn: r.birth_on,
    gender: r.gender,
    worksiteId: r.worksite_id,
    shiftTypeId: r.default_shift_type_id,
    shiftTypeName: r.shift_type_name,
    loginId: r.login_id,
    accountStatus: r.account_status,
  };
}

/**
 * ⚠ SELECT 句に列を列挙する（SELECT * を使わない）。
 *   employees に将来 password 系や要配慮情報の列が増えたとき、
 *   一覧 API から自動的に漏れ出すのを防ぐ。
 */
const EMPLOYEE_SELECT = `
  SELECT e.id, e.employee_code, e.name, e.name_kana, e.employment_type, e.status,
         e.hired_on, e.birth_on, e.gender, e.worksite_id, e.default_shift_type_id,
         st.name AS shift_type_name,
         a.login_id, a.status AS account_status
    FROM employees e
    LEFT JOIN shift_types st ON st.id = e.default_shift_type_id
    LEFT JOIN accounts a ON a.id = e.account_id`;

export interface ListEmployeesOptions {
  /** 状態での絞り込み。null = すべて */
  status?: string | null;
  /** 氏名・カナ・従業員番号の部分一致 */
  keyword?: string | null;
  limit?: number;
}

/**
 * 自テナントの従業員一覧。
 * 🔴 tenant_id を必ず条件に入れる（B-6：現行 adminall1st は他社を引けた）。
 */
export async function listEmployees(
  db: D1Database,
  tenantId: string,
  opts: ListEmployeesOptions = {}
): Promise<EmployeeRow[]> {
  const clauses = ["e.tenant_id = ?1", "e.deleted_at IS NULL"];
  const binds: (string | number)[] = [tenantId];

  if (opts.status !== undefined && opts.status !== null && opts.status !== "") {
    if (!(EMPLOYEE_STATUSES as readonly string[]).includes(opts.status)) {
      throw new RegistrationError([{ field: "status", code: "invalid_value" }]);
    }
    binds.push(opts.status);
    clauses.push(`e.status = ?${binds.length}`);
  }

  const kw = emptyToNull(opts.keyword ?? null);
  if (kw !== null) {
    // LIKE のワイルドカードを打ち消してから部分一致にする
    const escaped = kw.replace(/[\\%_]/g, (c) => `\\${c}`);
    binds.push(`%${escaped}%`);
    const p = `?${binds.length}`;
    clauses.push(
      `(e.name LIKE ${p} ESCAPE '\\' OR e.name_kana LIKE ${p} ESCAPE '\\' OR e.employee_code LIKE ${p} ESCAPE '\\')`
    );
  }

  const limit = opts.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RegistrationError([{ field: "limit", code: "out_of_range" }]);
  }

  const sql = `${EMPLOYEE_SELECT} WHERE ${clauses.join(" AND ")}
     ORDER BY e.status ASC, e.employee_code ASC, e.name_kana ASC, e.name ASC
     LIMIT ${limit}`;
  const res = await db.prepare(sql).bind(...binds).all<EmployeeDbRow>();
  return (res.results ?? []).map(toEmployeeRow);
}

/** 単票。自テナント以外は null を返す（存在の有無を漏らさない） */
export async function getEmployee(
  db: D1Database,
  tenantId: string,
  employeeId: string
): Promise<EmployeeRow | null> {
  const row = await db
    .prepare(`${EMPLOYEE_SELECT} WHERE e.id = ?1 AND e.tenant_id = ?2 AND e.deleted_at IS NULL`)
    .bind(employeeId, tenantId)
    .first<EmployeeDbRow>();
  return row === null ? null : toEmployeeRow(row);
}

export interface UpdateEmployeeInput {
  name?: string;
  nameKana?: string | null;
  employeeCode?: string | null;
  employmentType?: string;
  status?: string;
  birthOn?: CalendarDate | null;
  hiredOn?: CalendarDate | null;
  gender?: string | null;
  shiftTypeId?: string | null;
  worksiteId?: string | null;
}

/**
 * 従業員の修正。
 *
 * 🔴 ログインID・パスワードはここで変更できない。
 *    認証情報の変更は別経路にする（監査ログ上も区別が付かなくなるため）。
 */
export async function updateEmployee(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  input: UpdateEmployeeInput,
  today: CalendarDate
): Promise<void> {
  const current = await getEmployee(db, tenantId, employeeId);
  if (current === null) throw new RegistrationError([{ field: "employeeId", code: "not_found" }]);

  const issues: ValidationIssue[] = [];
  const name = input.name === undefined ? current.name : input.name;
  if (name.trim() === "") issues.push({ field: "name", code: "required" });

  const employmentType = input.employmentType === undefined ? current.employmentType : input.employmentType;
  if (!Object.values(EMPLOYMENT_TYPE_BY_LEGACY).includes(employmentType)) {
    issues.push({ field: "employmentType", code: "invalid_value" });
  }

  const status = input.status === undefined ? current.status : input.status;
  if (!(EMPLOYEE_STATUSES as readonly string[]).includes(status)) {
    issues.push({ field: "status", code: "invalid_value" });
  }

  const gender = input.gender === undefined ? current.gender : input.gender;
  if (gender !== null && !["male", "female", "other", "undisclosed"].includes(gender)) {
    issues.push({ field: "gender", code: "invalid_value" });
  }

  const birthOn = input.birthOn === undefined ? current.birthOn : input.birthOn;
  const hiredOn = input.hiredOn === undefined ? current.hiredOn : input.hiredOn;
  if (birthOn !== null) {
    if (!isRealDate(birthOn)) {
      issues.push({ field: "birthOn", code: "not_a_real_date" });
    } else {
      const age = Number(today.slice(0, 4)) - Number(birthOn.slice(0, 4));
      if (age < MIN_AGE || age > MAX_AGE) issues.push({ field: "birthOn", code: "out_of_range" });
    }
  }
  if (hiredOn !== null) {
    if (!isRealDate(hiredOn)) issues.push({ field: "hiredOn", code: "not_a_real_date" });
    else if (hiredOn > today) issues.push({ field: "hiredOn", code: "in_the_future" });
  }
  if (birthOn !== null && hiredOn !== null && isRealDate(birthOn) && isRealDate(hiredOn) && hiredOn <= birthOn) {
    issues.push({ field: "hiredOn", code: "before_birth" });
  }
  if (issues.length > 0) throw new RegistrationError(issues);

  const employeeCode = emptyToNull(input.employeeCode === undefined ? current.employeeCode : input.employeeCode);
  if (employeeCode !== null) {
    const dup = await db
      .prepare(
        `SELECT id FROM employees WHERE tenant_id = ?1 AND employee_code = ?2 AND id <> ?3 AND deleted_at IS NULL`
      )
      .bind(tenantId, employeeCode, employeeId)
      .first<{ id: string }>();
    if (dup !== null) throw new RegistrationError([{ field: "employeeCode", code: "already_taken" }]);
  }

  const shiftTypeId = emptyToNull(input.shiftTypeId === undefined ? current.shiftTypeId : input.shiftTypeId);
  if (shiftTypeId !== null) {
    const st = await db
      .prepare(`SELECT id FROM shift_types WHERE id = ?1 AND tenant_id = ?2 AND is_active = 1`)
      .bind(shiftTypeId, tenantId)
      .first<{ id: string }>();
    if (st === null) throw new RegistrationError([{ field: "shiftTypeId", code: "not_found" }]);
  }

  const worksiteId = emptyToNull(input.worksiteId === undefined ? current.worksiteId : input.worksiteId);
  if (worksiteId !== null) {
    const ws = await db
      .prepare(`SELECT id FROM worksites WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
      .bind(worksiteId, tenantId)
      .first<{ id: string }>();
    if (ws === null) throw new RegistrationError([{ field: "worksiteId", code: "not_found" }]);
  }

  // 退職にしたら退職日を入れる。復帰させたら消す
  const resignedOn = status === "resigned" ? today : null;

  // 🔴 WHERE に tenant_id を必ず入れる
  await db
    .prepare(
      `UPDATE employees
          SET employee_code = ?1, name = ?2, name_kana = ?3, birth_on = ?4, gender = ?5,
              hired_on = ?6, resigned_on = ?7, employment_type = ?8, status = ?9,
              default_shift_type_id = ?10, worksite_id = ?11, updated_at = ?12
        WHERE id = ?13 AND tenant_id = ?14`
    )
    .bind(
      employeeCode,
      name.trim(),
      emptyToNull(input.nameKana === undefined ? current.nameKana : input.nameKana),
      birthOn,
      gender,
      hiredOn,
      resignedOn,
      employmentType,
      status,
      shiftTypeId,
      worksiteId,
      nowUtc(),
      employeeId,
      tenantId
    )
    .run();
}

/** 登録・修正画面の選択肢に使う勤務時間帯（自テナントの有効なもの） */
export async function listShiftTypes(
  db: D1Database,
  tenantId: string
): Promise<Array<{ id: string; code: string; name: string }>> {
  const res = await db
    .prepare(
      `SELECT id, code, name FROM shift_types
        WHERE tenant_id = ?1 AND is_active = 1
        ORDER BY sort_order ASC, CAST(code AS INTEGER) ASC`
    )
    .bind(tenantId)
    .all<{ id: string; code: string; name: string }>();
  return res.results ?? [];
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
/**
 * ⚠ `cols` は「その従業員を指す列」を列挙する。既定は employee_id。
 *   thanks のように従業員を2方向から参照するテーブルがあるため、複数列を許す。
 */
export const EMPLOYEE_DELETION_ORDER: Array<{
  table: string;
  by: "employee_id" | "account_id" | "login_id";
  cols?: string[];
}> = [
  { table: "thanks", by: "employee_id", cols: ["from_employee_id", "to_employee_id"] },
  { table: "photo_posts", by: "employee_id" },
  { table: "daily_reports", by: "employee_id" },
  { table: "attendance_summaries", by: "employee_id" },
  { table: "shift_period_flags", by: "employee_id" },
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
  "shift_period_flags",
  "shifts",
  "attendance_summaries",
  // thanks / photo_posts / daily_reports は employees を参照する
  "thanks",
  "photo_posts",
  "daily_reports",
  "daily_report_categories",
  "employees",
  "shift_types",
  // worksites を参照するため、worksites より先に消すこと
  "worksite_monthly_reports",
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
    let cols: string[];
    if (step.by === "employee_id") {
      key = employeeId;
      cols = step.cols ?? [step.table === "employees" ? "id" : "employee_id"];
    } else if (step.by === "account_id") {
      key = emp.account_id;
      cols = step.cols ?? [step.table === "accounts" ? "id" : "account_id"];
    } else {
      key = loginId;
      cols = step.cols ?? ["login_id"];
    }
    if (key === null) {
      deleted[step.table] = 0;
      continue;
    }
    // 複数列のいずれかに一致する行を消す（例: thanks の from / to）
    const where = cols.map((c) => `${c} = ?1`).join(" OR ");
    const res = await db.prepare(`DELETE FROM ${step.table} WHERE ${where}`).bind(key).run();
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
  /** 現行 shift_s_id: その日の確定 */
  isConfirmed: boolean;
  /** 現行 shift_flg2: 当日確認（立つと実績側が編集不可）*/
  isDayLocked: boolean;
  /** 現行 shift_remarks1: フリー入力 */
  note: string | null;
  /** 現行 shift_flg8: 当日フリー */
  dayNote: string | null;
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
           note=?10, is_confirmed=?11, is_day_locked=?12, day_note=?13, updated_at=?14, deleted_at=NULL
         WHERE id=?15 AND tenant_id=?16`
      )
      .bind(
        input.worksiteId, input.clockIn, storedClockOut, input.breakMinutes,
        input.overtimeMinutes, workedMinutes, input.isAbsent ? 1 : 0, input.isLate ? 1 : 0,
        input.isEarlyLeave ? 1 : 0, input.note,
        input.isConfirmed ? 1 : 0, input.isDayLocked ? 1 : 0, input.dayNote,
        t, existing.id, tenantId
      )
      .run();
    return { shiftId: existing.id, workedMinutes };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO shifts (id,tenant_id,worksite_id,employee_id,worked_on,shift_type_id,clock_in,clock_out,
         break_minutes,overtime_minutes,worked_minutes,is_absent,is_late,is_early_leave,note,
         is_confirmed,is_day_locked,day_note,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?19)`
    )
    .bind(
      id, tenantId, input.worksiteId, input.employeeId, input.workedOn, input.shiftTypeId,
      input.clockIn, storedClockOut, input.breakMinutes, input.overtimeMinutes, workedMinutes,
      input.isAbsent ? 1 : 0, input.isLate ? 1 : 0, input.isEarlyLeave ? 1 : 0, input.note,
      input.isConfirmed ? 1 : 0, input.isDayLocked ? 1 : 0, input.dayNote, t
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
 * 期間単位の「緊急確認」フラグ
 *
 * 現行 `user1flg1shift1insert`（`shift1_r1_flg1`）に相当。
 * ⚠ 当初これを「確定」と解釈したが、shift1Template.php の実証により
 *   画面上のラベルは「緊急確認」であることが判明した（2026-08-15）。
 *   日ごとの確定は shifts.is_confirmed（現行 shift_s_id）である。
 */
export async function setUrgentCheck(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  yearMonth: string,
  cutoffDay: number,
  needsUrgentCheck: boolean,
  actorAccountId: string
): Promise<{ periodStartOn: CalendarDate; needsUrgentCheck: boolean }> {
  const emp = await db
    .prepare(`SELECT id FROM employees WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(employeeId, tenantId)
    .first<{ id: string }>();
  if (emp === null) throw new ShiftServiceError("employee_not_found", "employee not found in tenant scope");

  const { start } = getCutoffRange(yearMonth, cutoffDay);
  const t = nowUtc();
  const existing = await db
    .prepare(`SELECT id FROM shift_period_flags WHERE employee_id = ?1 AND period_start_on = ?2`)
    .bind(employeeId, start)
    .first<{ id: string }>();

  if (existing !== null) {
    await db
      .prepare(
        `UPDATE shift_period_flags SET needs_urgent_check=?1, updated_by=?2, updated_at=?3
          WHERE id=?4 AND tenant_id=?5`
      )
      .bind(needsUrgentCheck ? 1 : 0, actorAccountId, t, existing.id, tenantId)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO shift_period_flags (id,tenant_id,employee_id,period_start_on,needs_urgent_check,updated_by,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?7)`
      )
      .bind(crypto.randomUUID(), tenantId, employeeId, start, needsUrgentCheck ? 1 : 0, actorAccountId, t)
      .run();
  }
  return { periodStartOn: start, needsUrgentCheck };
}

/** 指定期間に緊急確認フラグが立っているか */
export async function hasUrgentCheck(
  db: D1Database, tenantId: string, employeeId: string, periodStartOn: CalendarDate
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT needs_urgent_check FROM shift_period_flags WHERE tenant_id=?1 AND employee_id=?2 AND period_start_on=?3`)
    .bind(tenantId, employeeId, periodStartOn)
    .first<{ needs_urgent_check: number }>();
  return row !== null && row.needs_urgent_check === 1;
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

  const dup = await db
    .prepare(`SELECT id FROM accounts WHERE login_id = ?1`)
    .bind(input.adminLoginId)
    .first<{ id: string }>();
  if (dup !== null) return { ok: false, reason: "invalid_input" };

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

  // 勤務時間帯の初期値。現行 tb_m_cate1 の CATE1_REMARKS1..21 に相当し、
  // code は 1〜21 の数値。名称は会社ごとに自由に変更できる（shift1Template.php で実証）。
  for (const [i, name] of ["早番", "日勤", "遅番", "夜勤"].entries()) {
    await db
      .prepare(
        `INSERT INTO shift_types (id,tenant_id,code,name,sort_order,is_active,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,1,?6,?6)`
      )
      .bind(crypto.randomUUID(), tenantId, String(i + 1), name, i + 1, t)
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

/** シフト入力画面に必要な1期間分のデータ */
export interface ShiftSheetRow {
  workedOn: CalendarDate;
  day: number;
  weekday: string;
  shiftTypeId: string | null;
  clockIn: string | null;
  clockOut: string | null;
  breakMinutes: number;
  overtimeMinutes: number;
  workedMinutes: number;
  isConfirmed: boolean;
  isDayLocked: boolean;
  isAbsent: boolean;
  note: string | null;
  dayNote: string | null;
}

export interface ShiftSheet {
  employeeId: string;
  employeeName: string;
  yearMonth: string;
  periodStartOn: CalendarDate;
  periodEndOn: CalendarDate;
  needsUrgentCheck: boolean;
  totalWorkedMinutes: number;
  shiftTypes: Array<{ id: string; code: string; name: string }>;
  rows: ShiftSheetRow[];
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 締め期間の全日を1行ずつ返す（現行 shift1View.php の aryCalendar 相当）。
 * 登録の無い日も空行として返すため、画面側は期間を意識しなくてよい。
 */
export async function getShiftSheet(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  yearMonth: string,
  cutoffDay: number
): Promise<ShiftSheet> {
  const emp = await db
    .prepare(`SELECT id, name FROM employees WHERE id=?1 AND tenant_id=?2 AND deleted_at IS NULL`)
    .bind(employeeId, tenantId)
    .first<{ id: string; name: string }>();
  if (emp === null) throw new ShiftServiceError("employee_not_found", "employee not found in tenant scope");

  const { start, end } = getCutoffRange(yearMonth, cutoffDay);

  const types = await db
    .prepare(`SELECT id, code, name FROM shift_types WHERE tenant_id=?1 AND is_active=1 ORDER BY sort_order`)
    .bind(tenantId)
    .all<{ id: string; code: string; name: string }>();

  const shifts = await db
    .prepare(
      `SELECT worked_on, shift_type_id, clock_in, clock_out, break_minutes, overtime_minutes,
              worked_minutes, is_confirmed, is_day_locked, is_absent, note, day_note
         FROM shifts
        WHERE tenant_id=?1 AND employee_id=?2 AND worked_on>=?3 AND worked_on<=?4 AND deleted_at IS NULL`
    )
    .bind(tenantId, employeeId, start, end)
    .all<{
      worked_on: string; shift_type_id: string | null; clock_in: string | null; clock_out: string | null;
      break_minutes: number; overtime_minutes: number; worked_minutes: number;
      is_confirmed: number; is_day_locked: number; is_absent: number; note: string | null; day_note: string | null;
    }>();

  const byDate = new Map((shifts.results ?? []).map((r) => [r.worked_on, r]));

  const rows: ShiftSheetRow[] = eachDate(start, end).map((d) => {
    const r = byDate.get(d);
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    return {
      workedOn: d,
      day: Number(d.slice(8, 10)),
      weekday: WEEKDAYS[dow],
      shiftTypeId: r?.shift_type_id ?? null,
      clockIn: r?.clock_in ?? null,
      clockOut: r?.clock_out ?? null,
      breakMinutes: r?.break_minutes ?? 0,
      overtimeMinutes: r?.overtime_minutes ?? 0,
      workedMinutes: r?.worked_minutes ?? 0,
      isConfirmed: r?.is_confirmed === 1,
      isDayLocked: r?.is_day_locked === 1,
      isAbsent: r?.is_absent === 1,
      note: r?.note ?? null,
      dayNote: r?.day_note ?? null,
    };
  });

  return {
    employeeId,
    employeeName: emp.name,
    yearMonth,
    periodStartOn: start,
    periodEndOn: end,
    needsUrgentCheck: await hasUrgentCheck(db, tenantId, employeeId, start),
    totalWorkedMinutes: rows.reduce((a, r) => a + r.workedMinutes, 0),
    shiftTypes: types.results ?? [],
    rows,
  };
}

// ===============================================================
// プロフィール（機能権限表 区分5 / T-11〜T-17）
// ===============================================================
/**
 * 🔴 現行から意図的に変えた点（profile1/2/3updateAction.php・profile3Template.php で実証）:
 *
 *   ① 写真を公開ディレクトリに置かない。
 *      現行は `../upload/{su1_id}/{su2_id}/{file}` で、URL を知れば誰でも顔写真を取得できた。
 *      新システムは R2 に保存し、認証必須のエンドポイント経由でのみ配信する。
 *
 *   ② オブジェクトキーをユーザー入力から作らない。
 *      現行は `unlink($directory_path . $this->getRequest("su2_pic1"))` で、
 *      検査のない入力値を連結して削除していた（任意ファイル削除の可能性）。
 *      新システムは DB に保存済みのキーだけを削除対象にする。
 *
 *   ③ サイズ上限と内容検査を入れる（現行は exif_imagetype のみ）。
 *
 *   ④ パスワード列を表示分岐に使わない。
 *      現行 profile01sTemplate.php は `{if $userp->SU1_PASS ==""}` で表示を切り替えていた。
 *
 *   ⑤ 自分のプロフィールだけ編集できる。閲覧は同一テナント内に限る。
 */

/** 顔写真の上限。Workers のリクエスト上限内で余裕を見た値【会話合意 2026-08-16】 */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** 本文の上限。現行は無制限だったが、D1 の行サイズと表示崩れを防ぐため設ける */
export const PROFILE_TEXT_MAX = 2000;

/** 受け入れる画像形式。マジックナンバーで判定する（拡張子や Content-Type を信用しない） */
const PHOTO_TYPES = [
  { mime: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/gif", ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
] as const;

/** 先頭バイト列から画像形式を判定する。判定できなければ null */
export function sniffImageType(bytes: Uint8Array): { mime: string; ext: string } | null {
  for (const t of PHOTO_TYPES) {
    if (bytes.length < t.magic.length) continue;
    let ok = true;
    for (let i = 0; i < t.magic.length; i++) {
      if (bytes[i] !== t.magic[i]) { ok = false; break; }
    }
    if (ok) return { mime: t.mime, ext: t.ext };
  }
  return null;
}

export interface Profile {
  employeeId: string;
  name: string;
  /** 画面ラベル「Profile」（現行 su2_remarks3）*/
  profileText: string | null;
  /** 画面ラベル「Note」（現行 su2_remarks4）*/
  profileNote: string | null;
  hasPhoto: boolean;
}

interface ProfileDbRow {
  id: string;
  name: string;
  profile_text: string | null;
  profile_note: string | null;
  photo_object_key: string | null;
}

/** 同一テナント内のプロフィールを取得する。他テナントは null（存在を漏らさない） */
export async function getProfile(
  db: D1Database,
  tenantId: string,
  employeeId: string
): Promise<Profile | null> {
  const r = await db
    .prepare(
      `SELECT id, name, profile_text, profile_note, photo_object_key
         FROM employees WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`
    )
    .bind(employeeId, tenantId)
    .first<ProfileDbRow>();
  if (r === null) return null;
  return {
    employeeId: r.id,
    name: r.name,
    profileText: r.profile_text,
    profileNote: r.profile_note,
    hasPhoto: r.photo_object_key !== null,
  };
}

/** ログイン中のアカウントに紐づく従業員。プロフィールの編集可否の判定に使う */
export async function getOwnEmployeeId(
  db: D1Database,
  tenantId: string,
  accountId: string
): Promise<string | null> {
  const r = await db
    .prepare(`SELECT id FROM employees WHERE account_id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(accountId, tenantId)
    .first<{ id: string }>();
  return r?.id ?? null;
}

/** 本文の更新。🔴 呼び出す前に「自分のものか」を確認すること */
export async function updateProfile(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  input: { profileText?: string | null; profileNote?: string | null }
): Promise<void> {
  const current = await getProfile(db, tenantId, employeeId);
  if (current === null) throw new RegistrationError([{ field: "employeeId", code: "not_found" }]);

  const issues: ValidationIssue[] = [];
  const text = input.profileText === undefined ? current.profileText : input.profileText;
  const note = input.profileNote === undefined ? current.profileNote : input.profileNote;
  if (text !== null && text.length > PROFILE_TEXT_MAX) issues.push({ field: "profileText", code: "too_long" });
  if (note !== null && note.length > PROFILE_TEXT_MAX) issues.push({ field: "profileNote", code: "too_long" });
  if (issues.length > 0) throw new RegistrationError(issues);

  await db
    .prepare(
      `UPDATE employees SET profile_text = ?1, profile_note = ?2, updated_at = ?3
        WHERE id = ?4 AND tenant_id = ?5`
    )
    .bind(emptyToNull(text), emptyToNull(note), nowUtc(), employeeId, tenantId)
    .run();
}

/**
 * 顔写真の差し替え。古いオブジェクトは DB に記録されたキーだけを消す。
 * 🔴 キーはこちらで生成する。ユーザー入力を連結しない（現行の任意ファイル削除対策）。
 */
export async function putProfilePhoto(
  db: D1Database,
  photos: R2Bucket,
  tenantId: string,
  employeeId: string,
  bytes: Uint8Array
): Promise<{ objectKey: string; mime: string }> {
  if (bytes.length === 0) throw new RegistrationError([{ field: "photo", code: "required" }]);
  if (bytes.length > PHOTO_MAX_BYTES) throw new RegistrationError([{ field: "photo", code: "too_large" }]);

  const kind = sniffImageType(bytes);
  if (kind === null) throw new RegistrationError([{ field: "photo", code: "unsupported_type" }]);

  const cur = await db
    .prepare(`SELECT photo_object_key FROM employees WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(employeeId, tenantId)
    .first<{ photo_object_key: string | null }>();
  if (cur === null) throw new RegistrationError([{ field: "employeeId", code: "not_found" }]);

  // キーにテナントIDを含める。R2 側から見ても所属が追える
  const objectKey = `tenants/${tenantId}/employees/${employeeId}/${crypto.randomUUID()}.${kind.ext}`;
  await photos.put(objectKey, bytes, { httpMetadata: { contentType: kind.mime } });

  await db
    .prepare(`UPDATE employees SET photo_object_key = ?1, updated_at = ?2 WHERE id = ?3 AND tenant_id = ?4`)
    .bind(objectKey, nowUtc(), employeeId, tenantId)
    .run();

  if (cur.photo_object_key !== null && cur.photo_object_key !== objectKey) {
    await photos.delete(cur.photo_object_key);
  }
  return { objectKey, mime: kind.mime };
}

/** 顔写真の削除 */
export async function deleteProfilePhoto(
  db: D1Database,
  photos: R2Bucket,
  tenantId: string,
  employeeId: string
): Promise<boolean> {
  const cur = await db
    .prepare(`SELECT photo_object_key FROM employees WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(employeeId, tenantId)
    .first<{ photo_object_key: string | null }>();
  if (cur === null) throw new RegistrationError([{ field: "employeeId", code: "not_found" }]);
  if (cur.photo_object_key === null) return false;

  await photos.delete(cur.photo_object_key);
  await db
    .prepare(`UPDATE employees SET photo_object_key = NULL, updated_at = ?1 WHERE id = ?2 AND tenant_id = ?3`)
    .bind(nowUtc(), employeeId, tenantId)
    .run();
  return true;
}

/** 配信用のキー取得。🔴 tenant_id で必ず絞る */
export async function getProfilePhotoKey(
  db: D1Database,
  tenantId: string,
  employeeId: string
): Promise<string | null> {
  const r = await db
    .prepare(`SELECT photo_object_key FROM employees WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(employeeId, tenantId)
    .first<{ photo_object_key: string | null }>();
  return r?.photo_object_key ?? null;
}

// ===============================================================
// 店舗情報＝月次の人事指標レポート（機能権限表 区分4 / T-18〜T-22）
// ===============================================================
/**
 * ⚠ 「店舗情報」という名称に反して、店舗マスタではない。
 *    募集・採用・離職を月ごとに記録する機能である（company1Template.php で実証）。
 *    店舗の名称・住所は worksites が持つ。
 *
 * 🔴 現行から意図的に変えた点:
 *   ① 平均勤続・平均年齢を保存しない。
 *      現行は保存時に getuser1avgcomovage() で算出して COMPANY1_SERVICE / _AGE に
 *      書き込んでいたが、従業員データが変われば過去月の値も変わるべきものである。
 *      新実装は参照時に都度算出する。
 *   ② 年間集計テーブルを作らない（article_counter1_com3 廃止）【会話合意⑥】。
 *      年間の値は一覧取得時に合算する。
 *   ③ overtime 列を作らない（画面に入力欄が無く、常に空だった）。
 *   ④ 締め日の扱いを階層で分けない。
 *      現行は company1Template にのみ締め日の分岐があり、company2Template には無かった。
 */

export interface MonthlyReport {
  id: string;
  worksiteId: string | null;
  worksiteName: string | null;
  periodYearMonth: string;
  recruitCount: number;
  hireCount: number;
  turnoverCount: number;
  note: string | null;
}

interface MonthlyReportDbRow {
  id: string;
  worksite_id: string | null;
  worksite_name: string | null;
  period_year_month: string;
  recruit_count: number;
  hire_count: number;
  turnover_count: number;
  note: string | null;
}

const REPORT_SELECT = `
  SELECT r.id, r.worksite_id, w.name AS worksite_name, r.period_year_month,
         r.recruit_count, r.hire_count, r.turnover_count, r.note
    FROM worksite_monthly_reports r
    LEFT JOIN worksites w ON w.id = r.worksite_id`;

function toReport(r: MonthlyReportDbRow): MonthlyReport {
  return {
    id: r.id,
    worksiteId: r.worksite_id,
    worksiteName: r.worksite_name,
    periodYearMonth: r.period_year_month,
    recruitCount: r.recruit_count,
    hireCount: r.hire_count,
    turnoverCount: r.turnover_count,
    note: r.note,
  };
}

/** 'YYYY-MM' として妥当か。月は 01〜12 */
export function isYearMonth(v: string): boolean {
  if (!/^\d{4}-\d{2}$/.test(v)) return false;
  const m = Number(v.slice(5, 7));
  return m >= 1 && m <= 12;
}

export interface MonthlyReportInput {
  worksiteId: string | null;
  periodYearMonth: string;
  recruitCount: number;
  hireCount: number;
  turnoverCount: number;
  note: string | null;
}

export function validateMonthlyReport(input: MonthlyReportInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isYearMonth(input.periodYearMonth)) issues.push({ field: "periodYearMonth", code: "invalid_format" });
  for (const [field, v] of [
    ["recruitCount", input.recruitCount],
    ["hireCount", input.hireCount],
    ["turnoverCount", input.turnoverCount],
  ] as const) {
    if (!Number.isInteger(v)) issues.push({ field, code: "not_an_integer" });
    else if (v < 0) issues.push({ field, code: "out_of_range" });
    else if (v > 100000) issues.push({ field, code: "out_of_range" });
  }
  if (input.note !== null && input.note.length > PROFILE_TEXT_MAX) issues.push({ field: "note", code: "too_long" });
  return issues;
}

/**
 * 登録・更新。同一店舗・同一年月は1件に保つ。
 * 現行は getcompany1c() で件数を数えて弾いていたが、新実装は UNIQUE 制約でも二重に守る。
 */
export async function upsertMonthlyReport(
  db: D1Database,
  tenantId: string,
  input: MonthlyReportInput
): Promise<{ id: string; created: boolean }> {
  const issues = validateMonthlyReport(input);
  if (issues.length > 0) throw new RegistrationError(issues);

  const worksiteId = emptyToNull(input.worksiteId);
  if (worksiteId !== null) {
    const ws = await db
      .prepare(`SELECT id FROM worksites WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
      .bind(worksiteId, tenantId)
      .first<{ id: string }>();
    if (ws === null) throw new RegistrationError([{ field: "worksiteId", code: "not_found" }]);
  }

  const t = nowUtc();
  // 🔴 tenant_id を必ず条件に入れる（B-6）
  const existing = await db
    .prepare(
      `SELECT id FROM worksite_monthly_reports
        WHERE tenant_id = ?1 AND period_year_month = ?2
          AND (worksite_id IS ?3) AND deleted_at IS NULL`
    )
    .bind(tenantId, input.periodYearMonth, worksiteId)
    .first<{ id: string }>();

  if (existing !== null) {
    await db
      .prepare(
        `UPDATE worksite_monthly_reports
            SET recruit_count = ?1, hire_count = ?2, turnover_count = ?3, note = ?4, updated_at = ?5
          WHERE id = ?6 AND tenant_id = ?7`
      )
      .bind(input.recruitCount, input.hireCount, input.turnoverCount, emptyToNull(input.note), t, existing.id, tenantId)
      .run();
    return { id: existing.id, created: false };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO worksite_monthly_reports
         (id,tenant_id,worksite_id,period_year_month,recruit_count,hire_count,turnover_count,note,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)`
    )
    .bind(id, tenantId, worksiteId, input.periodYearMonth, input.recruitCount, input.hireCount,
          input.turnoverCount, emptyToNull(input.note), t)
    .run();
  return { id, created: true };
}

/** 単票。他テナントは null */
export async function getMonthlyReport(
  db: D1Database,
  tenantId: string,
  reportId: string
): Promise<MonthlyReport | null> {
  const r = await db
    .prepare(`${REPORT_SELECT} WHERE r.id = ?1 AND r.tenant_id = ?2 AND r.deleted_at IS NULL`)
    .bind(reportId, tenantId)
    .first<MonthlyReportDbRow>();
  return r === null ? null : toReport(r);
}

export interface MonthlyReportListResult {
  reports: MonthlyReport[];
  /** 年間の合算。現行の article_counter1_com3 に相当するが、保存せず都度算出する */
  totals: { recruitCount: number; hireCount: number; turnoverCount: number };
  /** 離職率 = 離職数 / (期首在籍 + 採用数)。算出できなければ null */
  turnoverRate: number | null;
}

/**
 * 一覧。year を指定すると 'YYYY-01'〜'YYYY-12' に絞る。
 * ⚠ 年間始月（テナントごとの年度の区切り）は 0003 時点で未実装。
 *   実装後は開始月からの12ヶ月に変更すること【未確認・機能権限表 1.2 ③】。
 */
export async function listMonthlyReports(
  db: D1Database,
  tenantId: string,
  opts: { year?: string | null; worksiteId?: string | null } = {}
): Promise<MonthlyReportListResult> {
  const clauses = ["r.tenant_id = ?1", "r.deleted_at IS NULL"];
  const binds: string[] = [tenantId];

  const year = emptyToNull(opts.year ?? null);
  if (year !== null) {
    if (!/^\d{4}$/.test(year)) throw new RegistrationError([{ field: "year", code: "invalid_format" }]);
    binds.push(`${year}-%`);
    clauses.push(`r.period_year_month LIKE ?${binds.length}`);
  }
  const worksiteId = emptyToNull(opts.worksiteId ?? null);
  if (worksiteId !== null) {
    binds.push(worksiteId);
    clauses.push(`r.worksite_id = ?${binds.length}`);
  }

  const res = await db
    .prepare(`${REPORT_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY r.period_year_month DESC LIMIT 500`)
    .bind(...binds)
    .all<MonthlyReportDbRow>();
  const reports = (res.results ?? []).map(toReport);

  const totals = { recruitCount: 0, hireCount: 0, turnoverCount: 0 };
  for (const r of reports) {
    totals.recruitCount += r.recruitCount;
    totals.hireCount += r.hireCount;
    totals.turnoverCount += r.turnoverCount;
  }
  const denom = totals.hireCount + totals.turnoverCount;
  const turnoverRate = denom === 0 ? null : Math.round((totals.turnoverCount / denom) * 1000) / 10;
  return { reports, totals, turnoverRate };
}

/**
 * その月の平均勤続・平均年齢。🔴 保存しない。参照のたびに算出する。
 * 現行 getuser1avgcomovage() 相当。月末日を基準日にする。
 */
export async function monthlyWorkforceStats(
  db: D1Database,
  tenantId: string,
  periodYearMonth: string,
  worksiteId: string | null = null
): Promise<{ headcount: number; avgTenureMonths: number | null; avgAge: number | null }> {
  if (!isYearMonth(periodYearMonth)) throw new RegistrationError([{ field: "periodYearMonth", code: "invalid_format" }]);
  const [y, m] = periodYearMonth.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const asOf = `${periodYearMonth}-${String(lastDay).padStart(2, "0")}`;

  const binds: string[] = [tenantId];
  let extra = "";
  if (worksiteId !== null) { binds.push(worksiteId); extra = ` AND worksite_id = ?${binds.length}`; }

  const res = await db
    .prepare(
      `SELECT hired_on, birth_on FROM employees
        WHERE tenant_id = ?1 AND deleted_at IS NULL AND status = 'active'${extra}`
    )
    .bind(...binds)
    .all<{ hired_on: string | null; birth_on: string | null }>();
  const rows = res.results ?? [];

  let tenureSum = 0, tenureN = 0, ageSum = 0, ageN = 0;
  for (const r of rows) {
    if (r.hired_on !== null && r.hired_on <= asOf) {
      const t = tenureYearsMonths(r.hired_on, asOf);
      tenureSum += t.years * 12 + t.months;
      tenureN++;
    }
    if (r.birth_on !== null) { ageSum += ageOn(r.birth_on, asOf); ageN++; }
  }
  return {
    headcount: rows.length,
    avgTenureMonths: tenureN === 0 ? null : Math.round((tenureSum / tenureN) * 10) / 10,
    avgAge: ageN === 0 ? null : Math.round((ageSum / ageN) * 10) / 10,
  };
}

// ===============================================================
// 業務日報（機能権限表 区分10 / T-23〜T-29）
// ===============================================================
/**
 * 🔴 現行から意図的に変えた点（dreport2Template.php / dreport2updateAction.php で実証）:
 *
 *   ① 経過時間を分（INTEGER）で1つだけ持つ。
 *      現行は REPORT_TIME3（時間単位の小数・小数点以下10桁）と REPORT_TIME4（'HH:MM:SS'）を
 *      二重に保存していた。不変条件③に反するうえ、二重持ちは食い違いを生む。
 *
 *   ② 日跨ぎの判定を normalizeClockOut() に集約する。
 *      現行は Action ごとに if($timestamp1 > $timestamp2) を書いていた（設計書 4.13.1 と同型）。
 *
 *   ③ REPORT_DATE_TIME1/2（検索用の日時列）を持たない。
 *      reported_on と start_time / end_time から導けるため。
 *
 *   ④ 画像を R2 に置き、配信を認証必須にする（現行は ../images/ の公開ディレクトリ）。
 *
 *   ⑤ $diff->h で差を作ると days が無視され 24時間以上で壊れる。分の引き算にする。
 */

export interface ReportCategory {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

/** カテゴリ一覧。現行 tb_m_dr（マスタ①の「マスターデータ」画面が管理する） */
export async function listReportCategories(
  db: D1Database,
  tenantId: string,
  includeInactive = false
): Promise<ReportCategory[]> {
  const where = includeInactive ? "" : " AND is_active = 1";
  const res = await db
    .prepare(
      `SELECT id, name, sort_order, is_active FROM daily_report_categories
        WHERE tenant_id = ?1${where} ORDER BY sort_order ASC, name ASC`
    )
    .bind(tenantId)
    .all<{ id: string; name: string; sort_order: number; is_active: number }>();
  return (res.results ?? []).map((r) => ({
    id: r.id, name: r.name, sortOrder: r.sort_order, isActive: r.is_active === 1,
  }));
}

export async function upsertReportCategory(
  db: D1Database,
  tenantId: string,
  input: { id?: string | null; name: string; sortOrder?: number; isActive?: boolean }
): Promise<{ id: string; created: boolean }> {
  const name = (input.name ?? "").trim();
  if (name === "") throw new RegistrationError([{ field: "name", code: "required" }]);
  if (name.length > 100) throw new RegistrationError([{ field: "name", code: "too_long" }]);
  const sortOrder = input.sortOrder ?? 0;
  if (!Number.isInteger(sortOrder)) throw new RegistrationError([{ field: "sortOrder", code: "not_an_integer" }]);
  const isActive = input.isActive === false ? 0 : 1;
  const t = nowUtc();

  const id = emptyToNull(input.id ?? null);
  if (id !== null) {
    const cur = await db
      .prepare(`SELECT id FROM daily_report_categories WHERE id = ?1 AND tenant_id = ?2`)
      .bind(id, tenantId)
      .first<{ id: string }>();
    if (cur === null) throw new RegistrationError([{ field: "id", code: "not_found" }]);
    await db
      .prepare(
        `UPDATE daily_report_categories SET name = ?1, sort_order = ?2, is_active = ?3, updated_at = ?4
          WHERE id = ?5 AND tenant_id = ?6`
      )
      .bind(name, sortOrder, isActive, t, id, tenantId)
      .run();
    return { id, created: false };
  }

  const dup = await db
    .prepare(`SELECT id FROM daily_report_categories WHERE tenant_id = ?1 AND name = ?2`)
    .bind(tenantId, name)
    .first<{ id: string }>();
  if (dup !== null) throw new RegistrationError([{ field: "name", code: "already_taken" }]);

  const newId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO daily_report_categories (id,tenant_id,name,sort_order,is_active,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?6)`
    )
    .bind(newId, tenantId, name, sortOrder, isActive, t)
    .run();
  return { id: newId, created: true };
}

export interface DailyReport {
  id: string;
  employeeId: string;
  employeeName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  reportedOn: CalendarDate;
  startTime: ClockTime;
  /** 日跨ぎは 24時超え表記（例 26:30）。表示は formatClockOut() を通す */
  endTime: ClockTime;
  durationMinutes: Minutes;
  body: string | null;
  hasPhoto: boolean;
}

interface DailyReportDbRow {
  id: string;
  employee_id: string;
  employee_name: string | null;
  category_id: string | null;
  category_name: string | null;
  reported_on: string;
  start_time: string;
  end_time: string;
  duration_minutes: number;
  body: string | null;
  photo_object_key: string | null;
}

const DAILY_REPORT_SELECT = `
  SELECT r.id, r.employee_id, e.name AS employee_name, r.category_id,
         c.name AS category_name, r.reported_on, r.start_time, r.end_time,
         r.duration_minutes, r.body, r.photo_object_key
    FROM daily_reports r
    LEFT JOIN employees e ON e.id = r.employee_id
    LEFT JOIN daily_report_categories c ON c.id = r.category_id`;

function toDailyReport(r: DailyReportDbRow): DailyReport {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    reportedOn: r.reported_on,
    startTime: r.start_time,
    endTime: r.end_time,
    durationMinutes: r.duration_minutes,
    body: r.body,
    hasPhoto: r.photo_object_key !== null,
  };
}

export interface DailyReportInput {
  employeeId: string;
  categoryId: string | null;
  reportedOn: CalendarDate;
  startTime: ClockTime;
  endTime: ClockTime;
  body: string | null;
}

/**
 * 所要時間を算出する。日跨ぎは終了を翌日として扱う（normalizeClockOut に集約）。
 * 🔴 現行の $diff->h は days を無視するため 24時間以上で壊れる。分の引き算にする。
 */
export function calcReportMinutes(startTime: ClockTime, endTime: ClockTime): Minutes {
  return parseClock(normalizeClockOut(startTime, endTime)) - parseClock(startTime);
}

export function validateDailyReport(input: DailyReportInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRealDate(input.reportedOn)) issues.push({ field: "reportedOn", code: "not_a_real_date" });
  for (const [field, v] of [["startTime", input.startTime], ["endTime", input.endTime]] as const) {
    if (!/^\d{1,3}:[0-5]\d$/.test(v)) issues.push({ field, code: "invalid_format" });
  }
  if (issues.length === 0 && input.startTime === input.endTime) {
    // 現行の JS も同値を弾いていた（「時間を確認してください」）
    issues.push({ field: "endTime", code: "same_as_start" });
  }
  if (input.body !== null && input.body.length > PROFILE_TEXT_MAX) {
    issues.push({ field: "body", code: "too_long" });
  }
  return issues;
}

/**
 * 同じ従業員・同じ日で時間帯が重なる日報を探す。
 * ⚠ 現行と同じく「警告するが登録は許可する」【会話合意 2026-08-16】。
 *   現行は Ajax の dreport2check が文言を返すだけで、保存側に検査が無かった。
 */
export async function findOverlappingReports(
  db: D1Database,
  tenantId: string,
  employeeId: string,
  reportedOn: CalendarDate,
  startTime: ClockTime,
  endTime: ClockTime,
  excludeId: string | null = null
): Promise<DailyReport[]> {
  const s = parseClock(startTime);
  const e = parseClock(normalizeClockOut(startTime, endTime));
  const res = await db
    .prepare(
      `${DAILY_REPORT_SELECT}
        WHERE r.tenant_id = ?1 AND r.employee_id = ?2 AND r.reported_on = ?3 AND r.deleted_at IS NULL`
    )
    .bind(tenantId, employeeId, reportedOn)
    .all<DailyReportDbRow>();
  return (res.results ?? [])
    .filter((r) => r.id !== excludeId)
    .filter((r) => {
      const rs = parseClock(r.start_time);
      const re = parseClock(r.end_time);
      // 端が接するだけ（前の終了 == 次の開始）は重複としない
      return rs < e && s < re;
    })
    .map(toDailyReport);
}

export async function upsertDailyReport(
  db: D1Database,
  tenantId: string,
  reportId: string | null,
  input: DailyReportInput
): Promise<{ id: string; created: boolean; overlaps: DailyReport[] }> {
  const issues = validateDailyReport(input);
  if (issues.length > 0) throw new RegistrationError(issues);

  const emp = await db
    .prepare(`SELECT id FROM employees WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(input.employeeId, tenantId)
    .first<{ id: string }>();
  if (emp === null) throw new RegistrationError([{ field: "employeeId", code: "not_found" }]);

  const categoryId = emptyToNull(input.categoryId);
  if (categoryId !== null) {
    const c = await db
      .prepare(`SELECT id FROM daily_report_categories WHERE id = ?1 AND tenant_id = ?2 AND is_active = 1`)
      .bind(categoryId, tenantId)
      .first<{ id: string }>();
    if (c === null) throw new RegistrationError([{ field: "categoryId", code: "not_found" }]);
  }

  const endTime = normalizeClockOut(input.startTime, input.endTime);
  const durationMinutes = calcReportMinutes(input.startTime, input.endTime);
  const overlaps = await findOverlappingReports(
    db, tenantId, input.employeeId, input.reportedOn, input.startTime, input.endTime, reportId
  );
  const t = nowUtc();

  if (reportId !== null) {
    const cur = await db
      .prepare(`SELECT id FROM daily_reports WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
      .bind(reportId, tenantId)
      .first<{ id: string }>();
    if (cur === null) throw new RegistrationError([{ field: "reportId", code: "not_found" }]);
    await db
      .prepare(
        `UPDATE daily_reports
            SET employee_id = ?1, category_id = ?2, reported_on = ?3, start_time = ?4,
                end_time = ?5, duration_minutes = ?6, body = ?7, updated_at = ?8
          WHERE id = ?9 AND tenant_id = ?10`
      )
      .bind(input.employeeId, categoryId, input.reportedOn, input.startTime, endTime,
            durationMinutes, emptyToNull(input.body), t, reportId, tenantId)
      .run();
    return { id: reportId, created: false, overlaps };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO daily_reports
         (id,tenant_id,employee_id,category_id,reported_on,start_time,end_time,duration_minutes,body,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)`
    )
    .bind(id, tenantId, input.employeeId, categoryId, input.reportedOn, input.startTime,
          endTime, durationMinutes, emptyToNull(input.body), t)
    .run();
  return { id, created: true, overlaps };
}

export async function getDailyReport(
  db: D1Database,
  tenantId: string,
  reportId: string
): Promise<DailyReport | null> {
  const r = await db
    .prepare(`${DAILY_REPORT_SELECT} WHERE r.id = ?1 AND r.tenant_id = ?2 AND r.deleted_at IS NULL`)
    .bind(reportId, tenantId)
    .first<DailyReportDbRow>();
  return r === null ? null : toDailyReport(r);
}

export async function listDailyReports(
  db: D1Database,
  tenantId: string,
  opts: { employeeId?: string | null; reportedOn?: string | null; month?: string | null } = {}
): Promise<DailyReport[]> {
  const clauses = ["r.tenant_id = ?1", "r.deleted_at IS NULL"];
  const binds: string[] = [tenantId];
  if (opts.employeeId !== undefined && opts.employeeId !== null && opts.employeeId !== "") {
    binds.push(opts.employeeId);
    clauses.push(`r.employee_id = ?${binds.length}`);
  }
  const on = emptyToNull(opts.reportedOn ?? null);
  if (on !== null) {
    if (!isRealDate(on)) throw new RegistrationError([{ field: "reportedOn", code: "not_a_real_date" }]);
    binds.push(on);
    clauses.push(`r.reported_on = ?${binds.length}`);
  }
  const month = emptyToNull(opts.month ?? null);
  if (month !== null) {
    if (!isYearMonth(month)) throw new RegistrationError([{ field: "month", code: "invalid_format" }]);
    binds.push(`${month}-%`);
    clauses.push(`r.reported_on LIKE ?${binds.length}`);
  }
  const res = await db
    .prepare(
      `${DAILY_REPORT_SELECT} WHERE ${clauses.join(" AND ")}
        ORDER BY r.reported_on DESC, r.start_time ASC LIMIT 500`
    )
    .bind(...binds)
    .all<DailyReportDbRow>();
  return (res.results ?? []).map(toDailyReport);
}

/** 論理削除。写真は R2 から実際に消す（孤児を作らない） */
export async function deleteDailyReport(
  db: D1Database,
  photos: R2Bucket,
  tenantId: string,
  reportId: string
): Promise<boolean> {
  const cur = await db
    .prepare(`SELECT photo_object_key FROM daily_reports WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(reportId, tenantId)
    .first<{ photo_object_key: string | null }>();
  if (cur === null) return false;
  if (cur.photo_object_key !== null) await photos.delete(cur.photo_object_key);
  const t = nowUtc();
  await db
    .prepare(`UPDATE daily_reports SET deleted_at = ?1, photo_object_key = NULL, updated_at = ?1 WHERE id = ?2 AND tenant_id = ?3`)
    .bind(t, reportId, tenantId)
    .run();
  return true;
}

/** 日報の写真。プロフィールと同じ作法（キーは自前生成・中身で判定） */
export async function putDailyReportPhoto(
  db: D1Database,
  photos: R2Bucket,
  tenantId: string,
  reportId: string,
  bytes: Uint8Array
): Promise<{ objectKey: string; mime: string }> {
  if (bytes.length === 0) throw new RegistrationError([{ field: "photo", code: "required" }]);
  if (bytes.length > PHOTO_MAX_BYTES) throw new RegistrationError([{ field: "photo", code: "too_large" }]);
  const kind = sniffImageType(bytes);
  if (kind === null) throw new RegistrationError([{ field: "photo", code: "unsupported_type" }]);

  const cur = await db
    .prepare(`SELECT photo_object_key FROM daily_reports WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(reportId, tenantId)
    .first<{ photo_object_key: string | null }>();
  if (cur === null) throw new RegistrationError([{ field: "reportId", code: "not_found" }]);

  const objectKey = `tenants/${tenantId}/daily-reports/${reportId}/${crypto.randomUUID()}.${kind.ext}`;
  await photos.put(objectKey, bytes, { httpMetadata: { contentType: kind.mime } });
  await db
    .prepare(`UPDATE daily_reports SET photo_object_key = ?1, updated_at = ?2 WHERE id = ?3 AND tenant_id = ?4`)
    .bind(objectKey, nowUtc(), reportId, tenantId)
    .run();
  if (cur.photo_object_key !== null && cur.photo_object_key !== objectKey) {
    await photos.delete(cur.photo_object_key);
  }
  return { objectKey, mime: kind.mime };
}

export async function getDailyReportPhotoKey(
  db: D1Database,
  tenantId: string,
  reportId: string
): Promise<string | null> {
  const r = await db
    .prepare(`SELECT photo_object_key FROM daily_reports WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(reportId, tenantId)
    .first<{ photo_object_key: string | null }>();
  return r?.photo_object_key ?? null;
}

// ===============================================================
// 社内フォト共有（機能権限表 区分8 / T-30〜T-34）
// ===============================================================
/**
 * ⚠ 現行のテーブル名は tb_m_chat1 だがチャットではない。社内フォト共有である。
 *
 * 🔴 現行から意図的に変えた点:
 *   ① 画像1枚＋ひと言1つに絞る。現行は画面の8項目（pic2〜5 / comment2〜5）が
 *      すべてコメントアウトされており、Action にだけ処理が残っていた。
 *   ② 画像を R2 に置き、配信を認証必須にする（現行は ../image/ の公開ディレクトリ）。
 *   ③ 投稿と画像を1回で受け取る。画像が無い投稿は作らせない。
 *   ④ 削除できるのは投稿者本人と人事権系統のみ【会話合意 2026-08-16】。
 */

export interface PhotoPost {
  id: string;
  employeeId: string;
  employeeName: string | null;
  caption: string | null;
  postedOn: CalendarDate;
  createdAt: UtcInstant;
}

interface PhotoPostDbRow {
  id: string;
  employee_id: string;
  employee_name: string | null;
  caption: string | null;
  posted_on: string;
  created_at: string;
}

const PHOTO_POST_SELECT = `
  SELECT p.id, p.employee_id, e.name AS employee_name, p.caption, p.posted_on, p.created_at
    FROM photo_posts p
    LEFT JOIN employees e ON e.id = p.employee_id`;

function toPhotoPost(r: PhotoPostDbRow): PhotoPost {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    caption: r.caption,
    postedOn: r.posted_on,
    createdAt: r.created_at,
  };
}

/** ひと言の上限。現行は無制限だった */
export const CAPTION_MAX = 200;

/**
 * 投稿。画像は必須で、キーはこちらで生成する。
 * 🔴 R2 への書き込みに成功してから DB に入れる。DB が失敗したら R2 を巻き戻す。
 */
export async function createPhotoPost(
  db: D1Database,
  photos: R2Bucket,
  tenantId: string,
  employeeId: string,
  input: { caption: string | null; postedOn: CalendarDate; bytes: Uint8Array }
): Promise<{ id: string; objectKey: string }> {
  const issues: ValidationIssue[] = [];
  if (!isRealDate(input.postedOn)) issues.push({ field: "postedOn", code: "not_a_real_date" });
  if (input.caption !== null && input.caption.length > CAPTION_MAX) {
    issues.push({ field: "caption", code: "too_long" });
  }
  if (input.bytes.length === 0) issues.push({ field: "photo", code: "required" });
  else if (input.bytes.length > PHOTO_MAX_BYTES) issues.push({ field: "photo", code: "too_large" });
  if (issues.length > 0) throw new RegistrationError(issues);

  const kind = sniffImageType(input.bytes);
  if (kind === null) throw new RegistrationError([{ field: "photo", code: "unsupported_type" }]);

  const emp = await db
    .prepare(`SELECT id FROM employees WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(employeeId, tenantId)
    .first<{ id: string }>();
  if (emp === null) throw new RegistrationError([{ field: "employeeId", code: "not_found" }]);

  const id = crypto.randomUUID();
  const objectKey = `tenants/${tenantId}/photo-posts/${id}/${crypto.randomUUID()}.${kind.ext}`;
  await photos.put(objectKey, input.bytes, { httpMetadata: { contentType: kind.mime } });

  try {
    const t = nowUtc();
    await db
      .prepare(
        `INSERT INTO photo_posts (id,tenant_id,employee_id,caption,photo_object_key,posted_on,created_at,updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?7)`
      )
      .bind(id, tenantId, employeeId, emptyToNull(input.caption), objectKey, input.postedOn, t)
      .run();
  } catch (e) {
    // DB に入らなかったオブジェクトを R2 に残さない
    await photos.delete(objectKey);
    throw e;
  }
  return { id, objectKey };
}

export async function listPhotoPosts(
  db: D1Database,
  tenantId: string,
  opts: { employeeId?: string | null; limit?: number } = {}
): Promise<PhotoPost[]> {
  const clauses = ["p.tenant_id = ?1", "p.deleted_at IS NULL"];
  const binds: string[] = [tenantId];
  const employeeId = emptyToNull(opts.employeeId ?? null);
  if (employeeId !== null) {
    binds.push(employeeId);
    clauses.push(`p.employee_id = ?${binds.length}`);
  }
  const limit = opts.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RegistrationError([{ field: "limit", code: "out_of_range" }]);
  }
  const res = await db
    .prepare(
      `${PHOTO_POST_SELECT} WHERE ${clauses.join(" AND ")}
        ORDER BY p.posted_on DESC, p.created_at DESC LIMIT ${limit}`
    )
    .bind(...binds)
    .all<PhotoPostDbRow>();
  return (res.results ?? []).map(toPhotoPost);
}

export async function getPhotoPost(
  db: D1Database,
  tenantId: string,
  postId: string
): Promise<PhotoPost | null> {
  const r = await db
    .prepare(`${PHOTO_POST_SELECT} WHERE p.id = ?1 AND p.tenant_id = ?2 AND p.deleted_at IS NULL`)
    .bind(postId, tenantId)
    .first<PhotoPostDbRow>();
  return r === null ? null : toPhotoPost(r);
}

export async function getPhotoPostKey(
  db: D1Database,
  tenantId: string,
  postId: string
): Promise<string | null> {
  const r = await db
    .prepare(`SELECT photo_object_key FROM photo_posts WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(postId, tenantId)
    .first<{ photo_object_key: string }>();
  return r?.photo_object_key ?? null;
}

/** 削除。🔴 呼び出す前に「投稿者本人か人事権系統か」を確認すること */
export async function deletePhotoPost(
  db: D1Database,
  photos: R2Bucket,
  tenantId: string,
  postId: string
): Promise<boolean> {
  const cur = await db
    .prepare(`SELECT photo_object_key FROM photo_posts WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
    .bind(postId, tenantId)
    .first<{ photo_object_key: string }>();
  if (cur === null) return false;
  await photos.delete(cur.photo_object_key);
  const t = nowUtc();
  await db
    .prepare(`UPDATE photo_posts SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND tenant_id = ?3`)
    .bind(t, postId, tenantId)
    .run();
  return true;
}

// ===============================================================
// ありがとう情報（機能権限表 区分7 / T-35〜T-40）
// ===============================================================
/**
 * 🔴 現行から意図的に変えた点（thanks2Template.php / thanks2updateAction.php で実証）:
 *
 *   ① 集計テーブル5本を作らない【会話合意⑥】。
 *      現行は1回の送信で本体1件＋集計5件の計6回書き込んでいた。
 *      獲得順位も含め、すべて thanks の実データから都度算出する。
 *
 *   ② 🔴 月次の上限を実際に検査する。
 *      現行は画面に「ありがとう数(月30まで)」と表示するだけで、
 *      Action 側に検査が0件だった。31回目以降も登録できていた【コード実証】。
 *
 *   ③ 自分自身には送れない（ランキングの自作自演を防ぐ）。
 *      現行は宛先リストから自分を除外していない【未確認だが除外の記述なし】。
 *
 *   ④ 集計対象月は締め日基準。getCutoffRange() と同じ考え方を使う。
 */

/** 1人あたりの月次上限。画面表示と実装を一致させる【会話合意 2026-08-16】 */
export const THANKS_MONTHLY_LIMIT = 30;

/** メッセージの上限。現行は無制限だった */
export const THANKS_MESSAGE_MAX = 500;

/**
 * 送信日から集計対象月を決める。締め日を過ぎていなければ前月に属する。
 * 例: 締め日20日・2026-08-25 に送信 → 2026-09 の期間（8/21〜9/20）
 */
export function thanksPeriodOf(thankedOn: CalendarDate, cutoffDay: number): string {
  if (!isRealDate(thankedOn)) throw new RegistrationError([{ field: "thankedOn", code: "not_a_real_date" }]);
  if (!Number.isInteger(cutoffDay) || cutoffDay < 1 || cutoffDay > 31) {
    throw new RegistrationError([{ field: "cutoffDay", code: "out_of_range" }]);
  }
  const [y, m, d] = thankedOn.split("-").map(Number);
  // 月末締め（cutoffDay が当月の末日以上）なら、その月がそのまま対象
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (cutoffDay >= lastDay) return `${thankedOn.slice(0, 7)}`;
  // 締め日を過ぎていれば翌月の期間に入る
  if (d > cutoffDay) {
    const nm = m === 12 ? 1 : m + 1;
    const ny = m === 12 ? y + 1 : y;
    return `${ny}-${String(nm).padStart(2, "0")}`;
  }
  return thankedOn.slice(0, 7);
}

export interface Thanks {
  id: string;
  fromEmployeeId: string;
  fromName: string | null;
  toEmployeeId: string;
  toName: string | null;
  message: string | null;
  thankedOn: CalendarDate;
  periodYearMonth: string;
}

interface ThanksDbRow {
  id: string;
  from_employee_id: string;
  from_name: string | null;
  to_employee_id: string;
  to_name: string | null;
  message: string | null;
  thanked_on: string;
  period_year_month: string;
}

const THANKS_SELECT = `
  SELECT t.id, t.from_employee_id, f.name AS from_name,
         t.to_employee_id, p.name AS to_name,
         t.message, t.thanked_on, t.period_year_month
    FROM thanks t
    LEFT JOIN employees f ON f.id = t.from_employee_id
    LEFT JOIN employees p ON p.id = t.to_employee_id`;

function toThanks(r: ThanksDbRow): Thanks {
  return {
    id: r.id,
    fromEmployeeId: r.from_employee_id,
    fromName: r.from_name,
    toEmployeeId: r.to_employee_id,
    toName: r.to_name,
    message: r.message,
    thankedOn: r.thanked_on,
    periodYearMonth: r.period_year_month,
  };
}

/** その期間に送った件数。上限の判定と画面表示に使う */
export async function countThanksSent(
  db: D1Database,
  tenantId: string,
  fromEmployeeId: string,
  periodYearMonth: string
): Promise<number> {
  const r = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM thanks
        WHERE tenant_id = ?1 AND from_employee_id = ?2 AND period_year_month = ?3 AND deleted_at IS NULL`
    )
    .bind(tenantId, fromEmployeeId, periodYearMonth)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function sendThanks(
  db: D1Database,
  tenantId: string,
  fromEmployeeId: string,
  input: { toEmployeeId: string; message: string | null; thankedOn: CalendarDate }
): Promise<{ id: string; periodYearMonth: string; sentInPeriod: number }> {
  const issues: ValidationIssue[] = [];
  if (!isRealDate(input.thankedOn)) issues.push({ field: "thankedOn", code: "not_a_real_date" });
  if (input.message !== null && input.message.length > THANKS_MESSAGE_MAX) {
    issues.push({ field: "message", code: "too_long" });
  }
  // 🔴 自分自身には送れない
  if (input.toEmployeeId === fromEmployeeId) issues.push({ field: "toEmployeeId", code: "same_as_sender" });
  if (issues.length > 0) throw new RegistrationError(issues);

  // 送り主・宛先とも自テナントに実在すること（B-6）
  for (const [field, id] of [["fromEmployeeId", fromEmployeeId], ["toEmployeeId", input.toEmployeeId]] as const) {
    const e = await db
      .prepare(`SELECT id FROM employees WHERE id = ?1 AND tenant_id = ?2 AND deleted_at IS NULL`)
      .bind(id, tenantId)
      .first<{ id: string }>();
    if (e === null) throw new RegistrationError([{ field, code: "not_found" }]);
  }

  const tenant = await db
    .prepare(`SELECT cutoff_day FROM tenants WHERE id = ?1`)
    .bind(tenantId)
    .first<{ cutoff_day: number }>();
  const cutoffDay = tenant?.cutoff_day ?? 31;
  const periodYearMonth = thanksPeriodOf(input.thankedOn, cutoffDay);

  // 🔴 現行は画面に書いてあるだけで検査していなかった
  const sent = await countThanksSent(db, tenantId, fromEmployeeId, periodYearMonth);
  if (sent >= THANKS_MONTHLY_LIMIT) {
    throw new RegistrationError([{ field: "thanks", code: "monthly_limit_reached" }]);
  }

  const id = crypto.randomUUID();
  const t = nowUtc();
  await db
    .prepare(
      `INSERT INTO thanks (id,tenant_id,from_employee_id,to_employee_id,message,thanked_on,period_year_month,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)`
    )
    .bind(id, tenantId, fromEmployeeId, input.toEmployeeId, emptyToNull(input.message),
          input.thankedOn, periodYearMonth, t)
    .run();
  return { id, periodYearMonth, sentInPeriod: sent + 1 };
}

export async function listThanks(
  db: D1Database,
  tenantId: string,
  opts: { toEmployeeId?: string | null; fromEmployeeId?: string | null; period?: string | null; limit?: number } = {}
): Promise<Thanks[]> {
  const clauses = ["t.tenant_id = ?1", "t.deleted_at IS NULL"];
  const binds: string[] = [tenantId];
  const to = emptyToNull(opts.toEmployeeId ?? null);
  if (to !== null) { binds.push(to); clauses.push(`t.to_employee_id = ?${binds.length}`); }
  const from = emptyToNull(opts.fromEmployeeId ?? null);
  if (from !== null) { binds.push(from); clauses.push(`t.from_employee_id = ?${binds.length}`); }
  const period = emptyToNull(opts.period ?? null);
  if (period !== null) {
    if (!isYearMonth(period)) throw new RegistrationError([{ field: "period", code: "invalid_format" }]);
    binds.push(period);
    clauses.push(`t.period_year_month = ?${binds.length}`);
  }
  const limit = opts.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RegistrationError([{ field: "limit", code: "out_of_range" }]);
  }
  const res = await db
    .prepare(
      `${THANKS_SELECT} WHERE ${clauses.join(" AND ")}
        ORDER BY t.thanked_on DESC, t.created_at DESC LIMIT ${limit}`
    )
    .bind(...binds)
    .all<ThanksDbRow>();
  return (res.results ?? []).map(toThanks);
}

export interface RankingRow {
  rank: number;
  employeeId: string;
  employeeName: string | null;
  receivedCount: number;
}

/**
 * 獲得順位。🔴 保存せず都度算出する（現行 article_counter1_rank を廃止）。
 * 同数は同順位とし、次の順位はその分だけ飛ばす（1,1,3 方式）。
 * period が null なら全期間。
 */
export async function thanksRanking(
  db: D1Database,
  tenantId: string,
  period: string | null = null,
  limit = 50
): Promise<RankingRow[]> {
  if (period !== null && !isYearMonth(period)) {
    throw new RegistrationError([{ field: "period", code: "invalid_format" }]);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new RegistrationError([{ field: "limit", code: "out_of_range" }]);
  }
  const binds: string[] = [tenantId];
  let extra = "";
  if (period !== null) { binds.push(period); extra = ` AND t.period_year_month = ?${binds.length}`; }

  const res = await db
    .prepare(
      `SELECT t.to_employee_id AS employee_id, e.name AS employee_name, COUNT(*) AS n
         FROM thanks t
         LEFT JOIN employees e ON e.id = t.to_employee_id
        WHERE t.tenant_id = ?1 AND t.deleted_at IS NULL${extra}
        GROUP BY t.to_employee_id, e.name
        ORDER BY n DESC, e.name ASC
        LIMIT ${limit}`
    )
    .bind(...binds)
    .all<{ employee_id: string; employee_name: string | null; n: number }>();

  const rows = res.results ?? [];
  const out: RankingRow[] = [];
  let lastCount: number | null = null;
  let lastRank = 0;
  rows.forEach((r, i) => {
    const rank = lastCount !== null && r.n === lastCount ? lastRank : i + 1;
    lastCount = r.n;
    lastRank = rank;
    out.push({ rank, employeeId: r.employee_id, employeeName: r.employee_name, receivedCount: r.n });
  });
  return out;
}
