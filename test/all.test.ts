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
} from "../src/services.ts";
import { worker, routes } from "../src/index.ts";
import { loginPage, shiftSheetPage, formatClockOut, parseClockOut, employeeListPage, employeeFormPage } from "../src/pages.ts";
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
  readonly objects = new Map<string, string>();

  async put(key: string, value: string): Promise<void> {
    this.objects.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async get(key: string): Promise<string | null> {
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
  test("マイグレーションが実行でき、テーブル20本・インデックス16本になる", () => {
    const db = schemaDb();
    assert.equal(tableNames(db).length, 20);
    const idx = db.prepare(
      "select count(*) as n from sqlite_master where type='index' and name not like 'sqlite_%'"
    ).get() as { n: number };
    assert.equal(idx.n, 16);
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
      "/", "/api/login", "/api/setup", "/employees", "/employees/new",
      "/healthz", "/home", "/login", "/shifts",
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

  test("テーブル数は増えていない（列の追加のみ）", () => {
    assert.equal(tableNames(schemaDb()).length, 20);
  });
});
