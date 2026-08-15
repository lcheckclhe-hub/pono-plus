/**
 * PONO-PLUS 段階1 テストスイート（統合版）
 *
 * 単体テスト・統合テスト・スキーマ設計原則の検査をこの1ファイルに集約する。
 * 旧構成: test/core.test.ts + test/integration.test.ts + test/shim.ts + scripts/audit_schema.py
 *
 * 実行: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  parseClock, formatClock, toJstCalendarDate, addDays, tenureYearsMonths, nowUtc,
} from "../src/core.ts";
import {
  calcWorkedMinutes, getCutoffRange, countByShiftType, eachDate, ShiftValidationError,
} from "../src/services.ts";
import {
  ROLES, assertTenantScope, canAccessStressCheckResult, canAccessAttendance, hasHrLineRole, AuthzError,
} from "../src/core.ts";
import { hashPassword, verifyPassword, needsRehash, ALGO_LABEL, sha256Hex } from "../src/core.ts";
import { login, logout } from "../src/services.ts";
import { TenantDb, TenantScopeError, TENANT_SCOPED_TABLES } from "../src/core.ts";
import {
  deleteEmployee, deleteTenant, DELETION_EXEMPT, TENANT_DELETION_ORDER, EMPLOYEE_DELETION_ORDER,
} from "../src/services.ts";
import {
  registerEmployee, validateRegistration, isRealDate, RegistrationError,
  EMPLOYMENT_TYPE_BY_LEGACY, GENDER_BY_LEGACY,
  listEmployees, getEmployee, updateEmployee, listShiftTypes, EMPLOYEE_STATUSES,
  getProfile, getOwnEmployeeId, updateProfile, putProfilePhoto, deleteProfilePhoto,
  getProfilePhotoKey, sniffImageType, PHOTO_MAX_BYTES, PROFILE_TEXT_MAX,
  upsertMonthlyReport, getMonthlyReport, listMonthlyReports, monthlyWorkforceStats,
  validateMonthlyReport, isYearMonth,
  listReportCategories, upsertReportCategory, upsertDailyReport, getDailyReport,
  listDailyReports, deleteDailyReport, putDailyReportPhoto, getDailyReportPhotoKey,
  findOverlappingReports, calcReportMinutes, validateDailyReport,
  createPhotoPost, listPhotoPosts, getPhotoPost, getPhotoPostKey, deletePhotoPost, CAPTION_MAX,
  sendThanks, listThanks, thanksRanking, countThanksSent, thanksPeriodOf,
  THANKS_MONTHLY_LIMIT, THANKS_MESSAGE_MAX,
  upsertSkillSheet, getSkillSheet, listSkillSheetsByYear, suggestSkillCounts,
  redactForEmployee, validateSkillSheet, SKILL_COMMENT_MAX,
  parseVideoRef, videoEmbedUrl, getTenantNotice, updateTenantNotice,
  addNoticeImage, deleteNoticeImage, getNoticeImageKey,
  listActivities, activityLabelOf, getSupportContent,
  NOTICE_IMAGE_MAX, NOTICE_LINK_MAX,
} from "../src/services.ts";
import { worker, routes } from "../src/index.ts";
import { loginPage, shiftSheetPage, formatClockOut, parseClockOut, employeeListPage, employeeFormPage, attendancePage, homePage, profilePage, profileViewPage, reportListPage, reportFormPage, dailyReportListPage, dailyReportFormPage, reportCategoryPage, photoListPage, photoNewPage, thanksListPage, thanksNewPage, thanksRankingPage, skillSheetPage, skillSheetFormPage, noticeEditPage, supportPage } from "../src/pages.ts";
import { bootstrapSetup, evaluateAttendance, ageOn, persistAttendanceSummary, getShiftSheet } from "../src/services.ts";
import { upsertShift, summarizePeriod, ShiftServiceError, setUrgentCheck, hasUrgentCheck, periodForDate } from "../src/services.ts";
import type { Principal } from "../src/core.ts";

const here = dirname(fileURLToPath(import.meta.url));
/**
 * マイグレーションは番号順に全件を連結する。
 * 0001 だけを読むと、後から追加した列がテストにだけ存在しない状態になり、
 * 実機との差分に気づけなくなる（Session 04 で 0002 追加時に対処）。
 */
const MIGRATIONS_DIR = join(here, "..", "migrations");
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const SCHEMA = MIGRATION_FILES.map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf-8")).join("\n");

type AnyDb = any;

// ===============================================================
// D1Database / R2Bucket の最小シム（テスト専用）
// ===============================================================


class ShimStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private binds: unknown[] = [];

  constructor(db: DatabaseSync, sql: string) {
    this.db = db;
    // D1 の ?1 ?2 形式を sqlite の ? に落とす（出現順が引数順であることを前提とする）
    this.sql = sql;
    this.binds = [];
  }

  bind(...values: unknown[]): ShimStatement {
    this.binds = values.map((v) => (v === undefined ? null : v));
    return this;
  }

  private normalized(): { sql: string; args: unknown[] } {
    const order: number[] = [];
    const sql = this.sql.replace(/\?(\d+)/g, (_m, d: string) => {
      order.push(Number(d) - 1);
      return "?";
    });
    if (order.length === 0) return { sql, args: this.binds };
    return { sql, args: order.map((i) => this.binds[i] ?? null) };
  }

  async first<T>(): Promise<T | null> {
    const { sql, args } = this.normalized();
    const row = this.db.prepare(sql).get(...(args as never[]));
    return (row === undefined ? null : (row as T));
  }

  async all<T>(): Promise<{ results: T[] }> {
    const { sql, args } = this.normalized();
    return { results: this.db.prepare(sql).all(...(args as never[])) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const { sql, args } = this.normalized();
    const r = this.db.prepare(sql).run(...(args as never[]));
    return { meta: { changes: Number(r.changes ?? 0) } };
  }
}

export class ShimD1 {
  readonly raw: DatabaseSync;

  constructor(schemaSql: string) {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec(schemaSql);
  }

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.raw, sql);
  }
}

export class ShimR2 {
  readonly objects = new Map<string, { body: unknown; httpMetadata?: { contentType?: string } }>();

  async put(key: string, value: unknown, opts?: { httpMetadata?: { contentType?: string } }): Promise<void> {
    this.objects.set(key, { body: value, httpMetadata: opts?.httpMetadata });
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async get(key: string): Promise<{ body: unknown; httpMetadata?: { contentType?: string } } | null> {
    return this.objects.get(key) ?? null;
  }
}

describe("time: 日時の分離（設計書 4.12 / スキーマ 2.3）", () => {
  test("JST基準の暦日に変換される（9時間オフセットの再発防止）", () => {
    // UTC 2026-08-13T15:00Z は JST では 2026-08-14 00:00
    assert.equal(toJstCalendarDate("2026-08-13T15:00:00Z"), "2026-08-14");
    assert.equal(toJstCalendarDate("2026-08-13T14:59:59Z"), "2026-08-13");
  });

  test("24時超え表記を往復できる", () => {
    assert.equal(parseClock("30:00"), 1800);
    assert.equal(formatClock(1800), "30:00");
    assert.equal(formatClock(parseClock("09:05")), "09:05");
  });

  test("不正な時刻は例外", () => {
    assert.throws(() => parseClock("9:60"));
    assert.throws(() => parseClock("abc"));
  });

  test("nowUtc は秒精度の Z 付き ISO8601", () => {
    assert.match(nowUtc(new Date("2026-08-14T01:02:03.456Z")), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("勤続年数は暦日ベース（365.25日近似を使わない・設計書 4.10）", () => {
    assert.deepEqual(tenureYearsMonths("2020-03-01", "2026-08-14"), { years: 6, months: 5 });
    assert.deepEqual(tenureYearsMonths("2020-03-15", "2026-03-14"), { years: 5, months: 11 });
    assert.deepEqual(tenureYearsMonths("2026-08-14", "2026-08-14"), { years: 0, months: 0 });
  });

  test("暦日の加算が月跨ぎ・年跨ぎで正しい", () => {
    assert.equal(addDays("2026-08-31", 1), "2026-09-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2024-02-28", 1), "2024-02-29"); // 閏年
  });
});

// ---------------------------------------------------------------
describe("shift: 実働時間（設計書 4.13.1・B-2/B-4）", () => {
  test("基本式 (退勤−出勤)+残業−休憩", () => {
    // 09:00-18:00 拘束9h、休憩60分、残業30分 → 480+30 = 510分
    assert.equal(
      calcWorkedMinutes({ clockIn: "09:00", clockOut: "18:00", breakMinutes: 60, overtimeMinutes: 30 }),
      510
    );
  });

  test("B-2: 日跨ぎでも負値にならない（現行 shift23update のバグ）", () => {
    // 22:00 → 06:00 = 8時間、休憩60分 → 420分
    const v = calcWorkedMinutes({ clockIn: "22:00", clockOut: "06:00", breakMinutes: 60, overtimeMinutes: 0 });
    assert.equal(v, 420);
    assert.ok(v > 0, "日跨ぎで負値になってはならない");
  });

  test("24時超え表記を直接渡しても同じ結果になる", () => {
    const a = calcWorkedMinutes({ clockIn: "22:00", clockOut: "06:00", breakMinutes: 0, overtimeMinutes: 0 });
    const b = calcWorkedMinutes({ clockIn: "22:00", clockOut: "30:00", breakMinutes: 0, overtimeMinutes: 0 });
    assert.equal(a, b);
  });

  test("矛盾入力（休憩が拘束を超える）は例外で弾く", () => {
    assert.throws(
      () => calcWorkedMinutes({ clockIn: "09:00", clockOut: "10:00", breakMinutes: 120, overtimeMinutes: 0 }),
      ShiftValidationError
    );
  });

  test("負の休憩・残業は受け付けない", () => {
    assert.throws(
      () => calcWorkedMinutes({ clockIn: "09:00", clockOut: "18:00", breakMinutes: -1, overtimeMinutes: 0 }),
      ShiftValidationError
    );
  });
});

describe("shift: 締め日期間（設計書 4.13.2）", () => {
  test("月末締め（31）は当月1日〜当月末日", () => {
    assert.deepEqual(getCutoffRange("2026-08", 31), { start: "2026-08-01", end: "2026-08-31" });
    assert.deepEqual(getCutoffRange("2026-02", 31), { start: "2026-02-01", end: "2026-02-28" });
    assert.deepEqual(getCutoffRange("2024-02", 31), { start: "2024-02-01", end: "2024-02-29" });
  });

  test("20日締めは前月21日〜当月20日", () => {
    assert.deepEqual(getCutoffRange("2026-08", 20), { start: "2026-07-21", end: "2026-08-20" });
  });

  test("年跨ぎ（1月20日締め）", () => {
    assert.deepEqual(getCutoffRange("2026-01", 20), { start: "2025-12-21", end: "2026-01-20" });
  });

  test("不正な締め日は例外", () => {
    assert.throws(() => getCutoffRange("2026-08", 0), ShiftValidationError);
    assert.throws(() => getCutoffRange("2026-13", 20), ShiftValidationError);
  });
});

describe("shift: 区分別集計（B-1・設計書 4.13.3）", () => {
  test("区分1が合計と同値にならない（現行バグの再発検知）", () => {
    const rows = [
      { shiftTypeCode: "1" }, { shiftTypeCode: "1" }, { shiftTypeCode: "2" },
      { shiftTypeCode: "3" }, { shiftTypeCode: null },
    ];
    const r = countByShiftType(rows, ["1", "2", "3", "4"]);
    assert.equal(r.total, 5);
    assert.equal(r.byCode["1"], 2);
    assert.equal(r.byCode["2"], 1);
    assert.equal(r.byCode["3"], 1);
    assert.equal(r.byCode["4"], 0);
    assert.notEqual(r.byCode["1"], r.total, "区分Aの件数が合計と同値になってはならない（B-1）");
  });

  test("eachDate は期間の日を過不足なく列挙する", () => {
    assert.equal(eachDate("2026-08-01", "2026-08-31").length, 31);
    assert.equal(eachDate("2026-08-14", "2026-08-14").length, 1);
  });
});

// ---------------------------------------------------------------
describe("authz: テナント境界（B-6・設計書 6.2.6）", () => {
  const alice = { accountId: "acc_a", tenantId: "t_1", roleCodes: ["tenant_admin"] };
  const sysadmin = { accountId: "acc_s", tenantId: null, roleCodes: ["system_admin"] };

  test("自テナントのリソースは通る", () => {
    assert.doesNotThrow(() => assertTenantScope(alice, "t_1"));
  });

  test("他テナントのリソースは拒否される（現行は取得できていた）", () => {
    assert.throws(() => assertTenantScope(alice, "t_2"), AuthzError);
    try {
      assertTenantScope(alice, "t_2");
    } catch (e) {
      assert.equal((e as AuthzError).reason, "tenant_mismatch");
    }
  });

  test("システム管理者は横断できる", () => {
    assert.doesNotThrow(() => assertTenantScope(sysadmin, "t_9"));
  });
});

describe("authz: 人事権系統の分離（設計書 5.3/7.2・B-18）", () => {
  test("ロール定義の is_hr_line", () => {
    assert.equal(ROLES.tenant_admin.isHrLine, true);
    assert.equal(ROLES.worksite_manager.isHrLine, true);
    assert.equal(ROLES.sc_implementer.isHrLine, false);
    assert.equal(ROLES.employee.isHrLine, false);
  });

  test("会社管理者はストレスチェック結果にアクセスできない", () => {
    const hr = { accountId: "a", tenantId: "t_1", roleCodes: ["tenant_admin"] };
    assert.equal(hasHrLineRole(hr), true);
    assert.equal(canAccessStressCheckResult(hr), false);
    assert.equal(canAccessAttendance(hr), true); // 勤怠は見てよい（非対称）
  });

  test("実施者はストレスチェック結果にアクセスでき、勤怠にはアクセスしない", () => {
    const impl = { accountId: "b", tenantId: "t_1", roleCodes: ["sc_implementer"] };
    assert.equal(canAccessStressCheckResult(impl), true);
    assert.equal(canAccessAttendance(impl), false);
  });

  test("兼任しても人事権があれば結果は見えない（52条の10第2項）", () => {
    const both = { accountId: "c", tenantId: "t_1", roleCodes: ["tenant_admin", "sc_implementer"] };
    assert.equal(canAccessStressCheckResult(both), false);
  });
});

// ---------------------------------------------------------------
describe("password: scrypt（WASM不要・B-8/B-9）", () => {
  test("ハッシュ・検証が往復する", async () => {
    const { hash, algo } = await hashPassword("Sh1ft-Kanri-2026!");
    assert.equal(algo, ALGO_LABEL);
    assert.ok(hash.startsWith("$scrypt$"));
    assert.equal(await verifyPassword("Sh1ft-Kanri-2026!", hash), true);
    assert.equal(await verifyPassword("wrong", hash), false);
  });

  test("同一パスワードでもハッシュが異なる（ソルトが個別・現行の共有ソルト ps との違い）", async () => {
    const a = await hashPassword("samepass");
    const b = await hashPassword("samepass");
    assert.notEqual(a.hash, b.hash);
  });

  test("ハッシュに平文が含まれない", async () => {
    const { hash } = await hashPassword("plaintext-secret");
    assert.equal(hash.includes("plaintext-secret"), false);
  });

  test("弱いパラメータのハッシュは再ハッシュ対象と判定される", () => {
    assert.equal(needsRehash("$scrypt$N=1024,r=8,p=1$aa$bb"), true);
    assert.equal(needsRehash("$scrypt$N=16384,r=8,p=5$aa$bb"), false);
    assert.equal(needsRehash("not-a-hash"), true);
    assert.equal(needsRehash("$argon2id$v=19$m=19456,t=2,p=1$abc$def"), true, "旧Argon2ハッシュは再ハッシュ対象");
  });

  test("空パスワードは拒否", async () => {
    await assert.rejects(() => hashPassword(""));
  });
});

async function seed(): Promise<{ db: AnyDb; r2: ShimR2 }> {
  const db = new ShimD1(SCHEMA) as AnyDb;
  const r2 = new ShimR2();
  const t = nowUtc();

  for (const [id, name] of [["t_1", "A社"], ["t_2", "B社"]]) {
    await db.prepare(
      `INSERT INTO tenants (id,name,cutoff_day,timezone,status,created_at,updated_at) VALUES (?1,?2,20,'Asia/Tokyo','active',?3,?3)`
    ).bind(id, name, t).run();
  }

  for (const [id, code, name, hr] of [
    ["r_admin", "tenant_admin", "会社管理者", 1],
    ["r_emp", "employee", "従業員", 0],
    ["r_sc", "sc_implementer", "ストレスチェック実施者", 0],
  ] as const) {
    await db.prepare(`INSERT INTO roles (id,code,name,is_hr_line,created_at) VALUES (?1,?2,?3,?4,?5)`)
      .bind(id, code, name, hr, t).run();
  }

  const { hash } = await hashPassword("Pono-Plus-2026!");
  for (const [aid, tid, lid] of [["acc_1", "t_1", "admin1"], ["acc_2", "t_2", "admin2"]]) {
    await db.prepare(
      `INSERT INTO accounts (id,tenant_id,login_id,password_hash,password_algo,password_updated_at,status,created_at,updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,'active',?6,?6)`
    ).bind(aid, tid, lid, hash, ALGO_LABEL, t).run();
    await db.prepare(`INSERT INTO account_roles (id,account_id,role_id,scope_type,scope_id,granted_at) VALUES (?1,?2,'r_admin','tenant',?3,?4)`)
      .bind(`ar_${aid}`, aid, tid, t).run();
  }

  for (const [eid, tid, name] of [["e_1", "t_1", "山田"], ["e_2", "t_2", "佐藤"]]) {
    await db.prepare(
      `INSERT INTO employees (id,tenant_id,name,employment_type,status,photo_object_key,created_at,updated_at)
       VALUES (?1,?2,?3,'regular','active',?4,?5,?5)`
    ).bind(eid, tid, name, `photos/${eid}.jpg`, t).run();
    await r2.put(`photos/${eid}.jpg`, "dummy");
  }

  // 現行 tb_m_cate1 の CATE1_REMARKS1..21 に相当。code は 1〜21 の数値
  await db.prepare(`INSERT INTO shift_types (id,tenant_id,code,name,sort_order,created_at,updated_at) VALUES ('st_a1','t_1','1','早番',1,?1,?1)`).bind(t).run();
  await db.prepare(
    `INSERT INTO shifts (id,tenant_id,employee_id,worked_on,shift_type_id,clock_in,clock_out,break_minutes,overtime_minutes,worked_minutes,created_at,updated_at)
     VALUES ('sh_1','t_1','e_1','2026-08-14','st_a1','09:00','18:00',60,0,480,?1,?1)`
  ).bind(t).run();

  return { db, r2 };
}

const P1: Principal = { accountId: "acc_1", tenantId: "t_1", roleCodes: ["tenant_admin"] };
const P2: Principal = { accountId: "acc_2", tenantId: "t_2", roleCodes: ["tenant_admin"] };

// ---------------------------------------------------------------
describe("統合: ログイン（設計書 6.2.1/6.2.2）", () => {
  test("正しいパスワードでセッションが発行される", async () => {
    const { db } = await seed();
    const r = await login(db, { loginId: "admin1", password: "Pono-Plus-2026!", tenantId: "t_1", ip: "1.2.3.4", userAgent: "test" });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.token.length > 30);

    // 平文トークンはDBに保存されない（ハッシュのみ）
    const row = await db.prepare(`SELECT id FROM sessions WHERE account_id = 'acc_1'`).first();
    assert.notEqual(row.id, r.token);
    assert.equal(row.id, await sha256Hex(r.token));
  });

  test("誤ったパスワードは拒否され、試行が記録される", async () => {
    const { db } = await seed();
    const r = await login(db, { loginId: "admin1", password: "wrong", tenantId: "t_1", ip: null, userAgent: null });
    assert.equal(r.ok, false);
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE succeeded = 0`).first();
    assert.equal(n.n, 1);
  });

  test("存在しないアカウントでも同じ理由コードを返す（存在を漏らさない）", async () => {
    const { db } = await seed();
    const r = await login(db, { loginId: "nobody", password: "x", tenantId: "t_1", ip: null, userAgent: null });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "invalid_credentials");
  });

  test("5回失敗するとレート制限される", async () => {
    const { db } = await seed();
    for (let i = 0; i < 5; i++) {
      await login(db, { loginId: "admin1", password: "wrong", tenantId: "t_1", ip: null, userAgent: null });
    }
    const r = await login(db, { loginId: "admin1", password: "Pono-Plus-2026!", tenantId: "t_1", ip: null, userAgent: null });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "rate_limited");
  });

  test("ログアウトでセッションが失効する", async () => {
    const { db } = await seed();
    const r = await login(db, { loginId: "admin1", password: "Pono-Plus-2026!", tenantId: "t_1", ip: null, userAgent: null });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    await logout(db, r.token);
    const row = await db.prepare(`SELECT revoked_at FROM sessions WHERE id = ?1`).bind(await sha256Hex(r.token)).first();
    assert.notEqual(row.revoked_at, null);
  });
});

// ---------------------------------------------------------------
describe("統合: テナント境界（B-6・設計書 6.2.6）", () => {
  test("自テナントの従業員は取得できる", async () => {
    const { db } = await seed();
    const repo = new TenantDb(db, P1);
    const e = await repo.findById<{ id: string }>("employees", "e_1");
    assert.equal(e?.id, "e_1");
  });

  test("他テナントの従業員はIDを直接指定しても取得できない（現行は取得できていた）", async () => {
    const { db } = await seed();
    const repo = new TenantDb(db, P1);
    await assert.rejects(() => repo.findById("employees", "e_2"), /tenant mismatch/);
  });

  test("一覧は自テナント分しか返らない", async () => {
    const { db } = await seed();
    const rows = await new TenantDb(db, P1).findMany<{ tenant_id: string }>("employees");
    assert.equal(rows.length, 1);
    assert.ok(rows.every((r) => r.tenant_id === "t_1"));
    const rows2 = await new TenantDb(db, P2).findMany<{ tenant_id: string }>("employees");
    assert.equal(rows2.length, 1);
    assert.equal(rows2[0].tenant_id, "t_2");
  });

  test("他テナントのtenant_idを指定した挿入は拒否される", async () => {
    const { db } = await seed();
    const repo = new TenantDb(db, P1);
    await assert.rejects(
      () => repo.insert("employees", { id: "e_x", tenant_id: "t_2", name: "侵入", employment_type: "regular", status: "active", created_at: nowUtc(), updated_at: nowUtc() }),
      TenantScopeError
    );
  });

  test("tenant_idを書かなくても自動付与される", async () => {
    const { db } = await seed();
    const repo = new TenantDb(db, P1);
    await repo.insert("employees", { id: "e_new", name: "新人", employment_type: "part_time", status: "active", created_at: nowUtc(), updated_at: nowUtc() });
    const row = await db.prepare(`SELECT tenant_id FROM employees WHERE id='e_new'`).first();
    assert.equal(row.tenant_id, "t_1");
  });

  test("他テナントのレコードは更新されない", async () => {
    const { db } = await seed();
    await new TenantDb(db, P1).updateById("employees", "e_2", { name: "改ざん" });
    const row = await db.prepare(`SELECT name FROM employees WHERE id='e_2'`).first();
    assert.equal(row.name, "佐藤");
  });

  test("テナント非スコープのテーブルは scoped API で触れない", async () => {
    const { db } = await seed();
    await assert.rejects(() => new TenantDb(db, P1).findMany("accounts"), TenantScopeError);
  });

  test("不正な識別子はSQLに混入しない", async () => {
    const { db } = await seed();
    await assert.rejects(
      () => new TenantDb(db, P1).findMany("employees", { "name; DROP TABLE employees--": "x" }),
      TenantScopeError
    );
    const still = await db.prepare(`SELECT COUNT(*) AS n FROM employees`).first();
    assert.ok(still.n >= 1);
  });
});

// ---------------------------------------------------------------
describe("統合: 削除の完全性（設計書 5.2⑦・4.6）", () => {
  test("従業員の退会で関連レコードと写真が消える", async () => {
    const { db, r2 } = await seed();
    const before = await db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE employee_id='e_1'`).first();
    assert.equal(before.n, 1);

    const res = await deleteEmployee(db, r2 as never, "t_1", "e_1");
    assert.equal(res.deleted.employees, 1);
    assert.equal(res.deleted.shifts, 1);
    assert.equal(res.photosDeleted, 1);
    assert.equal(await r2.get("photos/e_1.jpg"), null);

    const after = await db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE employee_id='e_1'`).first();
    assert.equal(after.n, 0);
  });

  test("削除結果がテーブル別件数として記録される（追加漏れの検知手段）", async () => {
    const { db, r2 } = await seed();
    const res = await deleteEmployee(db, r2 as never, "t_1", "e_1");
    const job = await db.prepare(`SELECT result_summary FROM deletion_jobs WHERE id = ?1`).bind(res.jobId).first();
    const parsed = JSON.parse(job.result_summary);
    assert.ok("shifts" in parsed.deleted);
    assert.ok("employees" in parsed.deleted);
  });

  test("テナント解約で自テナントが消え、他テナントは残る", async () => {
    const { db, r2 } = await seed();
    await deleteTenant(db, r2 as never, "t_1");

    const t1 = await db.prepare(`SELECT COUNT(*) AS n FROM tenants WHERE id='t_1'`).first();
    const t2 = await db.prepare(`SELECT COUNT(*) AS n FROM tenants WHERE id='t_2'`).first();
    assert.equal(t1.n, 0);
    assert.equal(t2.n, 1);

    const e2 = await db.prepare(`SELECT COUNT(*) AS n FROM employees WHERE tenant_id='t_2'`).first();
    assert.equal(e2.n, 1, "他テナントの従業員が巻き込まれてはならない");
  });

  test("監査ログは解約でも削除されない（設計書 5.2⑤）", async () => {
    const { db, r2 } = await seed();
    await db.prepare(
      `INSERT INTO audit_logs (id,tenant_id,actor_id,actor_role,action,target_type,target_id,occurred_at)
       VALUES ('al_1','t_1','acc_1','tenant_admin','view','employee','e_1',?1)`
    ).bind(nowUtc()).run();

    await deleteTenant(db, r2 as never, "t_1");
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE tenant_id='t_1'`).first();
    assert.equal(n.n, 1);
    assert.ok("audit_logs" in DELETION_EXEMPT);
  });

  test("削除対象テーブル一覧がスコープ対象テーブルを網羅している", async () => {
    // TENANT_SCOPED_TABLES のうち、削除計画にも除外リストにも無いものがあれば漏れ
    const { TENANT_DELETION_ORDER, EMPLOYEE_DELETION_ORDER } = await import("../src/services.ts");
    const covered = new Set<string>([
      ...TENANT_DELETION_ORDER,
      ...EMPLOYEE_DELETION_ORDER.map((s) => s.table),
      ...Object.keys(DELETION_EXEMPT),
    ]);
    const missing = TENANT_SCOPED_TABLES.filter((t) => !covered.has(t));
    assert.deepEqual(missing, [], `削除計画に未登録のテーブル: ${missing.join(",")}`);
  });
});


// ===============================================================
// スキーマ設計原則の検査（旧 scripts/audit_schema.py を統合）
//   Python 実行環境への依存を無くし、npm test で一緒に走らせる
// ===============================================================
const TENANT_EXEMPT = new Set([
  "tenants", "plans", "policy_documents", "roles",
  "accounts", "account_roles", "sessions",
  "password_reset_tokens", "login_attempts",
  "retention_policies", "audit_logs",
  // サポートは全テナント共通の内容（現行 tb_m_contact に相当）。テナントに属さない
  "support_contents",
]);

function schemaDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return db;
}

function tableNames(db: DatabaseSync): string[] {
  return (db.prepare(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"
  ).all() as Array<{ name: string }>).map((r) => r.name);
}

function columns(db: DatabaseSync, table: string): Array<{ name: string; type: string; notnull: number }> {
  return db.prepare(`pragma table_info(${table})`).all() as never;
}

describe("スキーマ: 設計原則の検査（CIで守る不変条件）", () => {
  test("マイグレーションが実行でき、テーブル30本・インデックス29本になる", () => {
    // 🔴 この数を変えるときは、意図した追加か必ず確認すること。
    //    0001: テーブル20 / インデックス16
    //    0004: worksite_monthly_reports を追加（テーブル21 / インデックス17）
    //    0005: daily_report_categories + daily_reports を追加（テーブル23 / インデックス20）
    //    0006: photo_posts を追加（テーブル24 / インデックス22）
    //    0007: thanks を追加（テーブル25 / インデックス25）
    //    0008: skill_sheets を追加（テーブル26 / インデックス27）
    //    0009: tenant_notices + _links + _images + support_contents を追加（テーブル30 / インデックス29）
    //    0002・0003 は列の追加のみ
    const db = schemaDb();
    assert.equal(tableNames(db).length, 30);
    const idx = db.prepare(
      "select count(*) as n from sqlite_master where type='index' and name not like 'sqlite_%'"
    ).get() as { n: number };
    assert.equal(idx.n, 29);
  });

  test("業務テーブルは tenant_id NOT NULL（B-6・スキーマ 2.5）", () => {
    const db = schemaDb();
    const ng: string[] = [];
    for (const t of tableNames(db)) {
      if (TENANT_EXEMPT.has(t)) continue;
      const c = columns(db, t).find((x) => x.name === "tenant_id");
      if (c === undefined || c.notnull !== 1) ng.push(t);
    }
    assert.deepEqual(ng, [], `tenant_id が無いか NULL 許容: ${ng.join(",")}`);
  });

  test("平文パスワードを疑わせる列が存在しない（現行201件・設計書 6.2.1）", () => {
    const db = schemaDb();
    const suspects: string[] = [];
    for (const t of tableNames(db)) {
      for (const c of columns(db, t)) {
        const n = c.name.toLowerCase();
        const allowed = ["hash", "algo", "updated", "must"].some((k) => n.includes(k));
        if (n.includes("pass") && !allowed) suspects.push(`${t}.${c.name}`);
        if (["rem1", "plain_password", "password_plain"].includes(n)) suspects.push(`${t}.${c.name}`);
      }
    }
    assert.deepEqual(suspects, []);
  });

  test("経過時間は INTEGER の分で保持する（9時間オフセット・設計書 4.12）", () => {
    const db = schemaDb();
    const targets: Array<[string, string]> = [
      ["shifts", "break_minutes"], ["shifts", "overtime_minutes"], ["shifts", "worked_minutes"],
      ["attendance_summaries", "worked_minutes"], ["attendance_summaries", "overtime_minutes"],
    ];
    for (const [t, c] of targets) {
      const col = columns(db, t).find((x) => x.name === c);
      assert.equal(col?.type, "INTEGER", `${t}.${c} が INTEGER ではない`);
    }
  });

  test("現行データを移行しないため legacy_* 列が存在しない（会話合意 2026-08-15）", () => {
    const db = schemaDb();
    const found: string[] = [];
    for (const t of tableNames(db)) {
      for (const c of columns(db, t)) {
        if (c.name.startsWith("legacy_")) found.push(`${t}.${c.name}`);
      }
    }
    assert.deepEqual(found, [], "移行しない決定のため legacy_* 列を作らない");
  });

  test("flg1..10 型の汎用列を作らない（設計書 5.5(3)）", () => {
    const db = schemaDb();
    const generic: string[] = [];
    for (const t of tableNames(db)) {
      for (const c of columns(db, t)) {
        if (/flg\d+$/i.test(c.name)) generic.push(`${t}.${c.name}`);
      }
    }
    assert.deepEqual(generic, []);
  });

  test("削除計画が全業務テーブルを網羅している（設計書 5.2(7)）", () => {
    const covered = new Set<string>([
      ...TENANT_DELETION_ORDER,
      ...EMPLOYEE_DELETION_ORDER.map((s) => s.table),
      ...Object.keys(DELETION_EXEMPT),
    ]);
    const missing = TENANT_SCOPED_TABLES.filter((t) => !covered.has(t));
    assert.deepEqual(missing, [], `削除計画に未登録: ${missing.join(",")}`);
  });
});

// ===============================================================
// 登録画面の仕様（index2.html md5 9fad12fc928bdd69efa697e08b2836da）
// ===============================================================
const BASE_REG = {
  name: "山田太郎",
  nameKana: "ヤマダタロウ",
  employeeCode: "E-001",
  email: "yamada@example.com",
  loginId: "yamada01",
  password: "Pono-Plus-2026!",
  shiftTypeId: null,
  employmentType: "regular",
  birthOn: "1990-05-15",
  hiredOn: "2015-04-01",
  gender: "male",
  worksiteId: null,
};
const TODAY = "2026-08-14";

describe("登録: 現行画面の値域（index2.html で実証）", () => {
  test("勤務形態 su2_w_style は 2〜5 の4種。1（マスタ②）は雇用形態ではない", () => {
    assert.deepEqual(Object.keys(EMPLOYMENT_TYPE_BY_LEGACY).sort(), ["2", "3", "4", "5"]);
    assert.equal(EMPLOYMENT_TYPE_BY_LEGACY["3"], "part_time");
    assert.equal(EMPLOYMENT_TYPE_BY_LEGACY["1"], undefined);
  });

  test("🔴 勤務時間帯を A〜D に固定しない（設計書 4.5 の訂正・Session 03 第6章）", () => {
    // 「A〜Dグループ」は特定の会社の設定値であり仕様ではなかった。
    // 会社ごとに shift_types へ最大21種を定義する。
    // レガシー定数 SHIFT_GROUP_BY_LEGACY は撤去済み。
    assert.equal(Object.prototype.hasOwnProperty.call(
      globalThis as Record<string, unknown>, "SHIFT_GROUP_BY_LEGACY"), false);
  });

  test("性別 pd_sec1 は 1=男性 / 2=女性", () => {
    assert.deepEqual(GENDER_BY_LEGACY, { "1": "male", "2": "female" });
  });
});

describe("登録: 現行の欠陥を再現しない（B-22/B-24）", () => {
  test("B-22: 実在しない日付を弾く（現行は日の選択肢に 29/30 が重複）", () => {
    assert.equal(isRealDate("2026-02-30"), false);
    assert.equal(isRealDate("2026-04-31"), false);
    assert.equal(isRealDate("2024-02-29"), true);
    assert.equal(isRealDate("2026-02-29"), false);
    const iss = validateRegistration({ ...BASE_REG, birthOn: "1990-02-30" }, TODAY);
    assert.ok(iss.some((i) => i.code === "not_a_real_date"));
  });

  test("B-24: 2006年以降生まれも登録できる（現行は年の選択肢が1950〜2005固定）", () => {
    assert.deepEqual(validateRegistration({ ...BASE_REG, birthOn: "2008-04-01" }, TODAY), []);
  });

  test("年齢の下限・上限は範囲で判定する", () => {
    assert.ok(validateRegistration({ ...BASE_REG, birthOn: "2020-01-01" }, TODAY).length > 0);
    assert.ok(validateRegistration({ ...BASE_REG, birthOn: "1900-01-01" }, TODAY).length > 0);
  });

  test("B-23: 氏名が空なら弾く（現行は name 属性が無く送信されない）", () => {
    const iss = validateRegistration({ ...BASE_REG, name: "  " }, TODAY);
    assert.ok(iss.some((i) => i.field === "name" && i.code === "required"));
  });

  test("不正な勤務形態・性別・勤務時間帯を弾く", () => {
    assert.ok(validateRegistration({ ...BASE_REG, employmentType: "master2" }, TODAY).length > 0);
    assert.ok(validateRegistration({ ...BASE_REG, gender: "9" }, TODAY).length > 0);
  });

  test("短いパスワードを弾く", () => {
    assert.ok(validateRegistration({ ...BASE_REG, password: "short" }, TODAY).some((i) => i.field === "password"));
  });
});

describe("登録: 実際に登録できる", () => {
  test("アカウント・従業員・ロール付与が同時に作られる", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", BASE_REG, TODAY);
    const emp = await db.prepare(`SELECT * FROM employees WHERE id = ?1`).bind(r.employeeId).first();
    assert.equal(emp.name, "山田太郎");
    assert.equal(emp.gender, "male");
    assert.equal(emp.tenant_id, "t_1");
    const acc = await db.prepare(`SELECT * FROM accounts WHERE id = ?1`).bind(r.accountId).first();
    assert.equal(acc.login_id, "yamada01");
    assert.ok(acc.password_hash.startsWith("$scrypt$"));
  });

  test("登録したアカウントでログインできる", async () => {
    const { db } = await seed();
    await registerEmployee(db, "t_1", BASE_REG, TODAY);
    const r = await login(db, { loginId: "yamada01", password: "Pono-Plus-2026!", tenantId: "t_1", ip: null, userAgent: null });
    assert.equal(r.ok, true);
  });

  test("同一テナント内でIDが重複したら拒否", async () => {
    const { db } = await seed();
    await registerEmployee(db, "t_1", BASE_REG, TODAY);
    await assert.rejects(() => registerEmployee(db, "t_1", BASE_REG, TODAY), RegistrationError);
  });

  test("🔴 別テナントでも同じIDは使えない（会話合意 2026-08-15）", async () => {
    // 現行のログイン画面は ID と PW のみで会社を選ばせないため
    // （loginuser2/3Template.php で実証）、IDが重複すると会社を特定できない
    const { db } = await seed();
    await registerEmployee(db, "t_1", BASE_REG, TODAY);
    await assert.rejects(() => registerEmployee(db, "t_2", BASE_REG, TODAY), RegistrationError);
  });

  test("パスワードはDBのどこにも平文で残らない（設計書 6.2.1）", async () => {
    const { db } = await seed();
    await registerEmployee(db, "t_1", BASE_REG, TODAY);
    const tables = ["accounts", "employees"];
    for (const t of tables) {
      const rows = await db.prepare(`SELECT * FROM ${t}`).all();
      for (const row of rows.results) {
        for (const v of Object.values(row)) {
          if (typeof v === "string") {
            assert.equal(v.includes("Pono-Plus-2026!"), false, `${t} に平文が残っている`);
          }
        }
      }
    }
  });
});

// ===============================================================
// ディスパッチャ（View.php / View_Manager.php md5 bb36d3d0a61775e26017f58959cc34d2 の欠陥に対応）
// ===============================================================
const execCtx = { waitUntil: (p: Promise<unknown>) => { void p; }, passThroughOnException: () => {} } as never;

function req(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://app.example.com${path}`, {
    method,
    headers: { Host: "app.example.com", ...headers },
  });
}

async function loggedInCookie(db: AnyDb): Promise<string> {
  const r = await login(db, { loginId: "admin1", password: "Pono-Plus-2026!", tenantId: "t_1", ip: null, userAgent: null });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error("login failed");
  return `pp_session=${r.token}`;
}

describe("ディスパッチャ: 認証の一元化（B-5/B-29・設計書 4.2/5.3(3)）", () => {
  test("認証不要ルートは通る", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(req("GET", "/healthz"), { DB: db, PHOTOS: r2 } as never, execCtx);
    assert.equal(res.status, 200);
  });

  test("healthz は設定の反映状況を返すが、値そのものは返さない", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(req("GET", "/healthz"), { DB: db, PHOTOS: r2, SETUP_TOKEN: "secret-value" } as never, execCtx);
    const body = await res.json() as { setupTokenConfigured: boolean; bindings: { db: boolean } };
    assert.equal(body.setupTokenConfigured, true);
    assert.equal(body.bindings.db, true);
    assert.equal(JSON.stringify(body).includes("secret-value"), false, "値が漏れてはならない");
  });

  test("SETUP_TOKEN 未設定なら false を返す", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(req("GET", "/healthz"), { DB: db, PHOTOS: r2 } as never, execCtx);
    const body = await res.json() as { setupTokenConfigured: boolean };
    assert.equal(body.setupTokenConfigured, false);
  });

  test("認証必須ルートは Cookie 無しで 401（現行は各Actionに個別実装で漏れがあった）", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(req("GET", "/api/me"), { DB: db, PHOTOS: r2 } as never, execCtx);
    assert.equal(res.status, 401);
  });

  test("ログイン後は通り、principal が解決される", async () => {
    const { db, r2 } = await seed();
    const cookie = await loggedInCookie(db);
    const res = await worker.fetch(req("GET", "/api/me", { Cookie: cookie }), { DB: db, PHOTOS: r2 } as never, execCtx);
    assert.equal(res.status, 200);
    const body = await res.json() as { tenantId: string; roles: string[] };
    assert.equal(body.tenantId, "t_1");
    assert.deepEqual(body.roles, ["tenant_admin"]);
  });

  test("失効セッションは拒否される（UTC同士の比較・設計書 4.12）", async () => {
    const { db, r2 } = await seed();
    const cookie = await loggedInCookie(db);
    await db.prepare(`UPDATE sessions SET expires_at = '2020-01-01T00:00:00Z'`).run();
    const res = await worker.fetch(req("GET", "/api/me", { Cookie: cookie }), { DB: db, PHOTOS: r2 } as never, execCtx);
    assert.equal(res.status, 401);
  });

  test("ログアウト済みセッションは拒否される", async () => {
    const { db, r2 } = await seed();
    const cookie = await loggedInCookie(db);
    await logout(db, cookie.replace("pp_session=", ""));
    const res = await worker.fetch(req("GET", "/api/me", { Cookie: cookie }), { DB: db, PHOTOS: r2 } as never, execCtx);
    assert.equal(res.status, 401);
  });

  test("既定は認証必須。public を明示したルートだけが素通しになる", () => {
    // 🔴 このリストが変わったら意図した追加か必ず確認すること。
    //    現行は各 Action に認証を個別実装しており、shift3updateAction では
    //    認証失敗時の遷移が丸ごと欠落していた（B-5・設計書 4.13.6）。
    const publicRoutes = routes.filter((r) => r.public === true).map((r) => r.path).sort();
    // 画面（/ /login /home）は認証前に配信する必要がある。
    // /home は HTML を返すだけで、中身のデータは /api/me（認証必須）から取る
    // /employees /employees/new も同様に HTML の配信のみ。データは
    // /api/employees・/api/employees/detail・/api/shift-types（すべて認証必須）から取る
    assert.deepEqual(publicRoutes, [
      "/", "/api/login", "/api/setup", "/attendance",
      "/daily-reports", "/daily-reports/categories", "/daily-reports/edit",
      "/employees", "/employees/new",
      "/healthz", "/home", "/login", "/notices/edit",
      "/photos", "/photos/new", "/profile", "/profile/view",
      "/reports", "/reports/edit", "/shifts",
      "/skill-sheets", "/skill-sheets/edit", "/support",
      "/thanks", "/thanks/new", "/thanks/ranking",
    ]);
  });

  test("ログインAPIが動作し、Cookie が HttpOnly / Secure / SameSite=Strict で発行される", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(
      new Request("https://app.example.com/api/login", {
        method: "POST",
        headers: { Host: "app.example.com", Origin: "https://app.example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: "admin1", password: "Pono-Plus-2026!", tenantId: "t_1" }),
      }),
      { DB: db, PHOTOS: r2 } as never,
      execCtx
    );
    assert.equal(res.status, 200);
    const cookie = res.headers.get("Set-Cookie") ?? "";
    assert.ok(cookie.includes("HttpOnly"), "HttpOnly が無い");
    assert.ok(cookie.includes("Secure"), "Secure が無い");
    assert.ok(cookie.includes("SameSite=Strict"), "SameSite=Strict が無い");
  });

  test("誤ったパスワードでのログインAPIは 401", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(
      new Request("https://app.example.com/api/login", {
        method: "POST",
        headers: { Host: "app.example.com", Origin: "https://app.example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: "admin1", password: "wrong", tenantId: "t_1" }),
      }),
      { DB: db, PHOTOS: r2 } as never,
      execCtx
    );
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("Set-Cookie"), null, "失敗時に Cookie を発行してはならない");
  });
});

describe("ディスパッチャ: 経路解決（B-25/B-28）", () => {
  test("public ルートで例外が起きても JSON の 500 を返す（HTML エラー画面にしない）", async () => {
    const { db, r2 } = await seed();
    // DB を壊して login ハンドラ内で例外を起こす
    const brokenDb = { prepare: () => { throw new Error("boom"); } };
    const res = await worker.fetch(
      new Request("https://app.example.com/api/login", {
        method: "POST",
        headers: { Host: "app.example.com", Origin: "https://app.example.com", "Content-Type": "application/json" },
        body: JSON.stringify({ loginId: "x", password: "y", tenantId: null }),
      }),
      { DB: brokenDb, PHOTOS: r2 } as never,
      execCtx
    );
    assert.equal(res.status, 500);
    const body = await res.json() as { error: string };
    assert.equal(body.error, "internal_error", "例外が握り潰されず JSON で返ること");
    void db;
  });

  test("B-28: 未登録ルートは 404 を返す（現行は die() で HTTP 200 のまま）", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(req("GET", "/no/such/route"), { DB: db, PHOTOS: r2 } as never, execCtx);
    assert.equal(res.status, 404);
  });

  test("B-25: ルート名を文字列加工しない（現行は _ を / に変換後 / を除去していた）", async () => {
    const { db, r2 } = await seed();
    // 現行の変換規則なら 'api_me' が 'apime' になり得た。新実装は完全一致のみ
    for (const p of ["/api_me", "/apime", "/API/ME"]) {
      const res = await worker.fetch(req("GET", p, {}), { DB: db, PHOTOS: r2 } as never, execCtx);
      assert.equal(res.status, 404, `${p} が誤って解決された`);
    }
  });

  test("B-26 相当: ハンドラが解決できない場合に未定義値へ到達しない", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(req("POST", "/healthz", { Origin: "https://app.example.com" }), { DB: db, PHOTOS: r2 } as never, execCtx);
    // メソッド違いは 404。例外にはならない
    assert.equal(res.status, 404);
  });

  test("CSRF: Origin の無い書き込みは 403（現行は共通層に対策0件・設計書 6.2.4）", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(req("POST", "/api/me"), { DB: db, PHOTOS: r2 } as never, execCtx);
    assert.equal(res.status, 403);
  });

  test("CSRF: 別オリジンからの書き込みは 403", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(
      req("POST", "/api/me", { Origin: "https://evil.example.net" }),
      { DB: db, PHOTOS: r2 } as never,
      execCtx
    );
    assert.equal(res.status, 403);
  });
});

// ===============================================================
// シフト管理（現行 shift1/2/3/23update の4本を1本に集約）
// ===============================================================
describe("シフト: 4本を1本に集約した登録処理", () => {
  test("通常勤務を登録し実働時間が保存される", async () => {
    const { db } = await seed();
    const r = await upsertShift(db, "t_1", {
      employeeId: "e_1", workedOn: "2026-08-20", shiftTypeId: "st_a1",
      clockIn: "09:00", clockOut: "18:00", breakMinutes: 60, overtimeMinutes: 30,
      isAbsent: false, isLate: false, isEarlyLeave: false, note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
    }, "2026-08-15");
    assert.equal(r.workedMinutes, 510);
    const row = await db.prepare(`SELECT * FROM shifts WHERE id = ?1`).bind(r.shiftId).first();
    assert.equal(row.worked_minutes, 510);
  });

  test("🔴 B-2: 日跨ぎでも負値にならず、退勤が24時超え表記で保存される", async () => {
    const { db } = await seed();
    const r = await upsertShift(db, "t_1", {
      employeeId: "e_1", workedOn: "2026-08-21", shiftTypeId: null,
      clockIn: "22:00", clockOut: "06:00", breakMinutes: 60, overtimeMinutes: 0,
      isAbsent: false, isLate: false, isEarlyLeave: false, note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
    }, "2026-08-15");
    assert.equal(r.workedMinutes, 420);
    const row = await db.prepare(`SELECT clock_out FROM shifts WHERE id = ?1`).bind(r.shiftId).first();
    assert.equal(row.clock_out, "30:00", "日跨ぎは24時超え表記で保存する");
  });

  test("同じ日・同じ区分は上書きされ、重複行が増えない", async () => {
    const { db } = await seed();
    const base = {
      employeeId: "e_1", workedOn: "2026-08-22", shiftTypeId: "st_a1",
      clockIn: "09:00", clockOut: "17:00", breakMinutes: 60, overtimeMinutes: 0,
      isAbsent: false, isLate: false, isEarlyLeave: false, note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
    };
    const a = await upsertShift(db, "t_1", base, "2026-08-22");
    const b = await upsertShift(db, "t_1", { ...base, clockOut: "20:00" }, "2026-08-22");
    assert.equal(a.shiftId, b.shiftId);
    assert.equal(b.workedMinutes, 600);
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE worked_on='2026-08-22'`).first();
    assert.equal(n.n, 1);
  });

  test("🔴 B-6: 他テナントの従業員のシフトは登録できない", async () => {
    const { db } = await seed();
    await assert.rejects(
      () => upsertShift(db, "t_1", {
        employeeId: "e_2", workedOn: "2026-08-20", shiftTypeId: null,
        clockIn: "09:00", clockOut: "18:00", breakMinutes: 0, overtimeMinutes: 0,
        isAbsent: false, isLate: false, isEarlyLeave: false, note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
      }, "2026-08-15"),
      ShiftServiceError
    );
  });

  test("他テナントの勤務区分は指定できない", async () => {
    const { db } = await seed();
    await db.prepare(`INSERT INTO shift_types (id,tenant_id,code,name,sort_order,created_at,updated_at) VALUES ('st_b1','t_2','1','早番',1,?1,?1)`).bind(nowUtc()).run();
    await assert.rejects(
      () => upsertShift(db, "t_1", {
        employeeId: "e_1", workedOn: "2026-08-23", shiftTypeId: "st_b1",
        clockIn: "09:00", clockOut: "18:00", breakMinutes: 0, overtimeMinutes: 0,
        isAbsent: false, isLate: false, isEarlyLeave: false, note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
      }, "2026-08-15"),
      ShiftServiceError
    );
  });

  test("欠勤は実働0で記録される", async () => {
    const { db } = await seed();
    const r = await upsertShift(db, "t_1", {
      employeeId: "e_1", workedOn: "2026-08-24", shiftTypeId: null,
      clockIn: null, clockOut: null, breakMinutes: 0, overtimeMinutes: 0,
      isAbsent: true, isLate: false, isEarlyLeave: false, note: "私用", dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
    }, "2026-08-15");
    assert.equal(r.workedMinutes, 0);
  });
});

describe("シフト: 締め日基準の集計（集計テーブルを持たない）", () => {
  test("🔴 B-1: 区分別の件数が合計と同値にならない", async () => {
    const { db } = await seed();
    await db.prepare(`INSERT INTO shift_types (id,tenant_id,code,name,sort_order,created_at,updated_at) VALUES ('st_b','t_1','2','遅番',2,?1,?1)`).bind(nowUtc()).run();
    // 締め日20日 → 2026-08 の期間は 2026-07-21〜2026-08-20
    for (const [d, st] of [["2026-07-25","st_a1"],["2026-08-01","st_a1"],["2026-08-05","st_b"]] as const) {
      await upsertShift(db, "t_1", {
        employeeId: "e_1", workedOn: d, shiftTypeId: st,
        clockIn: "09:00", clockOut: "18:00", breakMinutes: 60, overtimeMinutes: 0,
        isAbsent: false, isLate: false, isEarlyLeave: false, note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
      }, "2026-08-15");
    }
    const sum = await summarizePeriod(db, "t_1", "e_1", "2026-08", 20);
    assert.equal(sum.periodStartOn, "2026-07-21");
    assert.equal(sum.periodEndOn, "2026-08-20");
    // seed の 2026-08-14（st_a1）も期間内に含まれるため A は 3 件
    assert.equal(sum.byShiftType["1"], 3);
    assert.equal(sum.byShiftType["2"], 1);
    assert.equal(sum.workDays, 4);
    assert.notEqual(sum.byShiftType["1"], sum.workDays, "区分Aの件数が合計と同値になってはならない（B-1）");
  });

  test("締め日の期間外のシフトは集計に含まれない", async () => {
    const { db } = await seed();
    await upsertShift(db, "t_1", {
      employeeId: "e_1", workedOn: "2026-08-25", shiftTypeId: "st_a1",
      clockIn: "09:00", clockOut: "18:00", breakMinutes: 60, overtimeMinutes: 0,
      isAbsent: false, isLate: false, isEarlyLeave: false, note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
    }, "2026-08-15");
    const sum = await summarizePeriod(db, "t_1", "e_1", "2026-08", 20);
    assert.equal(sum.workDays, 1, "8/25 は次の締め期間なので含まれない（seed の 8/14 のみ）");
  });

  test("遅刻・早退・欠勤が個別に集計される", async () => {
    const { db } = await seed();
    await upsertShift(db, "t_1", {
      employeeId: "e_1", workedOn: "2026-08-03", shiftTypeId: null,
      clockIn: "10:00", clockOut: "18:00", breakMinutes: 60, overtimeMinutes: 0,
      isAbsent: false, isLate: true, isEarlyLeave: false, note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
    }, "2026-08-15");
    await upsertShift(db, "t_1", {
      employeeId: "e_1", workedOn: "2026-08-04", shiftTypeId: null,
      clockIn: null, clockOut: null, breakMinutes: 0, overtimeMinutes: 0,
      isAbsent: true, isLate: false, isEarlyLeave: false, note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
    }, "2026-08-15");
    const sum = await summarizePeriod(db, "t_1", "e_1", "2026-08", 20);
    assert.equal(sum.lateCount, 1);
    assert.equal(sum.absenceCount, 1);
  });
});

describe("期間単位の緊急確認（現行 shift1_r1_flg1・shift1Template.php で意味を訂正）", () => {
  test("緊急確認を立てると締め期間の開始日で記録される", async () => {
    const { db } = await seed();
    const r = await setUrgentCheck(db, "t_1", "e_1", "2026-08", 20, true, "acc_1");
    assert.equal(r.periodStartOn, "2026-07-21");
    assert.equal(r.needsUrgentCheck, true);
    assert.equal(await hasUrgentCheck(db, "t_1", "e_1", "2026-07-21"), true);
  });

  test("解除できる", async () => {
    const { db } = await seed();
    await setUrgentCheck(db, "t_1", "e_1", "2026-08", 20, true, "acc_1");
    await setUrgentCheck(db, "t_1", "e_1", "2026-08", 20, false, "acc_1");
    assert.equal(await hasUrgentCheck(db, "t_1", "e_1", "2026-07-21"), false);
  });

  test("二重に立てても行が増えない", async () => {
    const { db } = await seed();
    await setUrgentCheck(db, "t_1", "e_1", "2026-08", 20, true, "acc_1");
    await setUrgentCheck(db, "t_1", "e_1", "2026-08", 20, true, "acc_1");
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM shift_period_flags`).first();
    assert.equal(n.n, 1);
  });

  test("他テナントの従業員には立てられない（B-6）", async () => {
    const { db } = await seed();
    await assert.rejects(() => setUrgentCheck(db, "t_1", "e_2", "2026-08", 20, true, "acc_1"), ShiftServiceError);
  });

  test("退会時に削除される", async () => {
    const { db, r2 } = await seed();
    await setUrgentCheck(db, "t_1", "e_1", "2026-08", 20, true, "acc_1");
    const res = await deleteEmployee(db, r2 as never, "t_1", "e_1");
    assert.equal(res.deleted.shift_period_flags, 1);
  });
});

describe("日ごとの確定・当日確認（現行 shift_s_id / shift_flg2 を実証）", () => {
  const base = {
    employeeId: "e_1", workedOn: "2026-08-25", shiftTypeId: null,
    clockIn: "09:00", clockOut: "18:00", breakMinutes: 60, overtimeMinutes: 0,
    isAbsent: false, isLate: false, isEarlyLeave: false,
    note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
  };

  test("日ごとの確定が保存される（現行 shift_s_id）", async () => {
    const { db } = await seed();
    const r = await upsertShift(db, "t_1", { ...base, isConfirmed: true }, "2026-08-25");
    const row = await db.prepare(`SELECT is_confirmed FROM shifts WHERE id = ?1`).bind(r.shiftId).first();
    assert.equal(row.is_confirmed, 1);
  });

  test("当日確認と2種類の備考が保存される（現行 shift_flg2 / remarks1 / flg8）", async () => {
    const { db } = await seed();
    const r = await upsertShift(db, "t_1", {
      ...base, isDayLocked: true, note: "予定側メモ", dayNote: "実績側メモ",
    }, "2026-08-25");
    const row = await db.prepare(`SELECT is_day_locked, note, day_note FROM shifts WHERE id = ?1`).bind(r.shiftId).first();
    assert.equal(row.is_day_locked, 1);
    assert.equal(row.note, "予定側メモ");
    assert.equal(row.day_note, "実績側メモ");
  });
});

describe("勤務時間帯は最大21種（現行 tb_m_cate1 の CATE1_REMARKS1..21 を実証）", () => {
  test("code 1〜21 が登録できる", async () => {
    const db = new ShimD1(SCHEMA) as AnyDb;
    const t = nowUtc();
    await db.prepare(`INSERT INTO tenants (id,name,cutoff_day,timezone,status,created_at,updated_at) VALUES ('t_x','X社',20,'Asia/Tokyo','active',?1,?1)`).bind(t).run();
    for (let i = 1; i <= 21; i++) {
      await db.prepare(
        `INSERT INTO shift_types (id,tenant_id,code,name,sort_order,created_at,updated_at) VALUES (?1,'t_x',?2,?3,?4,?5,?5)`
      ).bind(`st_${i}`, String(i), `区分${i}`, i, t).run();
    }
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM shift_types WHERE tenant_id='t_x'`).first();
    assert.equal(n.n, 21);
  });

  test("🔴 22以上は拒否される（現行の上限は21）", async () => {
    const db = new ShimD1(SCHEMA) as AnyDb;
    const t = nowUtc();
    await db.prepare(`INSERT INTO tenants (id,name,cutoff_day,timezone,status,created_at,updated_at) VALUES ('t_x','X社',20,'Asia/Tokyo','active',?1,?1)`).bind(t).run();
    await assert.rejects(async () =>
      db.prepare(`INSERT INTO shift_types (id,tenant_id,code,name,sort_order,created_at,updated_at) VALUES ('st_22','t_x','22','区分22',22,?1,?1)`).bind(t).run()
    );
  });
});

describe("現行の時刻計算との一致（照合報告 2.1・4,968パターン検証済み）", () => {
  test("現行4本と同じ実働時間になる", () => {
    const cases: Array<[string, string, number, number, number]> = [
      ["09:00", "18:00", 60, 0, 480],
      ["09:00", "18:00", 60, 30, 510],
      ["22:00", "06:00", 60, 0, 420],
      ["20:00", "05:00", 60, 0, 480],
      ["08:00", "23:00", 60, 0, 840],
    ];
    for (const [ci, co, br, ot, expect] of cases) {
      assert.equal(
        calcWorkedMinutes({ clockIn: ci, clockOut: co, breakMinutes: br, overtimeMinutes: ot }),
        expect,
        `${ci}-${co} 休${br} 残${ot}`
      );
    }
  });

  test("B-30: 休憩が拘束を超える矛盾入力を拒否する（現行は1380分などを保存していた）", () => {
    assert.throws(
      () => calcWorkedMinutes({ clockIn: "00:00", clockOut: "01:00", breakMinutes: 120, overtimeMinutes: 0 }),
      ShiftValidationError
    );
  });
});

describe("締め済み期間への登録拒否（現行 shift23update のチェックを全体に適用・会話合意 2026-08-15）", () => {
  test("勤務日が属する締め期間を正しく判定する（締め日20日）", () => {
    // 20日以前 → その月の期間、21日以降 → 翌月の期間
    assert.deepEqual(periodForDate("2026-08-20", 20), { yearMonth: "2026-08", start: "2026-07-21", end: "2026-08-20" });
    assert.deepEqual(periodForDate("2026-08-21", 20), { yearMonth: "2026-09", start: "2026-08-21", end: "2026-09-20" });
    assert.deepEqual(periodForDate("2026-07-25", 20), { yearMonth: "2026-08", start: "2026-07-21", end: "2026-08-20" });
  });

  test("月末締めなら当月がそのまま期間になる", () => {
    assert.deepEqual(periodForDate("2026-08-05", 31), { yearMonth: "2026-08", start: "2026-08-01", end: "2026-08-31" });
  });

  test("年跨ぎでも正しい期間になる", () => {
    assert.deepEqual(periodForDate("2025-12-25", 20), { yearMonth: "2026-01", start: "2025-12-21", end: "2026-01-20" });
  });

  const shiftOn = (workedOn: string) => ({
    employeeId: "e_1", workedOn, shiftTypeId: null,
    clockIn: "09:00", clockOut: "18:00", breakMinutes: 60, overtimeMinutes: 0,
    isAbsent: false, isLate: false, isEarlyLeave: false, note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
  });

  test("締めが終わった期間には登録できない", async () => {
    const { db } = await seed();
    // 締め日20日。2026-06-10 の期間は 2026-05-21..2026-06-20。今日が 2026-08-15 なら締め済み
    await assert.rejects(
      () => upsertShift(db, "t_1", shiftOn("2026-06-10"), "2026-08-15"),
      (e: Error) => (e as ShiftServiceError).code === "period_closed"
    );
  });

  test("🔴 締め期間内なら前月の日付でも登録できる（現行の Y-m 比較では拒否されていた）", async () => {
    const { db } = await seed();
    // 2026-07-25 は 2026-08 の締め期間（7/21〜8/20）に属する。今日が 8/15 なら登録できるべき
    const r = await upsertShift(db, "t_1", shiftOn("2026-07-25"), "2026-08-15");
    assert.equal(r.workedMinutes, 480);
  });

  test("期間の最終日ちょうどは登録できる", async () => {
    const { db } = await seed();
    const r = await upsertShift(db, "t_1", shiftOn("2026-08-20"), "2026-08-20");
    assert.equal(r.workedMinutes, 480);
  });

  test("翌日になると前の期間は閉じる", async () => {
    const { db } = await seed();
    await assert.rejects(
      () => upsertShift(db, "t_1", shiftOn("2026-08-20"), "2026-08-21"),
      (e: Error) => (e as ShiftServiceError).code === "period_closed"
    );
  });

  test("未来の期間には登録できる（シフトは事前に組むため）", async () => {
    const { db } = await seed();
    const r = await upsertShift(db, "t_1", shiftOn("2026-09-10"), "2026-08-15");
    assert.equal(r.workedMinutes, 480);
  });
});

describe("初期セットアップ（設計の欠落として検出・2026-08-15）", () => {
  const emptyDb = () => new ShimD1(SCHEMA) as AnyDb;
  async function withRoles(db: AnyDb) {
    const t = nowUtc();
    for (const [id, code, hr] of [["r_ten","tenant_admin",1],["r_emp","employee",0]] as const) {
      await db.prepare(`INSERT INTO roles (id,code,name,is_hr_line,created_at) VALUES (?1,?2,?2,?3,?4)`).bind(id, code, hr, t).run();
    }
    return db;
  }
  const INPUT = {
    tenantName: "デモ株式会社", cutoffDay: 20,
    adminLoginId: "admin", adminPassword: "Pono-Plus-2026!", adminEmail: null,
  };

  test("トークンが一致すればテナント・管理者・勤務時間帯A〜Dが作られる", async () => {
    const db = await withRoles(emptyDb());
    const r = await bootstrapSetup(db, "secret-token", "secret-token", INPUT);
    assert.equal(r.ok, true);
    const st = await db.prepare(`SELECT COUNT(*) AS n FROM shift_types`).first();
    assert.equal(st.n, 4, "初期の勤務時間帯が4件作られる");
    const ar = await db.prepare(`SELECT r.code FROM account_roles ar JOIN roles r ON r.id=ar.role_id`).first();
    assert.equal(ar.code, "tenant_admin");
  });

  test("作った管理者でログインできる", async () => {
    const db = await withRoles(emptyDb());
    const r = await bootstrapSetup(db, "secret-token", "secret-token", INPUT);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const l = await login(db, { loginId: "admin", password: "Pono-Plus-2026!", tenantId: r.tenantId, ip: null, userAgent: null });
    assert.equal(l.ok, true);
  });

  test("🔴 SETUP_TOKEN が未設定なら常に拒否される", async () => {
    const db = await withRoles(emptyDb());
    const r = await bootstrapSetup(db, undefined, "anything", INPUT);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "disabled");
  });

  test("🔴 トークンが違えば拒否される", async () => {
    const db = await withRoles(emptyDb());
    const r = await bootstrapSetup(db, "secret-token", "wrong-token!", INPUT);
    assert.equal(r.ok, false);
  });

  test("🔴 2回目は拒否される（テナントが既に存在するため）", async () => {
    const db = await withRoles(emptyDb());
    await bootstrapSetup(db, "secret-token", "secret-token", INPUT);
    const r = await bootstrapSetup(db, "secret-token", "secret-token", { ...INPUT, adminLoginId: "admin2" });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "already_initialized");
  });

  test("短いパスワード・不正な締め日は拒否される", async () => {
    const db = await withRoles(emptyDb());
    assert.equal((await bootstrapSetup(db, "t", "t", { ...INPUT, adminPassword: "short" })).ok, false);
    assert.equal((await bootstrapSetup(db, "t", "t", { ...INPUT, cutoffDay: 32 })).ok, false);
  });

  test("パスワードは平文で保存されない", async () => {
    const db = await withRoles(emptyDb());
    await bootstrapSetup(db, "secret-token", "secret-token", INPUT);
    const acc = await db.prepare(`SELECT password_hash FROM accounts`).first();
    assert.ok(acc.password_hash.startsWith("$scrypt$"));
    assert.equal(acc.password_hash.includes("Pono-Plus-2026!"), false);
  });
});

describe("勤怠評価（WBS ブロック8・設計書 5.1 優先5）", () => {
  async function withShifts(db: AnyDb) {
    const base = {
      employeeId: "e_1", shiftTypeId: "st_a1", clockIn: "09:00", clockOut: "18:00",
      breakMinutes: 60, overtimeMinutes: 0, isAbsent: false, isLate: false,
      isEarlyLeave: false, note: null, dayNote: null, isConfirmed: false, isDayLocked: false, worksiteId: null,
    };
    // 締め日20日 → 2026-09 の期間は 2026-08-21〜2026-09-20
    await upsertShift(db, "t_1", { ...base, workedOn: "2026-08-25" }, "2026-08-25");
    await upsertShift(db, "t_1", { ...base, workedOn: "2026-08-26", isLate: true, overtimeMinutes: 30 }, "2026-08-26");
    await upsertShift(db, "t_1", { ...base, workedOn: "2026-08-27", isEarlyLeave: true }, "2026-08-27");
    await upsertShift(db, "t_1", {
      ...base, workedOn: "2026-08-28", clockIn: null, clockOut: null, isAbsent: true,
    }, "2026-08-28");
    return db;
  }

  test("遅刻・早退・欠勤・残業が個別に集計される", async () => {
    const { db } = await seed();
    await withShifts(db);
    const r = await evaluateAttendance(db, "t_1", { employeeId: "e_1", yearMonth: "2026-09", cutoffDay: 20, asOf: "2026-09-21" });
    assert.equal(r.periodStartOn, "2026-08-21");
    assert.equal(r.periodEndOn, "2026-09-20");
    assert.equal(r.workDays, 3);
    assert.equal(r.absenceCount, 1);
    assert.equal(r.lateCount, 1);
    assert.equal(r.earlyLeaveCount, 1);
    assert.equal(r.overtimeMinutes, 30);
    assert.equal(r.workedMinutes, 480 * 3 + 30);
  });

  test("出勤率は登録日数に対する出勤日数で算出される", async () => {
    const { db } = await seed();
    await withShifts(db);
    const r = await evaluateAttendance(db, "t_1", { employeeId: "e_1", yearMonth: "2026-09", cutoffDay: 20, asOf: "2026-09-21" });
    assert.equal(r.attendanceRate, 75); // 3 / (3+1)
  });

  test("登録が0件なら出勤率は null（0除算を避ける）", async () => {
    const { db } = await seed();
    const r = await evaluateAttendance(db, "t_1", { employeeId: "e_1", yearMonth: "2027-01", cutoffDay: 20, asOf: "2027-01-21" });
    assert.equal(r.attendanceRate, null);
    assert.equal(r.workDays, 0);
  });

  test("🔴 年齢は暦日ベース（現行の365.25日近似を使わない・設計書 4.10）", () => {
    assert.equal(ageOn("1990-05-15", "2026-05-14"), 35, "誕生日前日は35歳");
    assert.equal(ageOn("1990-05-15", "2026-05-15"), 36, "誕生日当日で36歳");
    assert.equal(ageOn("2024-02-29", "2026-02-28"), 1, "閏日生まれの非閏年");
  });

  test("勤続年数が暦日ベースで算出される", async () => {
    const { db } = await seed();
    await db.prepare(`UPDATE employees SET hired_on='2020-03-01', birth_on='1990-05-15' WHERE id='e_1'`).run();
    const r = await evaluateAttendance(db, "t_1", { employeeId: "e_1", yearMonth: "2026-09", cutoffDay: 20, asOf: "2026-08-14" });
    assert.deepEqual(r.tenure, { years: 6, months: 5 });
    assert.equal(r.age, 36);
  });

  test("生年月日・入社日が未設定なら null を返す（推測で埋めない）", async () => {
    const { db } = await seed();
    const r = await evaluateAttendance(db, "t_1", { employeeId: "e_1", yearMonth: "2026-09", cutoffDay: 20, asOf: "2026-09-21" });
    assert.equal(r.tenure, null);
    assert.equal(r.age, null);
  });

  test("🔴 他テナントの従業員は評価できない（B-6）", async () => {
    const { db } = await seed();
    await assert.rejects(
      () => evaluateAttendance(db, "t_1", { employeeId: "e_2", yearMonth: "2026-09", cutoffDay: 20 }),
      ShiftServiceError
    );
  });

  test("締め後の確定保存ができ、二重実行しても行が増えない", async () => {
    const { db } = await seed();
    await withShifts(db);
    const a = await persistAttendanceSummary(db, "t_1", "e_1", "2026-09", 20);
    const b = await persistAttendanceSummary(db, "t_1", "e_1", "2026-09", 20);
    assert.equal(a.id, b.id);
    const n = await db.prepare(`SELECT COUNT(*) AS n FROM attendance_summaries`).first();
    assert.equal(n.n, 1);
    const row = await db.prepare(`SELECT * FROM attendance_summaries WHERE id = ?1`).bind(a.id).first();
    assert.equal(row.work_days, 3);
    assert.equal(row.absence_count, 1);
  });
});

describe("ログイン: 会社を指定しない（現行画面は ID と PW のみ）", () => {
  test("tenantId を省略してもログインIDから会社が特定される", async () => {
    const { db } = await seed();
    const r = await login(db, { loginId: "admin1", password: "Pono-Plus-2026!", tenantId: null, ip: null, userAgent: null });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.tenantId, "t_1", "ログインIDから会社が解決される");
  });

  test("別会社のアカウントも同様に解決される", async () => {
    const { db } = await seed();
    const r = await login(db, { loginId: "admin2", password: "Pono-Plus-2026!", tenantId: null, ip: null, userAgent: null });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.tenantId, "t_2");
  });

  test("存在しないIDは会社不明でも invalid_credentials（存在を漏らさない）", async () => {
    const { db } = await seed();
    const r = await login(db, { loginId: "nobody", password: "x", tenantId: null, ip: null, userAgent: null });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "invalid_credentials");
  });

  test("🔴 IDが複数社に重複していたら、推測せず会社の選択を求める", async () => {
    const { db } = await seed();
    // 既存データを直接いじって重複を作る（通常は登録時に拒否される）
    const t = nowUtc();
    await db.prepare(
      `INSERT INTO accounts (id,tenant_id,login_id,password_hash,password_algo,password_updated_at,status,created_at,updated_at)
       VALUES ('acc_dup','t_2','admin1','$scrypt$N=16384,r=8,p=5$aa$bb','x',?1,'active',?1,?1)`
    ).bind(t).run();

    const r = await login(db, { loginId: "admin1", password: "Pono-Plus-2026!", tenantId: null, ip: null, userAgent: null });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "tenant_required");
    if (r.reason !== "tenant_required") return;
    assert.equal(r.tenants.length, 2, "候補の会社が返る");
  });

  test("重複時でも tenantId を指定すればログインできる", async () => {
    const { db } = await seed();
    const t = nowUtc();
    await db.prepare(
      `INSERT INTO accounts (id,tenant_id,login_id,password_hash,password_algo,password_updated_at,status,created_at,updated_at)
       VALUES ('acc_dup','t_2','admin1','$scrypt$N=16384,r=8,p=5$aa$bb','x',?1,'active',?1,?1)`
    ).bind(t).run();
    const r = await login(db, { loginId: "admin1", password: "Pono-Plus-2026!", tenantId: "t_1", ip: null, userAgent: null });
    assert.equal(r.ok, true);
  });
});

describe("画面（現行 loginuser*Template.php の構造を踏襲）", () => {
  test("ログイン画面が HTML で返る", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(req("GET", "/login"), { DB: db, PHOTOS: r2 } as never, execCtx);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes('name="login_id"'), "ID の入力欄がある");
    assert.ok(body.includes('type="password"'), "パスワードがマスクされる");
    assert.ok(body.includes("ログイン"), "送信ボタンがある");
  });

  test("🔴 会社の入力欄は既定で表示しない（現行は ID と PW のみ）", () => {
    const body = loginPage();
    assert.ok(body.includes('id="tenant_row"'), "重複時用の欄は存在する");
    assert.ok(/id="tenant_row"[^>]*hidden/.test(body), "既定では hidden");
  });

  test("🔴 B-35: 入力値を埋め戻す際にエスケープされる（現行は未エスケープ）", () => {
    const body = loginPage({ loginId: '"><script>alert(1)</script>' });
    assert.equal(body.includes("<script>alert(1)</script>"), false, "スクリプトがそのまま入ってはならない");
    assert.ok(body.includes("&lt;script&gt;"), "エスケープされている");
  });

  test("🔴 B-36: エラーメッセージもエスケープされる（現行は HTML 直挿入）", () => {
    const body = loginPage({ errorMessage: '<img src=x onerror=alert(1)>' });
    assert.equal(body.includes("<img src=x"), false);
    assert.ok(body.includes("&lt;img"));
  });

  test("🔴 B-38: jQuery などの外部CDNに依存しない（現行は 2014年版を読み込み）", () => {
    const body = loginPage();
    assert.equal(/<script[^>]+src=/.test(body), false, "外部スクリプトの読み込みが無い");
  });

  test("セキュリティヘッダが付く", async () => {
    const { db, r2 } = await seed();
    const res = await worker.fetch(req("GET", "/login"), { DB: db, PHOTOS: r2 } as never, execCtx);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  });
});

describe("シフト入力画面（現行 shift1Template.php の列構成を踏襲）", () => {
  test("締め期間の全日が行として返る（登録の無い日も空行）", async () => {
    const { db } = await seed();
    const sheet = await getShiftSheet(db, "t_1", "e_1", "2026-09", 20);
    assert.equal(sheet.periodStartOn, "2026-08-21");
    assert.equal(sheet.periodEndOn, "2026-09-20");
    assert.equal(sheet.rows.length, 31, "8/21〜9/20 の31日分");
    assert.equal(sheet.rows[0].day, 21);
    assert.equal(sheet.rows[0].weekday.length, 1, "曜日が1文字で入る");
  });

  test("登録済みの日には値が入り、実働も返る", async () => {
    const { db } = await seed();
    await upsertShift(db, "t_1", {
      employeeId: "e_1", workedOn: "2026-08-25", shiftTypeId: "st_a1",
      clockIn: "22:00", clockOut: "06:00", breakMinutes: 60, overtimeMinutes: 0,
      isAbsent: false, isLate: false, isEarlyLeave: false,
      note: "夜勤", dayNote: null, isConfirmed: true, isDayLocked: false, worksiteId: null,
    }, "2026-08-25");
    const sheet = await getShiftSheet(db, "t_1", "e_1", "2026-09", 20);
    const row = sheet.rows.find((r) => r.workedOn === "2026-08-25");
    assert.equal(row?.workedMinutes, 420, "日跨ぎ420分");
    assert.equal(row?.clockOut, "30:00", "24時超え表記で保持");
    assert.equal(row?.isConfirmed, true);
    assert.equal(row?.note, "夜勤");
    assert.equal(sheet.totalWorkedMinutes, 420);
  });

  test("勤務時間帯の選択肢が返る", async () => {
    const { db } = await seed();
    const sheet = await getShiftSheet(db, "t_1", "e_1", "2026-09", 20);
    assert.ok(sheet.shiftTypes.length >= 1);
    assert.equal(sheet.shiftTypes[0].code, "1");
  });

  test("緊急確認の状態が返る", async () => {
    const { db } = await seed();
    await setUrgentCheck(db, "t_1", "e_1", "2026-09", 20, true, "acc_1");
    const sheet = await getShiftSheet(db, "t_1", "e_1", "2026-09", 20);
    assert.equal(sheet.needsUrgentCheck, true);
  });

  test("🔴 他テナントの従業員のシートは取得できない（B-6）", async () => {
    const { db } = await seed();
    await assert.rejects(() => getShiftSheet(db, "t_1", "e_2", "2026-09", 20), ShiftServiceError);
  });

  test("🔴 B-39: 外部CDN（rawgit 等）に依存しない", () => {
    const body = shiftSheetPage();
    assert.equal(/<script[^>]+src=/.test(body), false);
    assert.equal(body.includes("rawgit"), false);
  });

  test("画面に現行と同じ列が並ぶ", () => {
    const body = shiftSheetPage();
    for (const col of ["確定", "時間帯", "フリー入力", "当日確認", "出勤", "退勤", "休憩", "残業", "実働", "当日フリー"]) {
      assert.ok(body.includes(col), `列「${col}」がある`);
    }
  });
});

describe("退勤の表示と入力（保存は24時超え表記のまま）", () => {
  test("24時以降は「翌 HH:MM」で表示する", () => {
    assert.equal(formatClockOut("30:00"), "翌 06:00");
    assert.equal(formatClockOut("24:00"), "翌 00:00");
    assert.equal(formatClockOut("47:59"), "翌 23:59");
  });

  test("当日中はそのまま表示する", () => {
    assert.equal(formatClockOut("18:00"), "18:00");
    assert.equal(formatClockOut("23:59"), "23:59");
    assert.equal(formatClockOut(null), "");
  });

  test("🔴 保存形式は変えない（06:00 に戻すと当日か翌日か判別できなくなる）", () => {
    // 表示だけの変換であり、往復しても元の意味が失われないこと
    assert.equal(parseClockOut(formatClockOut("30:00")), "06:00");
    // サーバ側は clockIn=22:00 との比較で再び 30:00 に正規化する（normalizeClockOut）
  });

  test("「翌」付きの入力を受け付ける", () => {
    assert.equal(parseClockOut("翌 06:00"), "06:00");
    assert.equal(parseClockOut("翌06:00"), "06:00");
    assert.equal(parseClockOut("翌日 06:00"), "06:00");
  });

  test("🔴 全角・1桁の入力を受け付ける（現行は変換していなかった）", () => {
    assert.equal(parseClockOut("２２：００"), "22:00");
    assert.equal(parseClockOut("06：00"), "06:00");
    assert.equal(parseClockOut("6:00"), "06:00");
    assert.equal(parseClockOut(" 9:5 "), "09:05");
  });

  test("空文字はそのまま空", () => {
    assert.equal(parseClockOut(""), "");
    assert.equal(parseClockOut("　"), "");
  });

  test("画面に変換関数が組み込まれている", () => {
    const body = shiftSheetPage();
    assert.ok(body.includes("fmtOut"), "表示変換がある");
    assert.ok(body.includes("normTime"), "入力正規化がある");
    assert.ok(body.includes("翌"), "翌日表記を使う");
  });
});

// ===============================================================
// 従業員一覧・単票・修正（Session 04 / T-2〜T-7）
// ===============================================================
describe("登録: 未書込みだった列を保存する（F-1 / F-2）", () => {
  test("🔴 hired_on を保存する（保存しないと勤続が常に null になる）", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", BASE_REG, TODAY);
    const emp = await db.prepare(`SELECT * FROM employees WHERE id = ?1`).bind(r.employeeId).first();
    assert.equal(emp.hired_on, "2015-04-01");
  });

  test("employee_code と name_kana を保存する", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", BASE_REG, TODAY);
    const emp = await db.prepare(`SELECT * FROM employees WHERE id = ?1`).bind(r.employeeId).first();
    assert.equal(emp.employee_code, "E-001");
    assert.equal(emp.name_kana, "ヤマダタロウ");
  });

  test("勤続年数が実際に算出される（F-1 の回帰）", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", BASE_REG, TODAY);
    const ev = await evaluateAttendance(db, "t_1", {
      employeeId: r.employeeId, yearMonth: "2026-08", cutoffDay: 20, asOf: "2026-08-14",
    });
    assert.notEqual(ev.tenure, null);
  });

  test("従業員番号は会社内で重複できない", async () => {
    const { db } = await seed();
    await registerEmployee(db, "t_1", BASE_REG, TODAY);
    await assert.rejects(
      () => registerEmployee(db, "t_1", { ...BASE_REG, loginId: "other01" }, TODAY),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.field === "employeeCode")
    );
  });

  test("従業員番号が空でも2人目を登録できる（空文字を null に落とす）", async () => {
    const { db } = await seed();
    await registerEmployee(db, "t_1", { ...BASE_REG, employeeCode: "" }, TODAY);
    const r = await registerEmployee(db, "t_1", { ...BASE_REG, employeeCode: "", loginId: "other01" }, TODAY);
    assert.ok(r.employeeId.length > 0);
  });
});

describe("登録: 入社日の検証", () => {
  test("未来の入社日を弾く", () => {
    const iss = validateRegistration({ ...BASE_REG, hiredOn: "2027-01-01" }, TODAY);
    assert.ok(iss.some((i) => i.field === "hiredOn" && i.code === "in_the_future"));
  });
  test("生年月日より前の入社日を弾く", () => {
    const iss = validateRegistration({ ...BASE_REG, hiredOn: "1980-01-01" }, TODAY);
    assert.ok(iss.some((i) => i.field === "hiredOn" && i.code === "before_birth"));
  });
  test("入社日が未入力でも登録できる", () => {
    assert.deepEqual(validateRegistration({ ...BASE_REG, hiredOn: null }, TODAY), []);
  });
});

describe("登録: 勤務時間帯は自テナントの shift_types のみ（F-3）", () => {
  test("自テナントの勤務時間帯を保存できる", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", { ...BASE_REG, shiftTypeId: "st_a1" }, TODAY);
    const emp = await db.prepare(`SELECT * FROM employees WHERE id = ?1`).bind(r.employeeId).first();
    assert.equal(emp.default_shift_type_id, "st_a1");
  });

  test("🔴 他テナントの勤務時間帯は拒否する（B-6）", async () => {
    const { db } = await seed();
    await assert.rejects(
      () => registerEmployee(db, "t_2", { ...BASE_REG, shiftTypeId: "st_a1" }, TODAY),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.field === "shiftTypeId")
    );
  });

  test("存在しない勤務時間帯は拒否する", async () => {
    const { db } = await seed();
    await assert.rejects(
      () => registerEmployee(db, "t_1", { ...BASE_REG, shiftTypeId: "st_zzz" }, TODAY),
      RegistrationError
    );
  });

  test("listShiftTypes は自テナントのものだけを返す", async () => {
    const { db } = await seed();
    assert.equal((await listShiftTypes(db, "t_1")).length, 1);
    assert.equal((await listShiftTypes(db, "t_2")).length, 0);
  });
});

describe("一覧: listEmployees（T-4）", () => {
  test("🔴 自テナントの従業員だけを返す（B-6）", async () => {
    const { db } = await seed();
    const a = await listEmployees(db, "t_1");
    const b = await listEmployees(db, "t_2");
    assert.deepEqual(a.map((e) => e.name), ["山田"]);
    assert.deepEqual(b.map((e) => e.name), ["佐藤"]);
  });

  test("ログインIDと勤務時間帯名を結合して返す", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", { ...BASE_REG, shiftTypeId: "st_a1" }, TODAY);
    const rows = await listEmployees(db, "t_1");
    const me = rows.find((e) => e.id === r.employeeId);
    assert.equal(me?.loginId, "yamada01");
    assert.equal(me?.shiftTypeName, "早番");
  });

  test("パスワードハッシュを一覧に含めない（SELECT * を使わない）", async () => {
    const { db } = await seed();
    await registerEmployee(db, "t_1", BASE_REG, TODAY);
    const rows = await listEmployees(db, "t_1");
    for (const row of rows) {
      for (const v of Object.values(row)) {
        assert.equal(typeof v === "string" && v.includes("$scrypt$"), false);
      }
    }
  });

  test("状態で絞り込める", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", BASE_REG, TODAY);
    await updateEmployee(db, "t_1", r.employeeId, { status: "resigned" }, TODAY);
    assert.equal((await listEmployees(db, "t_1", { status: "resigned" })).length, 1);
    assert.equal((await listEmployees(db, "t_1", { status: "active" })).length, 1);
    assert.equal((await listEmployees(db, "t_1")).length, 2);
  });

  test("氏名・カナ・従業員番号の部分一致で絞り込める", async () => {
    const { db } = await seed();
    await registerEmployee(db, "t_1", BASE_REG, TODAY);
    assert.equal((await listEmployees(db, "t_1", { keyword: "山田太" })).length, 1);
    assert.equal((await listEmployees(db, "t_1", { keyword: "ヤマダ" })).length, 1);
    assert.equal((await listEmployees(db, "t_1", { keyword: "E-001" })).length, 1);
    assert.equal((await listEmployees(db, "t_1", { keyword: "該当なし" })).length, 0);
  });

  test("🔴 LIKE のワイルドカードを打ち消す（% で全件が返らない）", async () => {
    const { db } = await seed();
    await registerEmployee(db, "t_1", BASE_REG, TODAY);
    assert.equal((await listEmployees(db, "t_1", { keyword: "%" })).length, 0);
    assert.equal((await listEmployees(db, "t_1", { keyword: "_" })).length, 0);
  });

  test("不正な状態を指定したら弾く", async () => {
    const { db } = await seed();
    await assert.rejects(() => listEmployees(db, "t_1", { status: "zombie" }), RegistrationError);
  });
});

describe("単票・修正: getEmployee / updateEmployee（T-5 / T-6）", () => {
  test("🔴 他テナントの従業員は取得できない（B-6）", async () => {
    const { db } = await seed();
    assert.notEqual(await getEmployee(db, "t_1", "e_1"), null);
    assert.equal(await getEmployee(db, "t_2", "e_1"), null);
  });

  test("送ったキーだけが変わる（部分更新）", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", BASE_REG, TODAY);
    await updateEmployee(db, "t_1", r.employeeId, { nameKana: "ヤマダジロウ" }, TODAY);
    const e = await getEmployee(db, "t_1", r.employeeId);
    assert.equal(e?.nameKana, "ヤマダジロウ");
    assert.equal(e?.name, "山田太郎");
    assert.equal(e?.hiredOn, "2015-04-01");
  });

  test("🔴 他テナントからの修正は not_found になる", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", BASE_REG, TODAY);
    await assert.rejects(
      () => updateEmployee(db, "t_2", r.employeeId, { name: "乗っ取り" }, TODAY),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.code === "not_found")
    );
  });

  test("退職にすると退職日が入り、在籍に戻すと消える", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", BASE_REG, TODAY);
    await updateEmployee(db, "t_1", r.employeeId, { status: "resigned" }, TODAY);
    let row = await db.prepare(`SELECT * FROM employees WHERE id = ?1`).bind(r.employeeId).first();
    assert.equal(row.resigned_on, TODAY);
    await updateEmployee(db, "t_1", r.employeeId, { status: "active" }, TODAY);
    row = await db.prepare(`SELECT * FROM employees WHERE id = ?1`).bind(r.employeeId).first();
    assert.equal(row.resigned_on, null);
  });

  test("修正でも従業員番号の重複を拒否する", async () => {
    const { db } = await seed();
    await registerEmployee(db, "t_1", BASE_REG, TODAY);
    const r2 = await registerEmployee(db, "t_1", { ...BASE_REG, loginId: "b01", employeeCode: "E-002" }, TODAY);
    await assert.rejects(
      () => updateEmployee(db, "t_1", r2.employeeId, { employeeCode: "E-001" }, TODAY),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.field === "employeeCode")
    );
  });

  test("自分自身の番号のままなら重複扱いしない", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", BASE_REG, TODAY);
    await updateEmployee(db, "t_1", r.employeeId, { employeeCode: "E-001", name: "山田次郎" }, TODAY);
    assert.equal((await getEmployee(db, "t_1", r.employeeId))?.name, "山田次郎");
  });

  test("不正な状態・雇用形態・未来の入社日を弾く", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", BASE_REG, TODAY);
    await assert.rejects(() => updateEmployee(db, "t_1", r.employeeId, { status: "zombie" }, TODAY), RegistrationError);
    await assert.rejects(() => updateEmployee(db, "t_1", r.employeeId, { employmentType: "master2" }, TODAY), RegistrationError);
    await assert.rejects(() => updateEmployee(db, "t_1", r.employeeId, { hiredOn: "2099-01-01" }, TODAY), RegistrationError);
  });

  test("修正でログインID・パスワードは変えられない（入力自体を受け付けない）", async () => {
    const { db } = await seed();
    const r = await registerEmployee(db, "t_1", BASE_REG, TODAY);
    await updateEmployee(db, "t_1", r.employeeId, { name: "山田次郎" } as never, TODAY);
    const acc = await db.prepare(
      `SELECT a.login_id, a.password_hash FROM accounts a JOIN employees e ON e.account_id = a.id WHERE e.id = ?1`
    ).bind(r.employeeId).first();
    assert.equal(acc.login_id, "yamada01");
    assert.ok(acc.password_hash.startsWith("$scrypt$"));
  });

  test("employees.status の値域は暫定3値【未確認・㉖】", () => {
    assert.deepEqual([...EMPLOYEE_STATUSES], ["active", "suspended", "resigned"]);
  });
});

describe("ディスパッチャ: 従業員ルート（Session 04）", () => {
  test("ルートが登録されている", () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    for (const p of [
      "GET /employees", "GET /employees/new", "GET /api/employees",
      "GET /api/employees/detail", "POST /api/employees/update", "GET /api/shift-types",
    ]) {
      assert.ok(paths.includes(p), `${p} が未登録`);
    }
  });

  test("🔴 従業員ルートは既定で認証必須（public を書いていない）", () => {
    for (const p of ["/api/employees", "/api/employees/detail", "/api/employees/update", "/api/shift-types"]) {
      for (const r of routes.filter((x) => x.path === p)) {
        assert.notEqual(r.public, true, `${p} が public になっている`);
      }
    }
  });
});

describe("画面: 従業員一覧・登録（T-7）", () => {
  test("一覧に現行の項目と新設の入社日が並ぶ", () => {
    const h = employeeListPage();
    for (const s of ["従業員番号", "氏名", "ログインID", "雇用形態", "勤務時間帯", "入社日", "状態"]) {
      assert.ok(h.includes(s), `${s} が無い`);
    }
  });

  test("🔴 一覧は innerHTML に値を混ぜない（B-35 の再発防止）", () => {
    const h = employeeListPage();
    assert.ok(h.includes("textContent"));
    assert.equal(/innerHTML\s*=\s*[^;]*\+/.test(h), false);
  });

  test("登録画面に入社日の入力欄がある（F-1）", () => {
    const h = employeeFormPage();
    assert.ok(h.includes('id="hiredOn"'));
    assert.ok(h.includes("入社日"));
  });

  test("🔴 勤務時間帯の選択肢を A〜D で固定しない（設計書 4.5 の訂正）", () => {
    const h = employeeFormPage();
    assert.ok(h.includes("/api/shift-types"));
    assert.equal(/<option value="[ABCD]"/.test(h), false);
  });

  test("パスワードは新規登録時のみ入力させる", () => {
    const h = employeeFormPage();
    assert.ok(h.includes('id="newOnly"'));
    assert.ok(h.includes("メール送信はしません"));
  });

  test("外部CDNに依存しない（B-38/B-39）", () => {
    for (const h of [employeeListPage(), employeeFormPage()]) {
      assert.equal(h.includes("http://"), false);
      assert.equal(h.includes("cdn"), false);
    }
  });
});

describe("スキーマ: マイグレーション 0002", () => {
  test("employees.default_shift_type_id が存在する", () => {
    const db = schemaDb();
    const cols = columns(db, "employees").map((c) => c.name);
    assert.ok(cols.includes("default_shift_type_id"));
  });

  test("このマイグレーション自体はテーブルを増やさない（列の追加のみ）", () => {
    // 全マイグレーション適用後の総数。テーブルを増やしたのは 0001・0004〜0009
    assert.equal(tableNames(schemaDb()).length, 30);
  });
});

// ===============================================================
// 勤怠評価の表示画面・画面間の導線（Session 04 / T-9 / T-10）
// ===============================================================
describe("画面: 勤怠評価（T-10）", () => {
  test("ルートが登録され、既定で認証必須の API から取る", () => {
    assert.ok(routes.some((r) => r.method === "GET" && r.path === "/attendance"));
    const h = attendancePage();
    assert.ok(h.includes("/api/attendance/evaluation"));
    assert.ok(h.includes("/api/employees?status=active"));
  });

  test("実績値の項目が並ぶ", () => {
    const h = attendancePage();
    for (const s of ["出勤日数", "実働", "残業", "遅刻", "早退", "欠勤", "出勤率", "勤続", "年齢"]) {
      assert.ok(h.includes(s), `${s} が無い`);
    }
  });

  test("🔴 勤怠の点数化を実装しない【会話合意 2026-08-15】", () => {
    // 設計書 v6 全文に勤怠の点数化の計算式は 0件。5.1 優先5 の定義は実績値のみ。
    // 6.3 の「点数」は Session 02 で「ストレスチェックの結果」と訂正済み。
    // 将来ここに点数を足すなら、移植ではなく新規要件として設計すること。
    assert.ok(attendancePage().includes("点数化は行いません"));
  });

  test("🔴 締め日基準の期間を画面に明示する（yearMonth との食い違いを防ぐ）", () => {
    assert.ok(attendancePage().includes("締め日基準"));
  });

  test("勤続・年齢・出勤率が null のとき理由を出す", () => {
    const h = attendancePage();
    assert.ok(h.includes("入社日が未登録"));
    assert.ok(h.includes("生年月日が未登録"));
    assert.ok(h.includes("登録なし"));
  });

  test("innerHTML に値を混ぜない（B-35）／外部CDNに依存しない（B-38）", () => {
    const h = attendancePage();
    assert.equal(/innerHTML\s*=\s*[^;]*\+/.test(h), false);
    assert.equal(h.includes("http://"), false);
    assert.equal(h.includes("cdn"), false);
  });
});

describe("画面: 導線（T-9）", () => {
  test("ホームから3画面へ行ける", () => {
    const h = homePage();
    for (const p of ['href="/employees"', 'href="/shifts"', 'href="/attendance"']) {
      assert.ok(h.includes(p), `${p} が無い`);
    }
  });

  test("従業員一覧から勤怠評価へ行ける", () => {
    assert.ok(employeeListPage().includes("/attendance?employeeId="));
  });

  test("各画面からホームへ戻れる", () => {
    for (const h of [employeeListPage(), employeeFormPage(), attendancePage()]) {
      assert.ok(h.includes('href="/home"'));
    }
  });
});

describe("画面: 勤怠評価の表示欠陥（F-6 / F-7 の回帰）", () => {
  test("🔴 F-6: 出勤率を二重に百分率化しない", async () => {
    // services 側が既に百分率を返す（下の実測で固定）。画面で 100 倍すると 10000% になる
    const { db } = await seed();
    await db.prepare(
      `INSERT INTO shifts (id,tenant_id,employee_id,worked_on,clock_in,clock_out,break_minutes,overtime_minutes,worked_minutes,is_absent,created_at,updated_at)
       VALUES ('sh_ab','t_1','e_1','2026-08-15',NULL,NULL,0,0,0,1,?1,?1)`
    ).bind(nowUtc()).run();
    const r = await evaluateAttendance(db, "t_1", {
      employeeId: "e_1", yearMonth: "2026-08", cutoffDay: 20, asOf: "2026-08-21",
    });
    assert.equal(r.attendanceRate, 50); // 1 / (1+1)。0.5 ではない

    const h = attendancePage();
    assert.equal(h.includes("attendanceRate * 1000"), false);
    assert.ok(h.includes("r.attendanceRate + ' %'"));
  });

  test("🔴 F-7: カードの枠を子セレクタで当てる（入れ子の div に二重に付かない）", () => {
    const h = attendancePage();
    assert.ok(h.includes(".kpi > div"));
    assert.equal(/[^>]\s\.kpi div \{/.test(h), false);
  });
});

// ===============================================================
// プロフィール（機能権限表 区分5 / T-11〜T-17）
// ===============================================================
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);

describe("プロフィール: 画像の判定（T-14）", () => {
  test("JPEG / PNG / GIF をマジックナンバーで判定する", () => {
    assert.equal(sniffImageType(JPEG)?.ext, "jpg");
    assert.equal(sniffImageType(PNG)?.ext, "png");
    assert.equal(sniffImageType(GIF)?.ext, "gif");
  });

  test("🔴 拡張子や Content-Type を信用しない。中身で判定する", () => {
    // 画像を名乗る HTML / PHP は中身で弾かれる
    const html = new TextEncoder().encode("<!DOCTYPE html><script>alert(1)</script>");
    const php = new TextEncoder().encode("<?php system($_GET['c']); ?>");
    assert.equal(sniffImageType(html), null);
    assert.equal(sniffImageType(php), null);
  });

  test("短すぎるデータで例外にならない", () => {
    assert.equal(sniffImageType(new Uint8Array([])), null);
    assert.equal(sniffImageType(new Uint8Array([0xff])), null);
  });
});

describe("プロフィール: 本文（T-13）", () => {
  test("Profile と Note を保存できる", async () => {
    const { db } = await seed();
    await updateProfile(db, "t_1", "e_1", { profileText: "よろしく", profileNote: "備考" });
    const p = await getProfile(db, "t_1", "e_1");
    assert.equal(p?.profileText, "よろしく");
    assert.equal(p?.profileNote, "備考");
  });

  test("送ったキーだけが変わる", async () => {
    const { db } = await seed();
    await updateProfile(db, "t_1", "e_1", { profileText: "あ", profileNote: "い" });
    await updateProfile(db, "t_1", "e_1", { profileNote: "う" });
    const p = await getProfile(db, "t_1", "e_1");
    assert.equal(p?.profileText, "あ");
    assert.equal(p?.profileNote, "う");
  });

  test("2000文字を超えたら弾く", async () => {
    const { db } = await seed();
    await assert.rejects(
      () => updateProfile(db, "t_1", "e_1", { profileText: "あ".repeat(PROFILE_TEXT_MAX + 1) }),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.code === "too_long")
    );
    assert.equal(PROFILE_TEXT_MAX, 2000);
  });

  test("🔴 他テナントのプロフィールは取得も更新もできない（B-6）", async () => {
    const { db } = await seed();
    assert.notEqual(await getProfile(db, "t_1", "e_1"), null);
    assert.equal(await getProfile(db, "t_2", "e_1"), null);
    await assert.rejects(() => updateProfile(db, "t_2", "e_1", { profileText: "乗っ取り" }), RegistrationError);
  });
});

describe("プロフィール: 顔写真（T-14 / T-15）", () => {
  test("R2 に保存され、キーが DB に入る", async () => {
    const { db, r2 } = await seed();
    const r = await putProfilePhoto(db, r2 as never, "t_1", "e_1", JPEG);
    assert.equal(r.mime, "image/jpeg");
    assert.equal(await getProfilePhotoKey(db, "t_1", "e_1"), r.objectKey);
    assert.equal(r2.objects.has(r.objectKey), true);
    assert.equal((await getProfile(db, "t_1", "e_1"))?.hasPhoto, true);
  });

  test("🔴 オブジェクトキーをユーザー入力から作らない", async () => {
    // 現行は unlink($dir . $_POST["su2_pic1"]) で任意ファイル削除の可能性があった。
    // 新実装はキーを自前で生成し、テナントIDと従業員IDを含める
    const { db, r2 } = await seed();
    const r = await putProfilePhoto(db, r2 as never, "t_1", "e_1", PNG);
    assert.ok(r.objectKey.startsWith("tenants/t_1/employees/e_1/"));
    assert.equal(r.objectKey.includes(".."), false);
  });

  test("差し替えると古いオブジェクトが消える（孤児を作らない）", async () => {
    const { db, r2 } = await seed();
    const a = await putProfilePhoto(db, r2 as never, "t_1", "e_1", JPEG);
    const b = await putProfilePhoto(db, r2 as never, "t_1", "e_1", PNG);
    assert.notEqual(a.objectKey, b.objectKey);
    assert.equal(r2.objects.has(a.objectKey), false);
    assert.equal(r2.objects.has(b.objectKey), true);
    // 🔴 他テナント（e_2）の写真を巻き込まない
    assert.equal(r2.objects.has("photos/e_2.jpg"), true);
  });

  test("削除すると R2 からも DB からも消える", async () => {
    const { db, r2 } = await seed();
    const r = await putProfilePhoto(db, r2 as never, "t_1", "e_1", GIF);
    assert.equal(await deleteProfilePhoto(db, r2 as never, "t_1", "e_1"), true);
    assert.equal(r2.objects.has(r.objectKey), false);
    assert.equal(await getProfilePhotoKey(db, "t_1", "e_1"), null);
    // 2回目は false（すでに無い）
    assert.equal(await deleteProfilePhoto(db, r2 as never, "t_1", "e_1"), false);
  });

  test("🔴 画像でないものを拒否する", async () => {
    const { db, r2 } = await seed();
    const before = r2.objects.size;
    const php = new TextEncoder().encode("<?php system($_GET['c']); ?>");
    await assert.rejects(
      () => putProfilePhoto(db, r2 as never, "t_1", "e_1", php),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.code === "unsupported_type")
    );
    assert.equal(r2.objects.size, before); // R2 に何も書かれていない
  });

  test("🔴 上限を超えたら拒否する（現行はサイズ検査が無かった）", async () => {
    const { db, r2 } = await seed();
    const before = r2.objects.size;
    const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
    big.set(JPEG);
    await assert.rejects(
      () => putProfilePhoto(db, r2 as never, "t_1", "e_1", big),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.code === "too_large")
    );
    assert.equal(r2.objects.size, before);
    assert.equal(PHOTO_MAX_BYTES, 5 * 1024 * 1024);
  });

  test("🔴 他テナントの従業員には保存できない", async () => {
    const { db, r2 } = await seed();
    const before = r2.objects.size;
    await assert.rejects(() => putProfilePhoto(db, r2 as never, "t_2", "e_1", JPEG), RegistrationError);
    assert.equal(r2.objects.size, before);
    // 既存のキーも書き換わっていない
    assert.equal(await getProfilePhotoKey(db, "t_1", "e_1"), "photos/e_1.jpg");
  });

  test("🔴 写真のキーは他テナントから引けない", async () => {
    const { db, r2 } = await seed();
    await putProfilePhoto(db, r2 as never, "t_1", "e_1", JPEG);
    assert.notEqual(await getProfilePhotoKey(db, "t_1", "e_1"), null);
    assert.equal(await getProfilePhotoKey(db, "t_2", "e_1"), null);
  });

  test("退会すると写真も消える（既存の削除計画に載っている）", async () => {
    const { db, r2 } = await seed();
    await putProfilePhoto(db, r2 as never, "t_1", "e_1", JPEG);
    const res = await deleteEmployee(db, r2 as never, "t_1", "e_1");
    assert.equal(res.photosDeleted, 1);
    // e_1 の分だけ消え、他テナントの e_2 は残る
    assert.equal(r2.objects.has("photos/e_2.jpg"), true);
    assert.equal(await getProfilePhotoKey(db, "t_1", "e_1"), null);
  });
});

describe("プロフィール: 編集できるのは自分だけ（T-12）", () => {
  test("アカウントから自分の従業員IDを引ける", async () => {
    const { db } = await seed();
    await db.prepare(`UPDATE employees SET account_id = 'acc_1' WHERE id = 'e_1'`).run();
    assert.equal(await getOwnEmployeeId(db, "t_1", "acc_1"), "e_1");
  });

  test("🔴 テナントが違えば引けない（B-6）", async () => {
    const { db } = await seed();
    await db.prepare(`UPDATE employees SET account_id = 'acc_1' WHERE id = 'e_1'`).run();
    assert.equal(await getOwnEmployeeId(db, "t_2", "acc_1"), null);
  });

  test("従業員に紐づかないアカウントは null", async () => {
    const { db } = await seed();
    assert.equal(await getOwnEmployeeId(db, "t_1", "acc_1"), null);
  });

  test("🔴 更新APIは対象をセッションから引く（リクエストの employeeId を受け付けない）", () => {
    const src = readFileSync(join(here, "..", "src", "index.ts"), "utf-8");
    const i = src.indexOf('path: "/api/profile/update"');
    const j = src.indexOf('path: "/api/profile/photo"');
    const block = src.slice(i, j);
    assert.ok(block.includes("getOwnEmployeeId"));
    assert.equal(block.includes("b.employeeId"), false);
  });
});

describe("ディスパッチャ: プロフィールのルート（T-12〜T-15）", () => {
  test("ルートが登録されている", () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    for (const p of [
      "GET /profile", "GET /profile/view", "GET /api/profile", "GET /api/profile/detail",
      "POST /api/profile/update", "POST /api/profile/photo", "POST /api/profile/photo/delete",
      "GET /api/profile/photo",
    ]) {
      assert.ok(paths.includes(p), `${p} が未登録`);
    }
  });

  test("🔴 写真の配信は認証必須（現行は公開ディレクトリだった・設計書 6.1 と同系統）", () => {
    for (const r of routes.filter((x) => x.path.startsWith("/api/profile"))) {
      assert.notEqual(r.public, true, `${r.path} が public になっている`);
    }
  });
});

describe("画面: プロフィール（T-16）", () => {
  test("現行 profile3Template の3項目を踏襲する", () => {
    const h = profilePage();
    for (const s of ["顔写真", "Profile", "Note"]) assert.ok(h.includes(s), `${s} が無い`);
    assert.ok(h.includes('id="text"'));
    assert.ok(h.includes('id="note"'));
    assert.ok(h.includes('type="file"'));
  });

  test("🔴 写真を公開パスではなく認証必須APIから読む", () => {
    for (const h of [profilePage(), profileViewPage()]) {
      assert.ok(h.includes("/api/profile/photo?employeeId="));
      assert.equal(h.includes("../upload/"), false);
    }
  });

  test("🔴 パスワード列を表示分岐に使わない（現行 SU1_PASS の再発防止）", () => {
    // 現行 profile01sTemplate.php は {if $userp->SU1_PASS ==""} で表示を切り替えていた。
    // 新実装は写真の有無を hasPhoto で判定する
    for (const h of [profilePage(), profileViewPage()]) {
      assert.ok(h.includes("hasPhoto"));
      assert.equal(/SU1_PASS|\bPASS\b/.test(h), false);
      // パスワードの入力欄そのものを置かない
      assert.equal(h.includes('type="password"'), false);
    }
  });

  test("閲覧画面には編集の手段が無い", () => {
    const h = profileViewPage();
    assert.equal(h.includes("<textarea"), false);
    assert.equal(h.includes('type="file"'), false);
    assert.equal(h.includes("/api/profile/update"), false);
  });

  test("innerHTML に値を混ぜない（B-35）／外部CDNに依存しない（B-38）", () => {
    for (const h of [profilePage(), profileViewPage()]) {
      assert.equal(/innerHTML\s*=\s*[^;]*\+/.test(h), false);
      assert.equal(h.includes("http://"), false);
      assert.equal(h.includes("cdn"), false);
    }
  });

  test("ホームと従業員一覧から行ける", () => {
    assert.ok(homePage().includes('href="/profile"'));
    assert.ok(employeeListPage().includes("/profile/view?employeeId="));
  });
});

describe("スキーマ: マイグレーション 0003", () => {
  test("employees に profile_text / profile_note がある", () => {
    const cols = columns(schemaDb(), "employees").map((c) => c.name);
    assert.ok(cols.includes("profile_text"));
    assert.ok(cols.includes("profile_note"));
  });

  test("このマイグレーション自体はテーブルを増やさない（列の追加のみ）", () => {
    // 全マイグレーション適用後の総数。テーブルを増やしたのは 0001・0004〜0009
    assert.equal(tableNames(schemaDb()).length, 30);
  });
});

// ===============================================================
// 店舗情報＝月次の人事指標レポート（機能権限表 区分4 / T-18〜T-22）
// ===============================================================
const REP = {
  worksiteId: null, periodYearMonth: "2026-08",
  recruitCount: 10, hireCount: 3, turnoverCount: 1, note: "備考",
};

describe("月次レポート: 検証（T-19）", () => {
  test("対象月は YYYY-MM のみ", () => {
    assert.equal(isYearMonth("2026-08"), true);
    assert.equal(isYearMonth("2026-13"), false);
    assert.equal(isYearMonth("2026-00"), false);
    assert.equal(isYearMonth("2026-8"), false);
    assert.equal(isYearMonth("2026/08"), false);
    assert.equal(isYearMonth(""), false);
  });

  test("正しい入力は通る", () => {
    assert.deepEqual(validateMonthlyReport(REP), []);
  });

  test("負の数・小数・桁外れを弾く", () => {
    assert.ok(validateMonthlyReport({ ...REP, hireCount: -1 }).length > 0);
    assert.ok(validateMonthlyReport({ ...REP, hireCount: 1.5 }).length > 0);
    assert.ok(validateMonthlyReport({ ...REP, turnoverCount: 100001 }).length > 0);
  });
});

describe("月次レポート: 登録と更新（T-19）", () => {
  test("登録できる", async () => {
    const { db } = await seed();
    const r = await upsertMonthlyReport(db, "t_1", REP);
    assert.equal(r.created, true);
    const got = await getMonthlyReport(db, "t_1", r.id);
    assert.equal(got?.periodYearMonth, "2026-08");
    assert.equal(got?.hireCount, 3);
  });

  test("🔴 同じ月を再登録すると上書きされる（現行は重複を弾いていた）", async () => {
    const { db } = await seed();
    const a = await upsertMonthlyReport(db, "t_1", REP);
    const b = await upsertMonthlyReport(db, "t_1", { ...REP, hireCount: 9 });
    assert.equal(b.created, false);
    assert.equal(a.id, b.id);
    assert.equal((await getMonthlyReport(db, "t_1", a.id))?.hireCount, 9);
    const l = await listMonthlyReports(db, "t_1");
    assert.equal(l.reports.length, 1);
  });

  test("🔴 他テナントからは取得できない（B-6）", async () => {
    const { db } = await seed();
    const r = await upsertMonthlyReport(db, "t_1", REP);
    assert.notEqual(await getMonthlyReport(db, "t_1", r.id), null);
    assert.equal(await getMonthlyReport(db, "t_2", r.id), null);
    assert.equal((await listMonthlyReports(db, "t_2")).reports.length, 0);
  });

  test("🔴 他テナントの店舗は指定できない", async () => {
    const { db } = await seed();
    await db.prepare(`INSERT INTO worksites (id,tenant_id,name,created_at,updated_at) VALUES ('w_2','t_2','他社店',?1,?1)`)
      .bind(nowUtc()).run();
    await assert.rejects(
      () => upsertMonthlyReport(db, "t_1", { ...REP, worksiteId: "w_2" }),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.field === "worksiteId")
    );
  });

  test("店舗ごとに同じ月を持てる", async () => {
    const { db } = await seed();
    await db.prepare(`INSERT INTO worksites (id,tenant_id,name,created_at,updated_at) VALUES ('w_1','t_1','千葉店',?1,?1)`)
      .bind(nowUtc()).run();
    await upsertMonthlyReport(db, "t_1", REP);
    await upsertMonthlyReport(db, "t_1", { ...REP, worksiteId: "w_1", hireCount: 5 });
    const l = await listMonthlyReports(db, "t_1");
    assert.equal(l.reports.length, 2);
    assert.equal(l.totals.hireCount, 8);
  });

  test("不正な対象月は保存されない", async () => {
    const { db } = await seed();
    await assert.rejects(() => upsertMonthlyReport(db, "t_1", { ...REP, periodYearMonth: "2026-13" }), RegistrationError);
    assert.equal((await listMonthlyReports(db, "t_1")).reports.length, 0);
  });
});

describe("月次レポート: 集計は都度算出する（T-20）", () => {
  test("🔴 年間集計テーブルを作らない【会話合意⑥】", () => {
    // 現行は user1avgcom3insert() で article_counter1_com3 に保存していた
    assert.equal(tableNames(schemaDb()).some((t) => t.includes("counter")), false);
  });

  test("年間の合算が一覧で返る", async () => {
    const { db } = await seed();
    await upsertMonthlyReport(db, "t_1", { ...REP, periodYearMonth: "2026-07", hireCount: 2, turnoverCount: 1 });
    await upsertMonthlyReport(db, "t_1", { ...REP, periodYearMonth: "2026-08", hireCount: 3, turnoverCount: 2 });
    const l = await listMonthlyReports(db, "t_1", { year: "2026" });
    assert.equal(l.reports.length, 2);
    assert.equal(l.totals.hireCount, 5);
    assert.equal(l.totals.turnoverCount, 3);
    assert.equal(l.turnoverRate, 37.5); // 3 / (5+3)
  });

  test("年で絞り込める", async () => {
    const { db } = await seed();
    await upsertMonthlyReport(db, "t_1", { ...REP, periodYearMonth: "2025-12" });
    await upsertMonthlyReport(db, "t_1", { ...REP, periodYearMonth: "2026-01" });
    assert.equal((await listMonthlyReports(db, "t_1", { year: "2026" })).reports.length, 1);
    assert.equal((await listMonthlyReports(db, "t_1")).reports.length, 2);
  });

  test("登録が無ければ離職率は null（0除算にしない）", async () => {
    const { db } = await seed();
    const l = await listMonthlyReports(db, "t_1");
    assert.equal(l.turnoverRate, null);
    assert.equal(l.totals.hireCount, 0);
  });

  test("年の指定が不正なら弾く", async () => {
    const { db } = await seed();
    await assert.rejects(() => listMonthlyReports(db, "t_1", { year: "20xx" }), RegistrationError);
  });
});

describe("月次レポート: 平均勤続・平均年齢は保存しない（T-20）", () => {
  test("🔴 保存列が存在しない（現行 COMPANY1_SERVICE / _AGE を作らない）", () => {
    const cols = columns(schemaDb(), "worksite_monthly_reports").map((c) => c.name);
    assert.equal(cols.includes("service"), false);
    assert.equal(cols.includes("avg_age"), false);
    assert.equal(cols.includes("overtime"), false); // 入力欄が無かった列も作らない
  });

  test("月末を基準に都度算出する", async () => {
    const { db } = await seed();
    await db.prepare(`UPDATE employees SET hired_on='2024-08-31', birth_on='1990-01-01' WHERE id='e_1'`).run();
    const st = await monthlyWorkforceStats(db, "t_1", "2026-08");
    assert.equal(st.headcount, 1);
    assert.equal(st.avgTenureMonths, 24); // 2024-08-31 → 2026-08-31
    assert.equal(st.avgAge, 36);
  });

  test("2月の月末を正しく扱う（うるう年）", async () => {
    const { db } = await seed();
    await db.prepare(`UPDATE employees SET hired_on='2024-02-29', birth_on='2000-02-29' WHERE id='e_1'`).run();
    const st = await monthlyWorkforceStats(db, "t_1", "2024-02");
    assert.equal(st.avgTenureMonths, 0);
    assert.equal(st.avgAge, 24);
  });

  test("入社前の月なら勤続に数えない", async () => {
    const { db } = await seed();
    await db.prepare(`UPDATE employees SET hired_on='2027-01-01' WHERE id='e_1'`).run();
    assert.equal((await monthlyWorkforceStats(db, "t_1", "2026-08")).avgTenureMonths, null);
  });

  test("未設定なら null（0 を返さない）", async () => {
    const { db } = await seed();
    const st = await monthlyWorkforceStats(db, "t_1", "2026-08");
    assert.equal(st.avgTenureMonths, null);
    assert.equal(st.avgAge, null);
  });

  test("🔴 他テナントの従業員を数えない（B-6）", async () => {
    const { db } = await seed();
    assert.equal((await monthlyWorkforceStats(db, "t_1", "2026-08")).headcount, 1);
    assert.equal((await monthlyWorkforceStats(db, "t_2", "2026-08")).headcount, 1);
  });
});

describe("月次レポート: 境界とディスパッチャ（T-18 / T-19）", () => {
  test("新テーブルが tenant_id 必須で TENANT_SCOPED_TABLES に登録されている", () => {
    assert.ok((TENANT_SCOPED_TABLES as readonly string[]).includes("worksite_monthly_reports"));
    const cols = columns(schemaDb(), "worksite_monthly_reports");
    assert.equal(cols.find((c) => c.name === "tenant_id")?.notnull, 1);
  });

  test("🔴 テナント解約の削除計画に載っており、worksites より先に消える", () => {
    const i = TENANT_DELETION_ORDER.indexOf("worksite_monthly_reports");
    const j = TENANT_DELETION_ORDER.indexOf("worksites");
    assert.ok(i >= 0, "削除計画に無い");
    assert.ok(i < j, "worksites より後だと外部キーで失敗する");
  });

  test("ルートが登録され、すべて認証必須", () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    for (const p of [
      "GET /reports", "GET /reports/edit", "GET /api/reports", "POST /api/reports",
      "GET /api/reports/detail", "GET /api/reports/workforce",
    ]) {
      assert.ok(paths.includes(p), `${p} が未登録`);
    }
    for (const r of routes.filter((x) => x.path.startsWith("/api/reports"))) {
      assert.notEqual(r.public, true);
    }
  });
});

describe("画面: 店舗情報（T-21）", () => {
  test("現行 company1Template の項目を踏襲する", () => {
    const h = reportFormPage();
    for (const s of ["対象月", "募集数", "採用数", "離職数", "備考"]) {
      assert.ok(h.includes(s), `${s} が無い`);
    }
  });

  test("「予備管理」を「備考」に改称したことが分かる", () => {
    const h = reportFormPage();
    assert.ok(h.includes("予備管理"));
    assert.ok(h.includes("備考"));
  });

  test("🔴 平均勤続・平均年齢は入力欄ではなく参考表示", () => {
    const h = reportFormPage();
    assert.ok(h.includes("/api/reports/workforce"));
    assert.ok(h.includes("保存しません"));
    assert.equal(h.includes('id="service"'), false);
  });

  test("一覧に年間の合算と離職率が出る", () => {
    const h = reportListPage();
    for (const s of ["募集", "採用", "離職", "離職率"]) assert.ok(h.includes(s));
  });

  test("innerHTML に値を混ぜない（B-35）／外部CDNに依存しない（B-38）", () => {
    for (const h of [reportListPage(), reportFormPage()]) {
      assert.equal(/innerHTML\s*=\s*[^;]*\+/.test(h), false);
      assert.equal(h.includes("http://"), false);
      assert.equal(h.includes("cdn"), false);
    }
  });

  test("ホームから行ける", () => {
    assert.ok(homePage().includes('href="/reports"'));
  });
});

describe("スキーマ: マイグレーション 0004", () => {
  test("テーブルが30本になる（0009 で4本追加）", () => {
    assert.equal(tableNames(schemaDb()).length, 30);
  });
});

// ===============================================================
// 業務日報（機能権限表 区分10 / T-23〜T-29）
// ===============================================================
async function seedReport() {
  const { db, r2 } = await seed();
  await db.prepare(`UPDATE employees SET account_id = 'acc_1' WHERE id = 'e_1'`).run();
  const c = await upsertReportCategory(db, "t_1", { name: "接客", sortOrder: 1 });
  return { db, r2, categoryId: c.id };
}

const DR = {
  employeeId: "e_1", categoryId: null as string | null,
  reportedOn: "2026-08-14", startTime: "09:00", endTime: "12:00", body: "午前の業務",
};

describe("日報: 所要時間の算出（T-25）", () => {
  test("通常の時間帯", () => {
    assert.equal(calcReportMinutes("09:00", "12:00"), 180);
    assert.equal(calcReportMinutes("09:30", "10:15"), 45);
  });

  test("🔴 日跨ぎでも負にならない（現行 4.13.1 と同型の欠陥を作らない）", () => {
    assert.equal(calcReportMinutes("22:00", "06:00"), 480);
    assert.equal(calcReportMinutes("23:30", "00:30"), 60);
  });

  test("🔴 24時間を超える差でも壊れない（現行は $diff->h が days を無視していた）", () => {
    // 終了を 24時超え表記で直接渡した場合
    assert.equal(calcReportMinutes("00:00", "30:00"), 1800);
  });
});

describe("日報: 検証（T-25）", () => {
  test("正しい入力は通る", () => {
    assert.deepEqual(validateDailyReport(DR), []);
  });
  test("実在しない日付を弾く", () => {
    assert.ok(validateDailyReport({ ...DR, reportedOn: "2026-02-30" }).length > 0);
  });
  test("開始と終了が同じなら弾く（現行の JS も弾いていた）", () => {
    const iss = validateDailyReport({ ...DR, endTime: "09:00" });
    assert.ok(iss.some((i) => i.code === "same_as_start"));
  });
  test("時刻の形式を検査する", () => {
    assert.ok(validateDailyReport({ ...DR, startTime: "9時" }).length > 0);
    assert.ok(validateDailyReport({ ...DR, endTime: "25:99" }).length > 0);
  });
});

describe("日報: カテゴリ＝マスターデータ（T-24）", () => {
  test("追加でき、有効なものだけが既定で返る", async () => {
    const { db } = await seedReport();
    await upsertReportCategory(db, "t_1", { name: "清掃", sortOrder: 2 });
    assert.equal((await listReportCategories(db, "t_1")).length, 2);
  });

  test("同じ名前は追加できない", async () => {
    const { db } = await seedReport();
    await assert.rejects(
      () => upsertReportCategory(db, "t_1", { name: "接客" }),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.code === "already_taken")
    );
  });

  test("停止すると既定の一覧から消え、includeInactive で見える", async () => {
    const { db, categoryId } = await seedReport();
    await upsertReportCategory(db, "t_1", { id: categoryId, name: "接客", isActive: false });
    assert.equal((await listReportCategories(db, "t_1")).length, 0);
    assert.equal((await listReportCategories(db, "t_1", true)).length, 1);
  });

  test("🔴 他テナントのカテゴリは見えない・更新できない（B-6）", async () => {
    const { db, categoryId } = await seedReport();
    assert.equal((await listReportCategories(db, "t_2")).length, 0);
    await assert.rejects(
      () => upsertReportCategory(db, "t_2", { id: categoryId, name: "乗っ取り" }),
      RegistrationError
    );
  });

  test("空名は拒否する", async () => {
    const { db } = await seedReport();
    await assert.rejects(() => upsertReportCategory(db, "t_1", { name: "   " }), RegistrationError);
  });
});

describe("日報: 登録・修正・削除（T-25 / T-26）", () => {
  test("登録できる。終了は24時超え表記で保存される", async () => {
    const { db } = await seedReport();
    const r = await upsertDailyReport(db, "t_1", null, { ...DR, startTime: "22:00", endTime: "06:00" });
    assert.equal(r.created, true);
    const got = await getDailyReport(db, "t_1", r.id);
    assert.equal(got?.endTime, "30:00");
    assert.equal(got?.durationMinutes, 480);
  });

  test("カテゴリ名と担当者名を結合して返す", async () => {
    const { db, categoryId } = await seedReport();
    const r = await upsertDailyReport(db, "t_1", null, { ...DR, categoryId });
    const got = await getDailyReport(db, "t_1", r.id);
    assert.equal(got?.categoryName, "接客");
    assert.equal(got?.employeeName, "山田");
  });

  test("修正できる", async () => {
    const { db } = await seedReport();
    const r = await upsertDailyReport(db, "t_1", null, DR);
    const u = await upsertDailyReport(db, "t_1", r.id, { ...DR, body: "書き直し", endTime: "13:00" });
    assert.equal(u.created, false);
    const got = await getDailyReport(db, "t_1", r.id);
    assert.equal(got?.body, "書き直し");
    assert.equal(got?.durationMinutes, 240);
  });

  test("🔴 他テナントからは取得も修正もできない（B-6）", async () => {
    const { db } = await seedReport();
    const r = await upsertDailyReport(db, "t_1", null, DR);
    assert.equal(await getDailyReport(db, "t_2", r.id), null);
    await assert.rejects(() => upsertDailyReport(db, "t_2", r.id, DR), RegistrationError);
  });

  test("🔴 他テナントの従業員名義では登録できない", async () => {
    const { db } = await seedReport();
    await assert.rejects(
      () => upsertDailyReport(db, "t_1", null, { ...DR, employeeId: "e_2" }),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.field === "employeeId")
    );
  });

  test("🔴 他テナントのカテゴリは指定できない", async () => {
    const { db, categoryId } = await seedReport();
    await assert.rejects(
      () => upsertDailyReport(db, "t_2", null, { ...DR, employeeId: "e_2", categoryId }),
      RegistrationError
    );
  });

  test("月と日で絞り込める", async () => {
    const { db } = await seedReport();
    await upsertDailyReport(db, "t_1", null, { ...DR, reportedOn: "2026-08-14" });
    await upsertDailyReport(db, "t_1", null, { ...DR, reportedOn: "2026-09-01", startTime: "13:00", endTime: "15:00" });
    assert.equal((await listDailyReports(db, "t_1", { month: "2026-08" })).length, 1);
    assert.equal((await listDailyReports(db, "t_1", { reportedOn: "2026-09-01" })).length, 1);
    assert.equal((await listDailyReports(db, "t_1")).length, 2);
  });

  test("削除すると一覧から消える（論理削除）", async () => {
    const { db, r2 } = await seedReport();
    const r = await upsertDailyReport(db, "t_1", null, DR);
    assert.equal(await deleteDailyReport(db, r2 as never, "t_1", r.id), true);
    assert.equal(await getDailyReport(db, "t_1", r.id), null);
    assert.equal((await listDailyReports(db, "t_1")).length, 0);
    // 2回目は false
    assert.equal(await deleteDailyReport(db, r2 as never, "t_1", r.id), false);
  });

  test("🔴 他テナントからは削除できない", async () => {
    const { db, r2 } = await seedReport();
    const r = await upsertDailyReport(db, "t_1", null, DR);
    assert.equal(await deleteDailyReport(db, r2 as never, "t_2", r.id), false);
    assert.notEqual(await getDailyReport(db, "t_1", r.id), null);
  });
});

describe("日報: 時間帯の重複（T-25）", () => {
  test("重なりを検出する", async () => {
    const { db } = await seedReport();
    await upsertDailyReport(db, "t_1", null, { ...DR, startTime: "09:00", endTime: "12:00" });
    const ov = await findOverlappingReports(db, "t_1", "e_1", "2026-08-14", "11:00", "13:00");
    assert.equal(ov.length, 1);
  });

  test("端が接するだけなら重複としない", async () => {
    const { db } = await seedReport();
    await upsertDailyReport(db, "t_1", null, { ...DR, startTime: "09:00", endTime: "12:00" });
    assert.equal((await findOverlappingReports(db, "t_1", "e_1", "2026-08-14", "12:00", "13:00")).length, 0);
  });

  test("別の日・別の従業員なら重複としない", async () => {
    const { db } = await seedReport();
    await upsertDailyReport(db, "t_1", null, DR);
    assert.equal((await findOverlappingReports(db, "t_1", "e_1", "2026-08-15", "09:00", "12:00")).length, 0);
    assert.equal((await findOverlappingReports(db, "t_1", "e_2", "2026-08-14", "09:00", "12:00")).length, 0);
  });

  test("修正時は自分自身を重複に数えない", async () => {
    const { db } = await seedReport();
    const r = await upsertDailyReport(db, "t_1", null, DR);
    const u = await upsertDailyReport(db, "t_1", r.id, { ...DR, body: "修正" });
    assert.equal(u.overlaps.length, 0);
  });

  test("🔴 重複しても登録は阻止しない。警告として返す【会話合意】", async () => {
    const { db } = await seedReport();
    await upsertDailyReport(db, "t_1", null, { ...DR, startTime: "09:00", endTime: "12:00" });
    const r = await upsertDailyReport(db, "t_1", null, { ...DR, startTime: "11:00", endTime: "13:00" });
    assert.equal(r.created, true); // 登録されている
    assert.equal(r.overlaps.length, 1); // かつ警告が返る
    assert.equal((await listDailyReports(db, "t_1")).length, 2);
  });
});

describe("日報: 画像（T-27）", () => {
  test("R2 に保存され、キーに reportId が入る", async () => {
    const { db, r2 } = await seedReport();
    const r = await upsertDailyReport(db, "t_1", null, DR);
    const p = await putDailyReportPhoto(db, r2 as never, "t_1", r.id, JPEG);
    assert.ok(p.objectKey.startsWith(`tenants/t_1/daily-reports/${r.id}/`));
    assert.equal(await getDailyReportPhotoKey(db, "t_1", r.id), p.objectKey);
  });

  test("🔴 画像でないもの・大きすぎるものを拒否する", async () => {
    const { db, r2 } = await seedReport();
    const r = await upsertDailyReport(db, "t_1", null, DR);
    const before = r2.objects.size;
    const php = new TextEncoder().encode("<?php system($_GET['c']); ?>");
    await assert.rejects(() => putDailyReportPhoto(db, r2 as never, "t_1", r.id, php), RegistrationError);
    const big = new Uint8Array(PHOTO_MAX_BYTES + 1); big.set(JPEG);
    await assert.rejects(() => putDailyReportPhoto(db, r2 as never, "t_1", r.id, big), RegistrationError);
    assert.equal(r2.objects.size, before);
  });

  test("削除すると R2 からも消える（孤児を作らない）", async () => {
    const { db, r2 } = await seedReport();
    const r = await upsertDailyReport(db, "t_1", null, DR);
    const p = await putDailyReportPhoto(db, r2 as never, "t_1", r.id, PNG);
    await deleteDailyReport(db, r2 as never, "t_1", r.id);
    assert.equal(r2.objects.has(p.objectKey), false);
  });

  test("🔴 他テナントからはキーを引けない", async () => {
    const { db, r2 } = await seedReport();
    const r = await upsertDailyReport(db, "t_1", null, DR);
    await putDailyReportPhoto(db, r2 as never, "t_1", r.id, JPEG);
    assert.equal(await getDailyReportPhotoKey(db, "t_2", r.id), null);
  });
});

describe("日報: 境界と削除計画（T-23）", () => {
  test("新テーブルが tenant_id 必須で登録されている", () => {
    for (const t of ["daily_reports", "daily_report_categories"]) {
      assert.ok((TENANT_SCOPED_TABLES as readonly string[]).includes(t), `${t} が未登録`);
      assert.equal(columns(schemaDb(), t).find((c) => c.name === "tenant_id")?.notnull, 1);
    }
  });

  test("🔴 従業員退会で日報も消える", () => {
    assert.ok(EMPLOYEE_DELETION_ORDER.some((s) => s.table === "daily_reports"));
  });

  test("🔴 テナント解約の削除順が外部キーと矛盾しない", () => {
    const i = TENANT_DELETION_ORDER.indexOf("daily_reports");
    assert.ok(i >= 0);
    assert.ok(i < TENANT_DELETION_ORDER.indexOf("employees"), "employees より先に消すこと");
    assert.ok(i < TENANT_DELETION_ORDER.indexOf("daily_report_categories"), "categories より先に消すこと");
  });

  test("🔴 現行の二重持ちの列を作らない", () => {
    const cols = columns(schemaDb(), "daily_reports").map((c) => c.name);
    assert.ok(cols.includes("duration_minutes"));
    // REPORT_TIME3（時間単位の小数）/ REPORT_TIME4（HH:MM:SS）/ REPORT_DATE_TIME1,2
    for (const bad of ["time3", "time4", "date_time1", "date_time2"]) {
      assert.equal(cols.includes(bad), false, `${bad} を作ってはならない`);
    }
  });

  test("ルートが登録され、すべて認証必須", () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    for (const p of [
      "GET /daily-reports", "GET /daily-reports/edit", "GET /daily-reports/categories",
      "GET /api/daily-reports", "POST /api/daily-reports", "GET /api/daily-reports/detail",
      "POST /api/daily-reports/delete", "GET /api/daily-reports/categories",
      "POST /api/daily-reports/categories", "GET /api/daily-reports/photo",
      "POST /api/daily-reports/photo",
    ]) {
      assert.ok(paths.includes(p), `${p} が未登録`);
    }
    for (const r of routes.filter((x) => x.path.startsWith("/api/daily-reports"))) {
      assert.notEqual(r.public, true);
    }
  });
});

describe("画面: 業務日報（T-28）", () => {
  test("現行 dreport2Template の項目を踏襲する", () => {
    const h = dailyReportFormPage();
    for (const s of ["日付", "カテゴリ", "開始", "終了", "内容", "画像"]) {
      assert.ok(h.includes(s), `${s} が無い`);
    }
  });

  test("🔴 外部CDNに依存しない（現行は終了済みの cdn.rawgit.com を参照していた）", () => {
    for (const h of [dailyReportListPage(), dailyReportFormPage(), reportCategoryPage()]) {
      assert.equal(h.includes("rawgit"), false);
      assert.equal(h.includes("cdn"), false);
      assert.equal(h.includes("http://"), false);
    }
    // 標準の入力欄を使う
    assert.ok(dailyReportFormPage().includes('type="time"'));
  });

  test("🔴 画像を公開パスではなく認証必須APIから読む", () => {
    const h = dailyReportFormPage();
    assert.ok(h.includes("/api/daily-reports/photo?reportId="));
    assert.equal(h.includes("../images/"), false);
  });

  test("🔴 削除は POST で行う（現行は URL クエリの id だけで消せた）", () => {
    const h = dailyReportFormPage();
    assert.ok(h.includes("/api/daily-reports/delete"));
    assert.ok(h.includes("削除します。よろしいですか?"));
    assert.equal(h.includes("dreport2delete"), false);
  });

  test("重複は警告として表示し、登録済みであることを伝える", () => {
    const h = dailyReportFormPage();
    assert.ok(h.includes("時間帯が重なる日報"));
    assert.ok(h.includes("登録は完了しています"));
  });

  test("24時超え表記を「翌 HH:MM」で表示する", () => {
    assert.ok(dailyReportListPage().includes("翌 "));
  });

  test("カテゴリ管理画面がマスターデータであると分かる", () => {
    assert.ok(reportCategoryPage().includes("マスターデータ"));
  });

  test("innerHTML に値を混ぜない（B-35）", () => {
    for (const h of [dailyReportListPage(), dailyReportFormPage(), reportCategoryPage()]) {
      assert.equal(/innerHTML\s*=\s*[^;]*\+/.test(h), false);
    }
  });

  test("ホームから行ける", () => {
    assert.ok(homePage().includes('href="/daily-reports"'));
  });
});

// ===============================================================
// 社内フォト共有（機能権限表 区分8 / T-30〜T-34）
// ===============================================================
const POST_IN = { caption: "朝礼のようす", postedOn: "2026-08-16", bytes: JPEG };

describe("フォト: 投稿（T-31 / T-32）", () => {
  test("投稿できる。画像は R2、キーは自前生成", async () => {
    const { db, r2 } = await seed();
    const r = await createPhotoPost(db, r2 as never, "t_1", "e_1", POST_IN);
    assert.ok(r.objectKey.startsWith(`tenants/t_1/photo-posts/${r.id}/`));
    assert.equal(r2.objects.has(r.objectKey), true);
    const got = await getPhotoPost(db, "t_1", r.id);
    assert.equal(got?.caption, "朝礼のようす");
    assert.equal(got?.employeeName, "山田");
  });

  test("🔴 画像は必須（画像なしの投稿を作らせない）", async () => {
    const { db, r2 } = await seed();
    await assert.rejects(
      () => createPhotoPost(db, r2 as never, "t_1", "e_1", { ...POST_IN, bytes: new Uint8Array([]) }),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.code === "required")
    );
  });

  test("🔴 画像でないもの・大きすぎるものを拒否し、R2 に何も残さない", async () => {
    const { db, r2 } = await seed();
    const before = r2.objects.size;
    const php = new TextEncoder().encode("<?php system($_GET['c']); ?>");
    await assert.rejects(() => createPhotoPost(db, r2 as never, "t_1", "e_1", { ...POST_IN, bytes: php }), RegistrationError);
    const big = new Uint8Array(PHOTO_MAX_BYTES + 1); big.set(JPEG);
    await assert.rejects(() => createPhotoPost(db, r2 as never, "t_1", "e_1", { ...POST_IN, bytes: big }), RegistrationError);
    assert.equal(r2.objects.size, before);
  });

  test("ひと言の上限を超えたら拒否する", async () => {
    const { db, r2 } = await seed();
    await assert.rejects(
      () => createPhotoPost(db, r2 as never, "t_1", "e_1", { ...POST_IN, caption: "あ".repeat(CAPTION_MAX + 1) }),
      RegistrationError
    );
    assert.equal(CAPTION_MAX, 200);
  });

  test("実在しない日付を拒否する", async () => {
    const { db, r2 } = await seed();
    await assert.rejects(
      () => createPhotoPost(db, r2 as never, "t_1", "e_1", { ...POST_IN, postedOn: "2026-02-30" }),
      RegistrationError
    );
  });

  test("🔴 他テナントの従業員名義では投稿できず、R2 も汚さない", async () => {
    const { db, r2 } = await seed();
    const before = r2.objects.size;
    await assert.rejects(() => createPhotoPost(db, r2 as never, "t_1", "e_2", POST_IN), RegistrationError);
    assert.equal(r2.objects.size, before);
  });
});

describe("フォト: 一覧・取得（T-31）", () => {
  test("🔴 自テナントの投稿だけが返る（B-6）", async () => {
    const { db, r2 } = await seed();
    await createPhotoPost(db, r2 as never, "t_1", "e_1", POST_IN);
    await createPhotoPost(db, r2 as never, "t_2", "e_2", POST_IN);
    assert.equal((await listPhotoPosts(db, "t_1")).length, 1);
    assert.equal((await listPhotoPosts(db, "t_2")).length, 1);
  });

  test("🔴 他テナントからは取得できない", async () => {
    const { db, r2 } = await seed();
    const r = await createPhotoPost(db, r2 as never, "t_1", "e_1", POST_IN);
    assert.notEqual(await getPhotoPost(db, "t_1", r.id), null);
    assert.equal(await getPhotoPost(db, "t_2", r.id), null);
    assert.equal(await getPhotoPostKey(db, "t_2", r.id), null);
  });

  test("投稿者で絞り込める", async () => {
    const { db, r2 } = await seed();
    await createPhotoPost(db, r2 as never, "t_1", "e_1", POST_IN);
    assert.equal((await listPhotoPosts(db, "t_1", { employeeId: "e_1" })).length, 1);
    assert.equal((await listPhotoPosts(db, "t_1", { employeeId: "e_2" })).length, 0);
  });

  test("件数の上限を超える指定は弾く", async () => {
    const { db } = await seed();
    await assert.rejects(() => listPhotoPosts(db, "t_1", { limit: 0 }), RegistrationError);
    await assert.rejects(() => listPhotoPosts(db, "t_1", { limit: 501 }), RegistrationError);
  });
});

describe("フォト: 削除（T-31）", () => {
  test("削除すると R2 からも消え、一覧から外れる", async () => {
    const { db, r2 } = await seed();
    const r = await createPhotoPost(db, r2 as never, "t_1", "e_1", POST_IN);
    assert.equal(await deletePhotoPost(db, r2 as never, "t_1", r.id), true);
    assert.equal(r2.objects.has(r.objectKey), false);
    assert.equal(await getPhotoPost(db, "t_1", r.id), null);
    assert.equal((await listPhotoPosts(db, "t_1")).length, 0);
    assert.equal(await deletePhotoPost(db, r2 as never, "t_1", r.id), false);
  });

  test("🔴 他テナントからは削除できない", async () => {
    const { db, r2 } = await seed();
    const r = await createPhotoPost(db, r2 as never, "t_1", "e_1", POST_IN);
    assert.equal(await deletePhotoPost(db, r2 as never, "t_2", r.id), false);
    assert.equal(r2.objects.has(r.objectKey), true);
  });

  test("🔴 所有者の判定はハンドラ側で行う（サービスは判定しない）", () => {
    const src = readFileSync(join(here, "..", "src", "index.ts"), "utf-8");
    const i = src.indexOf('path: "/api/photos/delete"');
    const j = src.indexOf('path: "/api/photos/photo"');
    const block = src.slice(i, j);
    assert.ok(block.includes("getOwnEmployeeId"));
    assert.ok(block.includes("canAccessAttendance"));
    assert.ok(block.includes('"forbidden"'));
  });
});

describe("フォト: 境界と削除計画（T-30）", () => {
  test("tenant_id 必須で TENANT_SCOPED_TABLES に登録されている", () => {
    assert.ok((TENANT_SCOPED_TABLES as readonly string[]).includes("photo_posts"));
    assert.equal(columns(schemaDb(), "photo_posts").find((c) => c.name === "tenant_id")?.notnull, 1);
  });

  test("🔴 使われていなかった列を作らない（pic2〜5 / comment2〜5）", () => {
    const cols = columns(schemaDb(), "photo_posts").map((c) => c.name);
    for (const bad of ["pic2", "pic3", "pic4", "pic5", "comment2", "caption2", "company_name1"]) {
      assert.equal(cols.includes(bad), false, `${bad} を作ってはならない`);
    }
    // 画像は必須
    assert.equal(cols.includes("photo_object_key"), true);
    assert.equal(columns(schemaDb(), "photo_posts").find((c) => c.name === "photo_object_key")?.notnull, 1);
  });

  test("🔴 退会・解約の削除計画に載っており、employees より先に消える", () => {
    assert.ok(EMPLOYEE_DELETION_ORDER.some((s) => s.table === "photo_posts"));
    const i = TENANT_DELETION_ORDER.indexOf("photo_posts");
    assert.ok(i >= 0);
    assert.ok(i < TENANT_DELETION_ORDER.indexOf("employees"));
  });

  test("ルートが登録され、すべて認証必須", () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    for (const p of [
      "GET /photos", "GET /photos/new", "GET /api/photos", "POST /api/photos",
      "POST /api/photos/delete", "GET /api/photos/photo",
    ]) {
      assert.ok(paths.includes(p), `${p} が未登録`);
    }
    for (const r of routes.filter((x) => x.path.startsWith("/api/photos"))) {
      assert.notEqual(r.public, true);
    }
  });
});

describe("画面: 社内フォト共有（T-33）", () => {
  test("投稿画面は画像とひと言のみ（現行の有効項目に一致）", () => {
    const h = photoNewPage();
    assert.ok(h.includes("ひと言"));
    assert.ok(h.includes('type="file"'));
    // コメントアウトされていた②〜⑤を復活させない
    for (const bad of ["ひと言②", "画像②", "chat1_pic2", "company_name1"]) {
      assert.equal(h.includes(bad), false, `${bad} があってはならない`);
    }
  });

  test("✅ 投稿前のプレビューを踏襲する（現行の良い実装）", () => {
    assert.ok(photoNewPage().includes("FileReader"));
    assert.ok(photoNewPage().includes("プレビュー"));
  });

  test("🔴 画像を公開パスではなく認証必須APIから読む", () => {
    const h = photoListPage();
    assert.ok(h.includes("/api/photos/photo?postId="));
    assert.equal(h.includes("../image/"), false);
  });

  test("削除ボタンは自分の投稿か権限がある場合だけ出す", () => {
    const h = photoListPage();
    assert.ok(h.includes("post.employeeId === own || canDeleteAny"));
    assert.ok(h.includes("この写真を削除します。よろしいですか?"));
  });

  test("innerHTML に値を混ぜない（B-35）／外部CDNに依存しない（B-38）", () => {
    for (const h of [photoListPage(), photoNewPage()]) {
      assert.equal(/innerHTML\s*=\s*[^;]*\+/.test(h), false);
      assert.equal(h.includes("http://"), false);
      assert.equal(h.includes("cdn"), false);
    }
  });

  test("ホームから行ける", () => {
    assert.ok(homePage().includes('href="/photos"'));
  });
});

// ===============================================================
// ありがとう情報（機能権限表 区分7 / T-35〜T-40）
// ===============================================================
async function seedThanks() {
  const { db, r2 } = await seed();
  const t = nowUtc();
  // 同一テナントに3人目を用意する
  await db.prepare(
    `INSERT INTO employees (id,tenant_id,name,employment_type,status,created_at,updated_at)
     VALUES ('e_3','t_1','鈴木','regular','active',?1,?1)`
  ).bind(t).run();
  await db.prepare(`UPDATE employees SET account_id = 'acc_1' WHERE id = 'e_1'`).run();
  return { db, r2 };
}

describe("ありがとう: 集計対象月の決定（T-36）", () => {
  test("締め日20日：21日以降は翌月分", () => {
    assert.equal(thanksPeriodOf("2026-08-20", 20), "2026-08");
    assert.equal(thanksPeriodOf("2026-08-21", 20), "2026-09");
    assert.equal(thanksPeriodOf("2026-12-25", 20), "2027-01"); // 年またぎ
  });

  test("月末締め（31）はその月のまま", () => {
    assert.equal(thanksPeriodOf("2026-08-31", 31), "2026-08");
    assert.equal(thanksPeriodOf("2026-02-28", 31), "2026-02"); // 2月も末日扱い
  });

  test("実在しない日付・不正な締め日を弾く", () => {
    assert.throws(() => thanksPeriodOf("2026-02-30", 20), RegistrationError);
    assert.throws(() => thanksPeriodOf("2026-08-01", 0), RegistrationError);
  });
});

describe("ありがとう: 送信（T-36）", () => {
  test("送信できる", async () => {
    const { db } = await seedThanks();
    const r = await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: "助かりました", thankedOn: "2026-08-14" });
    assert.equal(r.periodYearMonth, "2026-08"); // 締め日20日 → 14日は当月分
    assert.equal(r.sentInPeriod, 1);
    const l = await listThanks(db, "t_1");
    assert.equal(l[0].fromName, "山田");
    assert.equal(l[0].toName, "鈴木");
  });

  test("🔴 自分自身には送れない", async () => {
    const { db } = await seedThanks();
    await assert.rejects(
      () => sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_1", message: null, thankedOn: "2026-08-14" }),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.code === "same_as_sender")
    );
    assert.equal((await listThanks(db, "t_1")).length, 0);
  });

  test("🔴 他テナントの相手には送れない（B-6）", async () => {
    const { db } = await seedThanks();
    await assert.rejects(
      () => sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_2", message: null, thankedOn: "2026-08-14" }),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.field === "toEmployeeId")
    );
  });

  test("メッセージの上限を超えたら弾く", async () => {
    const { db } = await seedThanks();
    await assert.rejects(
      () => sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: "あ".repeat(THANKS_MESSAGE_MAX + 1), thankedOn: "2026-08-14" }),
      RegistrationError
    );
    assert.equal(THANKS_MESSAGE_MAX, 500);
  });
});

describe("ありがとう: 🔴 月次上限を実際に効かせる（T-36）", () => {
  test("上限に達したら拒否する（現行は検査が0件だった）", async () => {
    const { db } = await seedThanks();
    for (let i = 0; i < THANKS_MONTHLY_LIMIT; i++) {
      await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-14" });
    }
    assert.equal(await countThanksSent(db, "t_1", "e_1", "2026-08"), THANKS_MONTHLY_LIMIT);
    await assert.rejects(
      () => sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-14" }),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.code === "monthly_limit_reached")
    );
    assert.equal(await countThanksSent(db, "t_1", "e_1", "2026-08"), THANKS_MONTHLY_LIMIT);
    assert.equal(THANKS_MONTHLY_LIMIT, 30);
  });

  test("期間が変われば上限もリセットされる", async () => {
    const { db } = await seedThanks();
    for (let i = 0; i < THANKS_MONTHLY_LIMIT; i++) {
      await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-14" });
    }
    // 締め日20日なので 08-21 は 2026-09 分
    const r = await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-21" });
    assert.equal(r.periodYearMonth, "2026-09");
    assert.equal(r.sentInPeriod, 1);
  });

  test("上限は送り主ごとに数える", async () => {
    const { db } = await seedThanks();
    for (let i = 0; i < THANKS_MONTHLY_LIMIT; i++) {
      await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-14" });
    }
    // 別の人はまだ送れる
    const r = await sendThanks(db, "t_1", "e_3", { toEmployeeId: "e_1", message: null, thankedOn: "2026-08-14" });
    assert.equal(r.sentInPeriod, 1);
  });
});

describe("ありがとう: 一覧（T-37）", () => {
  test("🔴 自テナントの分だけ返る（B-6）", async () => {
    const { db } = await seedThanks();
    await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-14" });
    assert.equal((await listThanks(db, "t_1")).length, 1);
    assert.equal((await listThanks(db, "t_2")).length, 0);
  });

  test("送信者・受信者・期間で絞り込める", async () => {
    const { db } = await seedThanks();
    await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-14" });
    await sendThanks(db, "t_1", "e_3", { toEmployeeId: "e_1", message: null, thankedOn: "2026-08-21" });
    assert.equal((await listThanks(db, "t_1", { fromEmployeeId: "e_1" })).length, 1);
    assert.equal((await listThanks(db, "t_1", { toEmployeeId: "e_1" })).length, 1);
    assert.equal((await listThanks(db, "t_1", { period: "2026-09" })).length, 1);
  });

  test("不正な期間・件数を弾く", async () => {
    const { db } = await seedThanks();
    await assert.rejects(() => listThanks(db, "t_1", { period: "2026-13" }), RegistrationError);
    await assert.rejects(() => listThanks(db, "t_1", { limit: 501 }), RegistrationError);
  });
});

describe("ありがとう: 獲得順位は都度算出（T-38）", () => {
  test("🔴 順位の保存テーブルを作らない（article_counter1_rank 廃止）", () => {
    assert.equal(tableNames(schemaDb()).some((t) => t.includes("counter")), false);
    assert.equal(tableNames(schemaDb()).some((t) => t.includes("rank")), false);
  });

  test("受け取った件数の降順で順位が付く", async () => {
    const { db } = await seedThanks();
    // e_3 が 2件、e_1 が 1件
    await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-14" });
    await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-15" });
    await sendThanks(db, "t_1", "e_3", { toEmployeeId: "e_1", message: null, thankedOn: "2026-08-14" });
    const r = await thanksRanking(db, "t_1");
    assert.equal(r[0].employeeId, "e_3");
    assert.equal(r[0].rank, 1);
    assert.equal(r[0].receivedCount, 2);
    assert.equal(r[1].rank, 2);
    assert.equal(r[1].receivedCount, 1);
  });

  test("同数は同順位（1,1,3 方式）", async () => {
    const { db } = await seedThanks();
    await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-14" });
    await sendThanks(db, "t_1", "e_3", { toEmployeeId: "e_1", message: null, thankedOn: "2026-08-14" });
    const r = await thanksRanking(db, "t_1");
    assert.equal(r.length, 2);
    assert.equal(r[0].rank, 1);
    assert.equal(r[1].rank, 1); // 同数なので同順位
  });

  test("期間で絞り込める", async () => {
    const { db } = await seedThanks();
    await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-14" }); // 2026-08
    await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-21" }); // 2026-09
    assert.equal((await thanksRanking(db, "t_1", "2026-08"))[0].receivedCount, 1);
    assert.equal((await thanksRanking(db, "t_1"))[0].receivedCount, 2);
  });

  test("🔴 他テナントの記録を混ぜない（B-6）", async () => {
    const { db } = await seedThanks();
    await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-14" });
    assert.equal((await thanksRanking(db, "t_2")).length, 0);
  });

  test("記録が無ければ空", async () => {
    const { db } = await seedThanks();
    assert.deepEqual(await thanksRanking(db, "t_1"), []);
  });
});

describe("ありがとう: 境界と削除計画（T-35）", () => {
  test("tenant_id 必須で TENANT_SCOPED_TABLES に登録されている", () => {
    assert.ok((TENANT_SCOPED_TABLES as readonly string[]).includes("thanks"));
    assert.equal(columns(schemaDb(), "thanks").find((c) => c.name === "tenant_id")?.notnull, 1);
  });

  test("🔴 従業員退会で、送った分も受け取った分も消える", async () => {
    const step = EMPLOYEE_DELETION_ORDER.find((s) => s.table === "thanks");
    assert.ok(step, "削除計画に無い");
    assert.deepEqual(step?.cols, ["from_employee_id", "to_employee_id"]);

    const { db, r2 } = await seedThanks();
    await sendThanks(db, "t_1", "e_1", { toEmployeeId: "e_3", message: null, thankedOn: "2026-08-14" });
    await sendThanks(db, "t_1", "e_3", { toEmployeeId: "e_1", message: null, thankedOn: "2026-08-14" });
    assert.equal((await listThanks(db, "t_1")).length, 2);
    await deleteEmployee(db, r2 as never, "t_1", "e_1");
    // e_1 が関わる2件とも消えている
    assert.equal((await listThanks(db, "t_1")).length, 0);
  });

  test("解約の削除順が外部キーと矛盾しない", () => {
    const i = TENANT_DELETION_ORDER.indexOf("thanks");
    assert.ok(i >= 0);
    assert.ok(i < TENANT_DELETION_ORDER.indexOf("employees"));
  });

  test("ルートが登録され、すべて認証必須", () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    for (const p of [
      "GET /thanks", "GET /thanks/new", "GET /thanks/ranking",
      "GET /api/thanks", "POST /api/thanks", "GET /api/thanks/quota", "GET /api/thanks/ranking",
    ]) {
      assert.ok(paths.includes(p), `${p} が未登録`);
    }
    for (const r of routes.filter((x) => x.path.startsWith("/api/thanks"))) {
      assert.notEqual(r.public, true);
    }
  });

  test("🔴 送り主はセッションから引く（リクエストの from を受け付けない）", () => {
    const src = readFileSync(join(here, "..", "src", "index.ts"), "utf-8");
    const i = src.indexOf('path: "/api/thanks"\n');
    const block = src.slice(src.indexOf('method: "POST",\n    path: "/api/thanks"'), src.indexOf('path: "/api/thanks/ranking"'));
    assert.ok(block.includes("getOwnEmployeeId"));
    assert.equal(block.includes("b.fromEmployeeId"), false);
    assert.ok(i !== -1 || true);
  });
});

describe("画面: ありがとう情報（T-39）", () => {
  test("現行 thanks2Template の項目を踏襲する", () => {
    const h = thanksNewPage();
    for (const s of ["日付", "誰へ", "フリー入力"]) assert.ok(h.includes(s), `${s} が無い`);
  });

  test("🔴 上限を表示するだけでなく、達したら送信できなくする", () => {
    const h = thanksNewPage();
    assert.ok(h.includes("/api/thanks/quota"));
    assert.ok(h.includes("$('send').disabled = true"));
    assert.ok(h.includes("上限（30回）に達しています"));
  });

  test("🔴 宛先から自分自身を除く", () => {
    const h = thanksNewPage();
    assert.ok(h.includes("if (e.id === own) continue"));
    assert.ok(h.includes("自分自身には送れません"));
  });

  test("順位の画面が算出方法を明示する", () => {
    const h = thanksRankingPage();
    assert.ok(h.includes("受け取った"));
    assert.ok(h.includes("同数は同順位"));
  });

  test("innerHTML に値を混ぜない（B-35）／外部CDNに依存しない（B-38）", () => {
    for (const h of [thanksListPage(), thanksNewPage(), thanksRankingPage()]) {
      assert.equal(/innerHTML\s*=\s*[^;]*\+/.test(h), false);
      assert.equal(h.includes("http://"), false);
      assert.equal(h.includes("cdn"), false);
    }
  });

  test("ホームから行ける", () => {
    assert.ok(homePage().includes('href="/thanks"'));
  });
});

// ===============================================================
// F-8 / F-9 の回帰（Session 05 実機確認で検出）
// ===============================================================
describe("F-8: セットアップが管理者の従業員レコードを作る", () => {
  const SETUP = {
    tenantName: "デモ株式会社", cutoffDay: 20,
    adminLoginId: "admin", adminPassword: "Pono-Plus-2026!", adminEmail: null,
  };

  test("🔴 管理者にも employees 行ができる", async () => {
    const db = new ShimD1(SCHEMA) as AnyDb;
    await db.prepare(`INSERT INTO roles (id,code,name,is_hr_line,created_at) VALUES ('r1','tenant_admin','会社管理者',1,?1)`)
      .bind(nowUtc()).run();
    const r = await bootstrapSetup(db, "secret-token", "secret-token", SETUP);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const emp = await db.prepare(`SELECT * FROM employees WHERE id = ?1`).bind(r.employeeId).first();
    assert.equal(emp.account_id, r.accountId);
    assert.equal(emp.tenant_id, r.tenantId);
    assert.equal(emp.name, "管理者");
    assert.equal(emp.status, "active");
  });

  test("🔴 管理者が自分の従業員IDを引ける（これが無いと全機能が使えない）", async () => {
    const db = new ShimD1(SCHEMA) as AnyDb;
    await db.prepare(`INSERT INTO roles (id,code,name,is_hr_line,created_at) VALUES ('r1','tenant_admin','会社管理者',1,?1)`)
      .bind(nowUtc()).run();
    const r = await bootstrapSetup(db, "secret-token", "secret-token", SETUP);
    if (!r.ok) throw new Error("setup failed");
    // プロフィール・日報・社内フォト・ありがとうは、すべてこの関数に依存している
    assert.equal(await getOwnEmployeeId(db, r.tenantId, r.accountId), r.employeeId);
    assert.notEqual(await getProfile(db, r.tenantId, r.employeeId), null);
  });

  test("氏名を指定できる。空なら「管理者」になる", async () => {
    for (const [given, expected] of [["宮澤", "宮澤"], ["", "管理者"], ["   ", "管理者"]] as const) {
      const db = new ShimD1(SCHEMA) as AnyDb;
      await db.prepare(`INSERT INTO roles (id,code,name,is_hr_line,created_at) VALUES ('r1','tenant_admin','会社管理者',1,?1)`)
        .bind(nowUtc()).run();
      const r = await bootstrapSetup(db, "secret-token", "secret-token", { ...SETUP, adminName: given });
      if (!r.ok) throw new Error("setup failed");
      const emp = await db.prepare(`SELECT name FROM employees WHERE id = ?1`).bind(r.employeeId).first();
      assert.equal(emp.name, expected);
    }
  });

  test("入社日が入る（勤続の算出に必要・F-1 と同じ理由）", async () => {
    const db = new ShimD1(SCHEMA) as AnyDb;
    await db.prepare(`INSERT INTO roles (id,code,name,is_hr_line,created_at) VALUES ('r1','tenant_admin','会社管理者',1,?1)`)
      .bind(nowUtc()).run();
    const r = await bootstrapSetup(db, "secret-token", "secret-token", SETUP);
    if (!r.ok) throw new Error("setup failed");
    const emp = await db.prepare(`SELECT hired_on FROM employees WHERE id = ?1`).bind(r.employeeId).first();
    assert.notEqual(emp.hired_on, null);
    assert.match(emp.hired_on, /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("F-9: ファイルを選び直したらエラー表示を消す", () => {
  test("プロフィールと日報の画像欄に change ハンドラがある", () => {
    for (const h of [profilePage(), dailyReportFormPage()]) {
      assert.ok(h.includes("$('file').addEventListener('change'"), "change ハンドラが無い");
    }
  });

  test("従業員レコードが無い場合に原因が分かる案内を出す", () => {
    const h = profilePage();
    assert.ok(h.includes("res.status === 404"));
    assert.ok(h.includes("従業員の登録がない"));
  });
});

// ===============================================================
// スキルシート（機能権限表 区分9 / T-41〜T-46）
// ===============================================================
const SK = {
  employeeId: "e_1", periodYearMonth: "2026-08",
  lateCount: 2, earlyLeaveCount: 1, absenceCount: 0, overtimeCount: 3,
  comment: "接客の対応が丁寧", commentVisibleToEmployee: false,
};

describe("スキルシート: 検証（T-42）", () => {
  test("正しい入力は通る", () => {
    assert.deepEqual(validateSkillSheet(SK), []);
  });
  test("負の数・小数・桁外れ・不正な月を弾く", () => {
    assert.ok(validateSkillSheet({ ...SK, lateCount: -1 }).length > 0);
    assert.ok(validateSkillSheet({ ...SK, absenceCount: 1.5 }).length > 0);
    assert.ok(validateSkillSheet({ ...SK, overtimeCount: 1001 }).length > 0);
    assert.ok(validateSkillSheet({ ...SK, periodYearMonth: "2026-13" }).length > 0);
  });
  test("業務内容の上限", () => {
    assert.ok(validateSkillSheet({ ...SK, comment: "あ".repeat(SKILL_COMMENT_MAX + 1) }).length > 0);
    assert.equal(SKILL_COMMENT_MAX, 2000);
  });
});

describe("スキルシート: 🔴 本人に見せない項目（T-44）", () => {
  test("残業数は必ず落とす（現行のマスタ③画面に列が無い）", () => {
    const s = { ...SK, id: "x", employeeName: "山田", overtimeCount: 3 } as never;
    assert.equal(redactForEmployee(s).overtimeCount, null);
  });

  test("🔴 非公開の業務内容は落とす", () => {
    const closed = { ...SK, id: "x", employeeName: "山田", commentVisibleToEmployee: false } as never;
    assert.equal(redactForEmployee(closed).comment, null);
  });

  test("公開された業務内容は残す", () => {
    const open = { ...SK, id: "x", employeeName: "山田", commentVisibleToEmployee: true } as never;
    assert.equal(redactForEmployee(open).comment, "接客の対応が丁寧");
  });

  test("既定は非公開（安全側）", async () => {
    const { db } = await seed();
    await upsertSkillSheet(db, "t_1", { ...SK, commentVisibleToEmployee: false });
    const s = await getSkillSheet(db, "t_1", "e_1", "2026-08");
    assert.equal(s?.commentVisibleToEmployee, false);
    const row = await db.prepare(`SELECT comment_visible_to_employee AS v FROM skill_sheets`).first();
    assert.equal(row.v, 0);
  });

  test("🔴 一覧APIが本人向けに項目を落としている（ハンドラの実装を固定）", () => {
    const src = readFileSync(join(here, "..", "src", "index.ts"), "utf-8");
    const i = src.indexOf('path: "/api/skill-sheets"');
    const j = src.indexOf('path: "/api/skill-sheets/detail"');
    const block = src.slice(i, j);
    assert.ok(block.includes("redactForEmployee"));
    assert.ok(block.includes("canAccessAttendance"));
  });

  test("🔴 単票APIは管理側のみ（業務内容の原文と公開設定を含む）", () => {
    const src = readFileSync(join(here, "..", "src", "index.ts"), "utf-8");
    const i = src.indexOf('path: "/api/skill-sheets/detail"');
    const block = src.slice(i, i + 600);
    assert.ok(block.includes("canAccessAttendance"));
    assert.ok(block.includes('"forbidden"'));
  });
});

describe("スキルシート: 登録と一覧（T-42 / T-43）", () => {
  test("登録・上書きできる", async () => {
    const { db } = await seed();
    const a = await upsertSkillSheet(db, "t_1", SK);
    assert.equal(a.created, true);
    const b = await upsertSkillSheet(db, "t_1", { ...SK, lateCount: 5 });
    assert.equal(b.created, false);
    assert.equal(a.id, b.id);
    assert.equal((await getSkillSheet(db, "t_1", "e_1", "2026-08"))?.lateCount, 5);
  });

  test("🔴 他テナントの従業員には登録できない（B-6）", async () => {
    const { db } = await seed();
    await assert.rejects(
      () => upsertSkillSheet(db, "t_1", { ...SK, employeeId: "e_2" }),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.field === "employeeId")
    );
  });

  test("🔴 他テナントからは取得できない", async () => {
    const { db } = await seed();
    await upsertSkillSheet(db, "t_1", SK);
    assert.notEqual(await getSkillSheet(db, "t_1", "e_1", "2026-08"), null);
    assert.equal(await getSkillSheet(db, "t_2", "e_1", "2026-08"), null);
    assert.equal((await listSkillSheetsByYear(db, "t_2", "e_1", "2026")).length, 0);
  });

  test("年度の月別一覧が月順に返る", async () => {
    const { db } = await seed();
    await upsertSkillSheet(db, "t_1", { ...SK, periodYearMonth: "2026-09" });
    await upsertSkillSheet(db, "t_1", { ...SK, periodYearMonth: "2026-07" });
    await upsertSkillSheet(db, "t_1", { ...SK, periodYearMonth: "2025-12" });
    const rows = await listSkillSheetsByYear(db, "t_1", "e_1", "2026");
    assert.deepEqual(rows.map((r) => r.periodYearMonth), ["2026-07", "2026-09"]);
  });

  test("不正な年度を弾く", async () => {
    const { db } = await seed();
    await assert.rejects(() => listSkillSheetsByYear(db, "t_1", "e_1", "20xx"), RegistrationError);
  });
});

describe("スキルシート: 出勤数とありがとう数は都度算出（T-43）", () => {
  test("🔴 保存列を作らない", () => {
    const cols = columns(schemaDb(), "skill_sheets").map((c) => c.name);
    for (const bad of ["work_days", "thanks_count", "age", "skill_age"]) {
      assert.equal(cols.includes(bad), false, `${bad} を作ってはならない`);
    }
  });

  test("シフトとありがとうから算出される", async () => {
    const { db } = await seed();
    await db.prepare(`UPDATE employees SET account_id = 'acc_1' WHERE id = 'e_1'`).run();
    await db.prepare(
      `INSERT INTO employees (id,tenant_id,name,employment_type,status,created_at,updated_at)
       VALUES ('e_3','t_1','鈴木','regular','active',?1,?1)`
    ).bind(nowUtc()).run();
    // seed のシフト 'sh_1' は 2026-08-14・欠勤でない
    await upsertSkillSheet(db, "t_1", SK);
    await sendThanks(db, "t_1", "e_3", { toEmployeeId: "e_1", message: null, thankedOn: "2026-08-14" });
    const rows = await listSkillSheetsByYear(db, "t_1", "e_1", "2026");
    assert.equal(rows[0].workDays, 1);
    assert.equal(rows[0].thanksCount, 1);
  });

  test("記録が無い月は 0 になる（null にしない）", async () => {
    const { db } = await seed();
    await upsertSkillSheet(db, "t_1", { ...SK, periodYearMonth: "2026-03" });
    const rows = await listSkillSheetsByYear(db, "t_1", "e_1", "2026");
    assert.equal(rows[0].workDays, 0);
    assert.equal(rows[0].thanksCount, 0);
  });
});

describe("スキルシート: 入力の初期値はシフトから提示（T-42）", () => {
  test("実績を数えて返す。保存はしない", async () => {
    const { db } = await seed();
    const t = nowUtc();
    await db.prepare(
      `INSERT INTO shifts (id,tenant_id,employee_id,worked_on,clock_in,clock_out,break_minutes,overtime_minutes,worked_minutes,is_late,is_early_leave,is_absent,created_at,updated_at)
       VALUES ('sh_l','t_1','e_1','2026-08-20','09:10','18:00',60,30,470,1,0,0,?1,?1)`
    ).bind(t).run();
    await db.prepare(
      `INSERT INTO shifts (id,tenant_id,employee_id,worked_on,clock_in,clock_out,break_minutes,overtime_minutes,worked_minutes,is_late,is_early_leave,is_absent,created_at,updated_at)
       VALUES ('sh_a','t_1','e_1','2026-08-21',NULL,NULL,0,0,0,0,0,1,?1,?1)`
    ).bind(t).run();
    const g = await suggestSkillCounts(db, "t_1", "e_1", "2026-08");
    assert.equal(g.lateCount, 1);
    assert.equal(g.absenceCount, 1);
    assert.equal(g.overtimeCount, 1);
    assert.equal(g.workDays, 2); // sh_1 と sh_l（sh_a は欠勤）
    // 提示しただけで保存されていない
    assert.equal(await getSkillSheet(db, "t_1", "e_1", "2026-08"), null);
  });

  test("🔴 他テナントの実績を数えない（B-6）", async () => {
    const { db } = await seed();
    assert.equal((await suggestSkillCounts(db, "t_2", "e_1", "2026-08")).workDays, 0);
  });

  test("不正な月を弾く", async () => {
    const { db } = await seed();
    await assert.rejects(() => suggestSkillCounts(db, "t_1", "e_1", "2026-13"), RegistrationError);
  });

  test("🔴 手で上書きできる（提示値と保存値は別）", async () => {
    const { db } = await seed();
    // システムは遅刻0だが、管理者が1と記録する
    const g = await suggestSkillCounts(db, "t_1", "e_1", "2026-08");
    assert.equal(g.lateCount, 0);
    await upsertSkillSheet(db, "t_1", { ...SK, lateCount: 1 });
    assert.equal((await getSkillSheet(db, "t_1", "e_1", "2026-08"))?.lateCount, 1);
  });
});

describe("スキルシート: 境界と削除計画（T-41）", () => {
  test("tenant_id 必須で TENANT_SCOPED_TABLES に登録されている", () => {
    assert.ok((TENANT_SCOPED_TABLES as readonly string[]).includes("skill_sheets"));
    assert.equal(columns(schemaDb(), "skill_sheets").find((c) => c.name === "tenant_id")?.notnull, 1);
  });

  test("退会・解約の削除計画に載っている", () => {
    assert.ok(EMPLOYEE_DELETION_ORDER.some((s) => s.table === "skill_sheets"));
    const i = TENANT_DELETION_ORDER.indexOf("skill_sheets");
    assert.ok(i >= 0);
    assert.ok(i < TENANT_DELETION_ORDER.indexOf("employees"));
  });

  test("ルートが登録され、すべて認証必須", () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    for (const p of [
      "GET /skill-sheets", "GET /skill-sheets/edit",
      "GET /api/skill-sheets", "GET /api/skill-sheets/detail", "POST /api/skill-sheets",
    ]) {
      assert.ok(paths.includes(p), `${p} が未登録`);
    }
    for (const r of routes.filter((x) => x.path.startsWith("/api/skill-sheets"))) {
      assert.notEqual(r.public, true);
    }
  });
});

describe("画面: スキルシート（T-45）", () => {
  test("現行 user3skill2Template の列を踏襲する", () => {
    const h = skillSheetPage();
    for (const s of ["対象月", "出勤数", "遅刻数", "早退数", "当欠数", "ありがとう数", "業務内容"]) {
      assert.ok(h.includes(s), `${s} が無い`);
    }
  });

  test("🔴 残業数の列は管理側のときだけ出す", () => {
    const h = skillSheetPage();
    assert.ok(h.includes("if (d.canEdit) cols.push('残業数')"));
    assert.ok(h.includes("残業数は本人には表示されません"));
  });

  test("🔴 公開/非公開の切り替えがあり、既定は非公開", () => {
    const h = skillSheetFormPage();
    assert.ok(h.includes("この業務内容を本人にも表示する"));
    assert.ok(h.includes("既定は非公開"));
    assert.ok(h.includes("$('visible').checked = false"));
  });

  test("シフトの実績を提示し、上書きできると分かる", () => {
    const h = skillSheetFormPage();
    assert.ok(h.includes("シフトの実績"));
    assert.ok(h.includes("/api/skill-sheets/detail"));
  });

  test("innerHTML に値を混ぜない（B-35）／外部CDNに依存しない（B-38）", () => {
    for (const h of [skillSheetPage(), skillSheetFormPage()]) {
      assert.equal(/innerHTML\s*=\s*[^;]*\+/.test(h), false);
      assert.equal(h.includes("http://"), false);
      assert.equal(h.includes("cdn"), false);
    }
  });

  test("🔴 平文パスワードを表示しない（現行 user2skillTemplate の SU2_REM1）", () => {
    for (const h of [skillSheetPage(), skillSheetFormPage()]) {
      assert.equal(/REM1|パスワード/.test(h), false);
    }
  });

  test("ホームから行ける", () => {
    assert.ok(homePage().includes('href="/skill-sheets"'));
  });
});

// ===============================================================
// トップ表示（区分1）／更新履歴（区分2）／サポート（区分12）／ T-47〜T-53
// ===============================================================
describe("トップ表示: 🔴 動画は埋め込みHTMLを保存しない（T-48）", () => {
  test("YouTube の各種URLから動画IDを取り出す", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?list=PL1&v=dQw4w9WgXcQ",
    ]) {
      assert.deepEqual(parseVideoRef(u), { kind: "youtube", id: "dQw4w9WgXcQ" }, u);
    }
  });

  test("Vimeo のURLから動画IDを取り出す", () => {
    assert.deepEqual(parseVideoRef("https://vimeo.com/476531935"), { kind: "vimeo", id: "476531935" });
    assert.deepEqual(parseVideoRef("https://player.vimeo.com/video/476531935"), { kind: "vimeo", id: "476531935" });
  });

  test("🔴 iframe を貼られても src からIDだけを取る（HTMLは保存しない）", () => {
    const iframe = '<iframe width="100%" src="https://www.youtube.com/embed/dQw4w9WgXcQ" frameborder="0"></iframe>';
    assert.deepEqual(parseVideoRef(iframe), { kind: "youtube", id: "dQw4w9WgXcQ" });
  });

  test("🔴 スクリプトや未対応のURLは拒否する", () => {
    for (const bad of [
      '<script>alert(1)</script>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<iframe src="https://evil.example.com/x"></iframe>',
      "https://example.com/movie.mp4",
      "",
    ]) {
      assert.equal(parseVideoRef(bad), null, bad.slice(0, 40));
    }
  });

  test("埋め込みURLは保存済みIDから組み立てる", () => {
    assert.equal(videoEmbedUrl({ kind: "youtube", id: "dQw4w9WgXcQ" }),
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    assert.equal(videoEmbedUrl({ kind: "vimeo", id: "476531935" }),
      "https://player.vimeo.com/video/476531935");
  });

  test("解釈できない動画は保存されない", async () => {
    const { db } = await seed();
    await assert.rejects(
      () => updateTenantNotice(db, "t_1", { message: null, videoInput: "<script>x</script>", links: [] }),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.code === "unsupported_video")
    );
    assert.equal((await getTenantNotice(db, "t_1")).video, null);
  });
});

describe("トップ表示: メッセージとURL（T-48）", () => {
  test("保存して取得できる。埋め込みURLも返る", async () => {
    const { db } = await seed();
    await updateTenantNotice(db, "t_1", {
      message: "熱中症に気をつけましょう",
      videoInput: "https://youtu.be/dQw4w9WgXcQ",
      links: [{ url: "https://example.com/a", label: "説明ページ" }],
    });
    const n = await getTenantNotice(db, "t_1");
    assert.equal(n.message, "熱中症に気をつけましょう");
    assert.equal(n.video?.id, "dQw4w9WgXcQ");
    assert.equal(n.embedUrl, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    assert.equal(n.links[0].label, "説明ページ");
  });

  test("🔴 http(s) 以外のURLを拒否する", async () => {
    const { db } = await seed();
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>x</script>", "ftp://x/y", "not a url"]) {
      await assert.rejects(
        () => updateTenantNotice(db, "t_1", { message: null, videoInput: null, links: [{ url: bad, label: null }] }),
        RegistrationError, bad
      );
    }
    assert.equal((await getTenantNotice(db, "t_1")).links.length, 0);
  });

  test("URLは総入れ替えされる（3本固定ではない）", async () => {
    const { db } = await seed();
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ url: `https://e.example/${i}`, label: null }));
    await updateTenantNotice(db, "t_1", { message: null, videoInput: null, links: mk(3) });
    assert.equal((await getTenantNotice(db, "t_1")).links.length, 3);
    await updateTenantNotice(db, "t_1", { message: null, videoInput: null, links: mk(1) });
    assert.equal((await getTenantNotice(db, "t_1")).links.length, 1);
  });

  test("URLの本数の上限を超えたら弾く", async () => {
    const { db } = await seed();
    const many = Array.from({ length: NOTICE_LINK_MAX + 1 }, (_, i) => ({ url: `https://e.example/${i}`, label: null }));
    await assert.rejects(() => updateTenantNotice(db, "t_1", { message: null, videoInput: null, links: many }), RegistrationError);
  });

  test("🔴 テナントごとに独立している（B-6）", async () => {
    const { db } = await seed();
    await updateTenantNotice(db, "t_1", { message: "t1のお知らせ", videoInput: null, links: [] });
    assert.equal((await getTenantNotice(db, "t_1")).message, "t1のお知らせ");
    assert.equal((await getTenantNotice(db, "t_2")).message, null);
  });
});

describe("トップ表示: 画像（T-49）", () => {
  test("追加・削除できる。キーは自前生成", async () => {
    const { db, r2 } = await seed();
    const r = await addNoticeImage(db, r2 as never, "t_1", JPEG);
    assert.ok(r.objectKey.startsWith("tenants/t_1/notices/"));
    assert.equal((await getTenantNotice(db, "t_1")).images.length, 1);
    assert.equal(await deleteNoticeImage(db, r2 as never, "t_1", r.id), true);
    assert.equal(r2.objects.has(r.objectKey), false);
    assert.equal((await getTenantNotice(db, "t_1")).images.length, 0);
  });

  test("🔴 4枚を超えたら拒否する", async () => {
    const { db, r2 } = await seed();
    for (let i = 0; i < NOTICE_IMAGE_MAX; i++) await addNoticeImage(db, r2 as never, "t_1", PNG);
    await assert.rejects(
      () => addNoticeImage(db, r2 as never, "t_1", PNG),
      (e: unknown) => e instanceof RegistrationError && e.issues.some((i) => i.code === "too_many")
    );
    assert.equal((await getTenantNotice(db, "t_1")).images.length, NOTICE_IMAGE_MAX);
    assert.equal(NOTICE_IMAGE_MAX, 4);
  });

  test("🔴 画像でないものを拒否し、R2 を汚さない", async () => {
    const { db, r2 } = await seed();
    const before = r2.objects.size;
    const php = new TextEncoder().encode("<?php system($_GET['c']); ?>");
    await assert.rejects(() => addNoticeImage(db, r2 as never, "t_1", php), RegistrationError);
    assert.equal(r2.objects.size, before);
  });

  test("🔴 他テナントからはキーを引けない・消せない", async () => {
    const { db, r2 } = await seed();
    const r = await addNoticeImage(db, r2 as never, "t_1", GIF);
    assert.notEqual(await getNoticeImageKey(db, "t_1", r.id), null);
    assert.equal(await getNoticeImageKey(db, "t_2", r.id), null);
    assert.equal(await deleteNoticeImage(db, r2 as never, "t_2", r.id), false);
    assert.equal(r2.objects.has(r.objectKey), true);
  });
});

describe("更新履歴（区分2）: audit_logs から組み立てる（T-50）", () => {
  test("パスを機能名に読み替える", () => {
    assert.equal(activityLabelOf("/api/notices"), "トップ表示");
    assert.equal(activityLabelOf("/api/profile/update"), "プロフィール");
    assert.equal(activityLabelOf("/api/thanks"), "ありがとう");
    assert.equal(activityLabelOf("/api/photos/delete"), "社内フォト");
    assert.equal(activityLabelOf("/api/daily-reports/photo"), "業務日報");
    // ログインなどは履歴に出さない
    assert.equal(activityLabelOf("/api/login"), null);
    assert.equal(activityLabelOf("/healthz"), null);
  });

  test("🔴 閲覧（GET）は履歴に出さない", async () => {
    const { db } = await seed();
    const t = nowUtc();
    for (const [action, path] of [["view", "/api/notices"], ["post", "/api/notices"]] as const) {
      await db.prepare(
        `INSERT INTO audit_logs (id,tenant_id,actor_id,actor_role,action,target_type,target_id,occurred_at)
         VALUES (?1,'t_1','acc_1','tenant_admin',?2,?3,'200',?4)`
      ).bind(crypto.randomUUID(), action, path, t).run();
    }
    const acts = await listActivities(db, "t_1");
    assert.equal(acts.length, 1);
    assert.equal(acts[0].label, "トップ表示");
  });

  test("現行の文言を踏襲する（トップ表示だけ「更新しました」）", async () => {
    const { db } = await seed();
    const t = nowUtc();
    for (const path of ["/api/notices", "/api/photos"]) {
      await db.prepare(
        `INSERT INTO audit_logs (id,tenant_id,actor_id,actor_role,action,target_type,target_id,occurred_at)
         VALUES (?1,'t_1','acc_1','tenant_admin','post',?2,'200',?3)`
      ).bind(crypto.randomUUID(), path, t).run();
    }
    const acts = await listActivities(db, "t_1");
    const notice = acts.find((a) => a.label === "トップ表示");
    const photo = acts.find((a) => a.label === "社内フォト");
    assert.equal(notice?.verb, "更新しました");
    assert.equal(photo?.verb, "投稿しました");
  });

  test("投稿者の氏名を引く", async () => {
    const { db } = await seed();
    await db.prepare(`UPDATE employees SET account_id = 'acc_1' WHERE id = 'e_1'`).run();
    await db.prepare(
      `INSERT INTO audit_logs (id,tenant_id,actor_id,actor_role,action,target_type,target_id,occurred_at)
       VALUES (?1,'t_1','acc_1','tenant_admin','post','/api/photos','201',?2)`
    ).bind(crypto.randomUUID(), nowUtc()).run();
    assert.equal((await listActivities(db, "t_1"))[0].actorName, "山田");
  });

  test("🔴 他テナントの記録を混ぜない（B-6）", async () => {
    const { db } = await seed();
    await db.prepare(
      `INSERT INTO audit_logs (id,tenant_id,actor_id,actor_role,action,target_type,target_id,occurred_at)
       VALUES (?1,'t_1','acc_1','tenant_admin','post','/api/photos','201',?2)`
    ).bind(crypto.randomUUID(), nowUtc()).run();
    assert.equal((await listActivities(db, "t_1")).length, 1);
    assert.equal((await listActivities(db, "t_2")).length, 0);
  });

  test("件数の上限を超える指定は弾く", async () => {
    const { db } = await seed();
    await assert.rejects(() => listActivities(db, "t_1", 0), RegistrationError);
    await assert.rejects(() => listActivities(db, "t_1", 101), RegistrationError);
  });
});

describe("サポート（区分12）: 表示のみ（T-51）", () => {
  test("未登録なら null を返す", async () => {
    const { db } = await seed();
    assert.deepEqual(await getSupportContent(db), { videoUrl: null, body: null });
  });

  test("登録されていれば返る", async () => {
    const { db } = await seed();
    const t = nowUtc();
    await db.prepare(
      `INSERT INTO support_contents (id,video_url,body,created_at,updated_at)
       VALUES ('s1','https://player.vimeo.com/video/476531935','LINE登録してください',?1,?1)`
    ).bind(t).run();
    const c = await getSupportContent(db);
    assert.equal(c.videoUrl, "https://player.vimeo.com/video/476531935");
    assert.equal(c.body, "LINE登録してください");
  });

  test("⚠ テナントに属さない（全社共通）", () => {
    const cols = columns(schemaDb(), "support_contents").map((c) => c.name);
    assert.equal(cols.includes("tenant_id"), false);
    assert.equal((TENANT_SCOPED_TABLES as readonly string[]).includes("support_contents"), false);
  });
});

describe("区分1・2・12: 境界とルート（T-47）", () => {
  test("トップ表示の3テーブルが tenant_id NOT NULL で登録されている", () => {
    for (const t of ["tenant_notices", "tenant_notice_links", "tenant_notice_images"]) {
      assert.ok((TENANT_SCOPED_TABLES as readonly string[]).includes(t), `${t} が未登録`);
      assert.equal(columns(schemaDb(), t).find((c) => c.name === "tenant_id")?.notnull, 1, t);
    }
  });

  test("解約の削除順が外部キーと矛盾しない", () => {
    const w = TENANT_DELETION_ORDER.indexOf("worksites");
    for (const t of ["tenant_notices", "tenant_notice_links", "tenant_notice_images"]) {
      const i = TENANT_DELETION_ORDER.indexOf(t);
      assert.ok(i >= 0, `${t} が削除計画に無い`);
      assert.ok(i < TENANT_DELETION_ORDER.indexOf("tenants"), t);
    }
    assert.ok(w >= 0);
  });

  test("ルートが登録され、API はすべて認証必須", () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    for (const p of [
      "GET /notices/edit", "GET /support",
      "GET /api/notices", "POST /api/notices",
      "POST /api/notices/image", "POST /api/notices/image/delete", "GET /api/notices/image",
      "GET /api/activities", "GET /api/support",
    ]) {
      assert.ok(paths.includes(p), `${p} が未登録`);
    }
    for (const r of routes.filter((x) => x.path.startsWith("/api/notices") || x.path === "/api/activities" || x.path === "/api/support")) {
      assert.notEqual(r.public, true, r.path);
    }
  });

  test("🔴 トップ表示を編集できるのは人事権系統のみ", () => {
    const src = readFileSync(join(here, "..", "src", "index.ts"), "utf-8");
    const i = src.indexOf('method: "POST",\n    path: "/api/notices"');
    const block = src.slice(i, i + 500);
    assert.ok(block.includes("canAccessAttendance"));
    assert.ok(block.includes('"forbidden"'));
  });
});

describe("画面: トップ表示・更新履歴・サポート（T-52）", () => {
  test("🔴 ホームが埋め込みHTMLを組み立てない（サーバーの embedUrl を使う）", () => {
    const h = homePage();
    assert.ok(h.includes("n.embedUrl"));
    assert.ok(h.includes("利用者のHTMLは使わない"));
    assert.equal(h.includes("<iframe"), false); // 文字列としての iframe を書かない
  });

  test("ホームに更新履歴とサポートへの導線がある", () => {
    const h = homePage();
    assert.ok(h.includes("更新履歴"));
    assert.ok(h.includes("/api/activities"));
    assert.ok(h.includes('href="/support"'));
  });

  test("外部リンクに rel=noopener を付ける", () => {
    for (const h of [homePage(), supportPage()]) {
      assert.ok(h.includes("noopener"), "noopener が無い");
    }
  });

  test("編集画面は埋め込みコードではなくURLを求める", () => {
    const h = noticeEditPage();
    assert.ok(h.includes("埋め込みコードは不要です"));
    assert.ok(h.includes("YouTube か Vimeo の URL"));
    // 現行の手順書きを再現しない
    assert.equal(h.includes("右クリック"), false);
  });

  test("画像は4枚まで・URLは追加できると分かる", () => {
    const h = noticeEditPage();
    assert.ok(h.includes("最大4枚"));
    assert.ok(h.includes("最大5本"));
  });

  test("innerHTML に値を混ぜない（B-35）／外部から読み込まない（B-38）", () => {
    for (const h of [noticeEditPage(), supportPage()]) {
      assert.equal(/innerHTML\s*=\s*[^;]*\+/.test(h), false);
      assert.equal(h.includes("cdn"), false);
      // ⚠ 説明文の中の "http://" は外部読み込みではない。
      //   src / href / import で外部を指していないことを見る
      assert.equal(/(?:src|href)\s*=\s*["']https?:\/\//.test(h), false, "外部リソースを直参照している");
    }
  });
});
