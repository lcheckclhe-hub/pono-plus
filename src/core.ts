/**
 * PONO-PLUS 段階1 — 基盤レイヤ
 *
 * 日時 / パスワード / 認可 / データアクセス。業務ロジックを含まない。
 * 統合元: lib/time.ts + lib/password.ts + lib/authz.ts + lib/db.ts
 */
import { scrypt } from "@noble/hashes/scrypt";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

// ===============================================================
// time.ts
// ===============================================================
/**
 * 日時ユーティリティ
 *
 * 設計根拠（改修設計書 v6 4.12・スキーマ設計 2.3）:
 *   現行システムの9時間オフセットは、JST設定下で「経過秒」をタイムスタンプとして
 *   日時整形していたことが原因だった。本モジュールでは
 *     - 発生時刻は UTC ISO8601 の文字列
 *     - 暦日は JST 基準の 'YYYY-MM-DD'
 *     - 経過時間は「分の整数」
 *   の3つを型レベルで分離し、混同を起こさせない。
 */

export type UtcInstant = string; // 'YYYY-MM-DDTHH:MM:SSZ'
export type CalendarDate = string; // 'YYYY-MM-DD' (JST基準の暦日)
export type ClockTime = string; // 'HH:MM' 24時超え可 (例 '30:00')
export type Minutes = number;

const JST_OFFSET_MINUTES = 9 * 60;

/** 現在時刻を UTC ISO8601（秒精度）で返す */
export function nowUtc(d: Date = new Date()): UtcInstant {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** UTC 時刻を JST 基準の暦日に変換する */
export function toJstCalendarDate(utc: UtcInstant): CalendarDate {
  const t = Date.parse(utc);
  if (Number.isNaN(t)) throw new Error(`invalid UtcInstant: ${utc}`);
  const shifted = new Date(t + JST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** 'HH:MM'（24時超え可）を 0時起点の分に変換する */
export function parseClock(clock: ClockTime): Minutes {
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(clock);
  if (!m) throw new Error(`invalid ClockTime: ${clock}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 分を 'HH:MM' に戻す。24時以上はそのまま 24超え表記で出す */
export function formatClock(minutes: Minutes): ClockTime {
  if (!Number.isInteger(minutes) || minutes < 0) {
    throw new Error(`invalid minutes: ${minutes}`);
  }
  const h = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * 退勤時刻を日跨ぎ正規化する。
 * 現行 shift23updateAction には日跨ぎ判定が無く実働が負値になっていた（設計書 4.13.1）。
 * 判定を各画面に置かず、ここ1箇所に集約する。
 */
export function normalizeClockOut(clockIn: ClockTime, clockOut: ClockTime): ClockTime {
  const inMin = parseClock(clockIn);
  let outMin = parseClock(clockOut);
  if (outMin < inMin) outMin += 24 * 60;
  return formatClock(outMin);
}

/** 分を 'H時間M分' 相当の表示用に分解する（表示層専用） */
export function splitDuration(minutes: Minutes): { hours: number; minutes: number } {
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}

/** 暦日の加算（JSTの暦日として扱う） */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid CalendarDate: ${date}`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 満年数・満月数（暦日ベース）。現行の 365.25日近似は採用しない（設計書 4.10） */
export function tenureYearsMonths(from: CalendarDate, to: CalendarDate): { years: number; months: number } {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  if (months < 0) months = 0;
  return { years: Math.floor(months / 12), months: months % 12 };
}

// ===============================================================
// password.ts
// ===============================================================
/**
 * パスワードハッシュ
 *
 * PoC-F（2026-08-14）の決定:
 *   Argon2id / m=19456KiB / t=2 / p=1  … 実測 約56ms・バンドル +29KB
 *   PBKDF2 は Cloudflare Workers が反復回数を100,000で打ち切るため不採用。
 *
 * 現行システム（改修設計書 6.2.1/6.2.2）との違い:
 *   - 平文を別列に保持しない
 *   - 共有静的ソルト "ps" を使わない。ソルトはハッシュ文字列に内包される
 */

/** セッショントークン等のハッシュ。平文トークンを保存しないために使う */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * パスワードハッシュ: scrypt（純JS実装）
 *
 * 🔴 なぜ Argon2id ではないか（2026-08-15 実機で判明）:
 *   Cloudflare Workers は実行時の WASM コンパイルを禁止しており
 *   （WebAssembly.instantiate は事前コンパイル済みモジュールのみ対応）、
 *   hash-wasm のような「バイト列から実行時に compile する」実装は
 *   "Wasm code generation disallowed by embedder" で必ず失敗する。
 *   PoC-F の測定は Node 上だったためこの制約を検出できなかった。
 *
 * パラメータ N=2^14 / r=8 / p=5 は OWASP が示す等価構成のうち最も軽量なもの。
 * 必要メモリは 128*N*r = 16MiB（Workers の isolate 上限128MBに対して安全）。
 * 実測 約319ms（Node・1コア）。
 *
 * ⚠ 将来 wrangler CLI が使える環境になれば、.wasm を別モジュールとして
 *   import する形で Argon2id に移行できる。その際は needsRehash() が
 *   ログイン成功時に自動で再ハッシュする。
 */
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 5, dkLen: 32 } as const;
export const ALGO_LABEL = `scrypt$N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`;

interface ScryptParams { N: number; r: number; p: number; dkLen: number }
function deriveScrypt(password: string, salt: Uint8Array, params: ScryptParams = SCRYPT_PARAMS): Uint8Array {
  return scrypt(new TextEncoder().encode(password), salt, {
    N: params.N, r: params.r, p: params.p, dkLen: params.dkLen,
  });
}

export async function hashPassword(password: string): Promise<{ hash: string; algo: string }> {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("password must be a non-empty string");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const dk = deriveScrypt(password, salt);
  // 形式: $scrypt$N=..,r=..,p=..$<salt hex>$<hash hex>
  const hash = `$scrypt$N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$${bytesToHex(salt)}$${bytesToHex(dk)}`;
  return { hash, algo: ALGO_LABEL };
}

/** 実行時間が内容に依存しないよう定数時間で比較する */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  try {
    const m = /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(storedHash);
    if (m === null) return false;
    const params = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]), dkLen: hexToBytes(m[5]).length };
    const dk = deriveScrypt(password, hexToBytes(m[4]), params);
    return timingSafeEqualHex(bytesToHex(dk), m[5]);
  } catch {
    return false;
  }
}

/** 保存済みハッシュが現行パラメータより弱ければ true（ログイン成功時に再ハッシュする） */
export function needsRehash(storedHash: string): boolean {
  const m = /^\$scrypt\$N=(\d+),r=(\d+),p=(\d+)\$/.exec(storedHash);
  if (m === null) return true;
  return Number(m[1]) < SCRYPT_PARAMS.N || Number(m[2]) < SCRYPT_PARAMS.r || Number(m[3]) < SCRYPT_PARAMS.p;
}

/**
 * ログイン失敗時も同等の時間を消費させ、応答時間からアカウントの存在を
 * 推測されないようにする。
 */
const DUMMY_PASSWORD = "pono-plus-timing-equalizer";
let dummyHash: string | null = null;
export async function equalizeTiming(): Promise<void> {
  if (dummyHash === null) dummyHash = (await hashPassword(DUMMY_PASSWORD)).hash;
  await verifyPassword(DUMMY_PASSWORD, dummyHash);
}

// ===============================================================
// authz.ts
// ===============================================================
/**
 * 認可
 *
 * 設計根拠:
 *  - 改修設計書 v6 5.3(1) / 7.2【法令実証】人事権を有する者は実施者・実施事務従事者になれない
 *    （労働安全衛生規則第52条の10第2項）
 *  - 同 6.2.6【コード実証】現行 adminall1st はセッションと URL パラメータを突き合わせておらず、
 *    他社データを取得し得る構造だった（B-6）
 *  - 同 4.2 ディスパッチャに認証がなく、shift3updateAction には認証失敗時の遷移が無かった（B-5）
 */

export interface RoleDef {
  code: string;
  name: string;
  isHrLine: boolean;
}

/** ロール定義。is_hr_line が段階2の分離の中核（スキーマ設計 4.2） */
export const ROLES: Record<string, RoleDef> = {
  system_admin: { code: "system_admin", name: "システム管理者", isHrLine: false },
  tenant_admin: { code: "tenant_admin", name: "会社管理者", isHrLine: true },
  worksite_manager: { code: "worksite_manager", name: "事業場管理者", isHrLine: true },
  employee: { code: "employee", name: "従業員", isHrLine: false },
  sc_implementer: { code: "sc_implementer", name: "ストレスチェック実施者", isHrLine: false },
  sc_clerk: { code: "sc_clerk", name: "実施事務従事者", isHrLine: false },
};

export interface Principal {
  accountId: string;
  tenantId: string | null; // null = システム管理者
  roleCodes: string[];
}

export class AuthzError extends Error {
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.reason = reason;
  }
}

export function isSystemAdmin(p: Principal): boolean {
  return p.roleCodes.includes("system_admin");
}

/** 人事権系統のロールを1つでも持つか */
export function hasHrLineRole(p: Principal): boolean {
  return p.roleCodes.some((c) => ROLES[c]?.isHrLine === true);
}

/**
 * B-6 の対処: セッションの主体とリソース所有テナントを必ず突き合わせる。
 * リポジトリ層から必ず呼ばせることで、Action ごとの実装漏れを構造的に防ぐ。
 */
export function assertTenantScope(p: Principal, resourceTenantId: string): void {
  if (isSystemAdmin(p)) return;
  if (p.tenantId === null) {
    throw new AuthzError("principal has no tenant", "no_tenant");
  }
  if (p.tenantId !== resourceTenantId) {
    throw new AuthzError("tenant mismatch", "tenant_mismatch");
  }
}

/**
 * 段階2で使用する判定。人事権系統は結果に触れられない。
 * 段階1の時点で器を用意し、後付け不能な構造を先に作る（改修設計書 2.3）。
 */
export function canAccessStressCheckResult(p: Principal): boolean {
  if (hasHrLineRole(p)) return false;
  return p.roleCodes.some((c) => c === "sc_implementer" || c === "sc_clerk");
}

/** 勤怠評価（遅刻・早退・欠勤）は人事権系統に許可される。上の判定と非対称であることが要点 */
export function canAccessAttendance(p: Principal): boolean {
  return isSystemAdmin(p) || hasHrLineRole(p);
}

// ===============================================================
// 機能権限表 v4 §2 の実装（Session 06 で追加）
//
// 🔴 これまで判定は isSystemAdmin / hasHrLineRole / canAccessAttendance の
//    3つしか無く、tenant_admin（マスタ①）と worksite_manager（マスタ②）が
//    is_hr_line=true で同一に扱われていた。機能権限表は①②に差を付けているため、
//    区分3（アカウント）と区分10（業務日報）で仕様と実装がずれていた（H-1・H-2）。
// ===============================================================

/** マスタ①（会社アカウント・人事権者） */
export function isTenantAdmin(p: Principal): boolean {
  return p.roleCodes.includes("tenant_admin");
}

/** マスタ②（店舗管理者クラス） */
export function isWorksiteManager(p: Principal): boolean {
  return p.roleCodes.includes("worksite_manager");
}

/** マスタ③（一般スタッフ）。①②のいずれでもなく、system_admin でもない */
export function isStaff(p: Principal): boolean {
  return !isSystemAdmin(p) && !isTenantAdmin(p) && !isWorksiteManager(p);
}

/** 権限の段階。◎=作成・編集 ／ ○=閲覧のみ ／ none=メニューに存在しない */
export type Access = "edit" | "view" | "none";

/** 機能権限表 v4 §2 の区分 */
export type Section =
  | "notice" // 1 トップ表示
  | "activity" // 2 更新履歴
  | "account" // 3 アカウント
  | "worksite" // 4 店舗情報
  | "profile" // 5 プロフィール
  | "shift" // 6 シフト
  | "thanks" // 7 ありがとう情報
  | "photo" // 8 社内フォト共有
  | "skill" // 9 スキルシート
  | "daily_report" // 10 業務日報
  | "stress_check" // 11 セルフストレスチェック（段階2）
  | "support"; // 12 サポート

/**
 * 🔴 機能権限表 v4 §2 の表をそのまま写したもの。**この表が正本である。**
 *    実装を変えるときは、先にこの表と機能権限表を合わせること。
 *
 * ⚠ 区分10 業務日報の①が "view" なのは誤記ではない。機能権限表 §3② の
 *   「①は日報を書かず、定型項目を定義して読む側。管理者と記入者が分離されている」
 *   という設計意図による。日報の「マスターデータ」定義は別枠（canEditReportCategory）。
 * ⚠ 区分6 シフトの③が "view" なのも同様。「スタッフは自分のシフトを見るだけで登録しない」（§3④）。
 */
export const SECTION_ACCESS: Record<Section, { tenantAdmin: Access; worksiteManager: Access; staff: Access }> = {
  notice: { tenantAdmin: "edit", worksiteManager: "edit", staff: "view" },
  activity: { tenantAdmin: "view", worksiteManager: "view", staff: "view" },
  account: { tenantAdmin: "edit", worksiteManager: "none", staff: "none" },
  worksite: { tenantAdmin: "edit", worksiteManager: "edit", staff: "none" },
  profile: { tenantAdmin: "edit", worksiteManager: "edit", staff: "edit" },
  shift: { tenantAdmin: "edit", worksiteManager: "edit", staff: "view" },
  thanks: { tenantAdmin: "edit", worksiteManager: "edit", staff: "edit" },
  photo: { tenantAdmin: "edit", worksiteManager: "edit", staff: "edit" },
  skill: { tenantAdmin: "edit", worksiteManager: "edit", staff: "edit" },
  daily_report: { tenantAdmin: "view", worksiteManager: "edit", staff: "edit" },
  stress_check: { tenantAdmin: "edit", worksiteManager: "edit", staff: "edit" },
  support: { tenantAdmin: "view", worksiteManager: "view", staff: "view" },
};

/**
 * その主体が区分に対して持つ権限を返す。
 * ⚠ system_admin は業務機能を一切持たない（機能権限表 1.1）。
 *   テナント管理だけを行うため、ここでは常に "none" を返す。
 */
export function accessFor(p: Principal, section: Section): Access {
  if (isSystemAdmin(p)) return "none";
  const a = SECTION_ACCESS[section];
  if (isTenantAdmin(p)) return a.tenantAdmin;
  if (isWorksiteManager(p)) return a.worksiteManager;
  return a.staff;
}

/** 区分を閲覧できるか（◎ または ○） */
export function canView(p: Principal, section: Section): boolean {
  return accessFor(p, section) !== "none";
}

/** 区分を作成・編集できるか（◎ のみ） */
export function canEdit(p: Principal, section: Section): boolean {
  return accessFor(p, section) === "edit";
}

/**
 * 業務日報の「マスターデータ」（定型項目の定義）を編集できるか。
 * 機能権限表 §2 区分10 では①がマスターデータを持ち、②は登録側。
 * 表の access（①=view）とは別軸のため専用の判定を置く。
 */
export function canEditReportCategory(p: Principal): boolean {
  return isTenantAdmin(p) || isWorksiteManager(p);
}

/** 従業員が自分自身のデータを見る場合 */
export function canAccessOwnEmployee(p: Principal, employeeAccountId: string): boolean {
  return p.accountId === employeeAccountId;
}

// ===============================================================
// db.ts
// ===============================================================
/**
 * テナント境界を強制するデータアクセス層
 *
 * 設計根拠（スキーマ設計 2.5 / 改修設計書 6.2.6）:
 *   現行 adminall1st はセッションとURLパラメータを突き合わせておらず、
 *   他社のデータを取得できる構造だった（B-6）。
 *   アプリ層の実装漏れに依存しないよう、業務テーブルへのアクセスを
 *   本クラス経由に限定し、tenant_id 条件を自動付与する。
 */

/** tenant_id を必須とする業務テーブル。ここに無いテーブルは scoped API では触れない */
export const TENANT_SCOPED_TABLES = [
  "worksites",
  "contracts",
  "consent_logs",
  "deletion_jobs",
  "employees",
  "shift_types",
  "shifts",
  "shift_period_flags",
  "attendance_summaries",
  "worksite_monthly_reports",
  "daily_report_categories",
  "daily_reports",
  "photo_posts",
  "thanks",
  "skill_sheets",
  "tenant_notices",
  "tenant_notice_links",
  "tenant_notice_images",
] as const;

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

export class TenantScopeError extends Error {}

function assertScopedTable(table: string): asserts table is TenantScopedTable {
  if (!(TENANT_SCOPED_TABLES as readonly string[]).includes(table)) {
    throw new TenantScopeError(
      `table '${table}' is not tenant-scoped. Add it to TENANT_SCOPED_TABLES or use the unscoped API deliberately.`
    );
  }
}

/** 識別子は列挙されたテーブル名・列名のみを通す（文字列連結によるSQL構築を封じる） */
const IDENT = /^[a-z_][a-z0-9_]*$/;
function assertIdent(name: string): void {
  if (!IDENT.test(name)) throw new TenantScopeError(`invalid identifier: ${name}`);
}

export class TenantDb {
  private readonly db: D1Database;
  private readonly principal: Principal;

  constructor(db: D1Database, principal: Principal) {
    this.db = db;
    this.principal = principal;
  }

  private tenantId(): string {
    if (this.principal.tenantId === null) {
      throw new TenantScopeError("principal has no tenant; use unscoped API explicitly");
    }
    return this.principal.tenantId;
  }

  /** 主キー1件取得。取得後に所有テナントを必ず突合する（二重の防御） */
  async findById<T extends Record<string, unknown>>(table: string, id: string): Promise<T | null> {
    assertScopedTable(table);
    const row = await this.db
      .prepare(`SELECT * FROM ${table} WHERE id = ?1`)
      .bind(id)
      .first<T & { tenant_id: string }>();
    if (row === null) return null;
    assertTenantScope(this.principal, row.tenant_id);
    return row;
  }

  /** 条件検索。tenant_id は呼び出し側が書かなくても必ず付く */
  async findMany<T>(
    table: string,
    where: Record<string, string | number | null> = {},
    opts: { orderBy?: string; limit?: number } = {}
  ): Promise<T[]> {
    assertScopedTable(table);
    const clauses: string[] = [];
    const binds: (string | number | null)[] = [];

    if (!isSystemAdmin(this.principal)) {
      clauses.push(`tenant_id = ?${binds.length + 1}`);
      binds.push(this.tenantId());
    }
    for (const [k, v] of Object.entries(where)) {
      assertIdent(k);
      if (v === null) {
        clauses.push(`${k} IS NULL`);
      } else {
        clauses.push(`${k} = ?${binds.length + 1}`);
        binds.push(v);
      }
    }
    let sql = `SELECT * FROM ${table}`;
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(" AND ")}`;
    if (opts.orderBy !== undefined) {
      const [col, dir = "ASC"] = opts.orderBy.split(" ");
      assertIdent(col);
      if (dir !== "ASC" && dir !== "DESC") throw new TenantScopeError(`invalid direction: ${dir}`);
      sql += ` ORDER BY ${col} ${dir}`;
    }
    if (opts.limit !== undefined) {
      if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new TenantScopeError("invalid limit");
      sql += ` LIMIT ${opts.limit}`;
    }
    const res = await this.db.prepare(sql).bind(...binds).all<T>();
    return res.results ?? [];
  }

  /** 挿入。tenant_id は引数に無くても自動付与し、食い違いがあれば拒否する */
  async insert(table: string, values: Record<string, string | number | null>): Promise<void> {
    assertScopedTable(table);
    const withTenant = { ...values };
    const tid = this.tenantId();
    if (withTenant.tenant_id === undefined || withTenant.tenant_id === null) {
      withTenant.tenant_id = tid;
    } else if (withTenant.tenant_id !== tid && !isSystemAdmin(this.principal)) {
      throw new TenantScopeError("tenant_id mismatch on insert");
    }
    const cols = Object.keys(withTenant);
    cols.forEach(assertIdent);
    const placeholders = cols.map((_, i) => `?${i + 1}`).join(",");
    await this.db
      .prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`)
      .bind(...cols.map((c) => withTenant[c]))
      .run();
  }

  /** 更新。WHERE には必ず id と tenant_id の両方が入る */
  async updateById(table: string, id: string, values: Record<string, string | number | null>): Promise<void> {
    assertScopedTable(table);
    const cols = Object.keys(values).filter((c) => c !== "id" && c !== "tenant_id");
    if (cols.length === 0) return;
    cols.forEach(assertIdent);
    const sets = cols.map((c, i) => `${c} = ?${i + 1}`).join(", ");
    const binds: (string | number | null)[] = cols.map((c) => values[c]);
    binds.push(id, this.tenantId());
    await this.db
      .prepare(`UPDATE ${table} SET ${sets} WHERE id = ?${cols.length + 1} AND tenant_id = ?${cols.length + 2}`)
      .bind(...binds)
      .run();
  }
}
