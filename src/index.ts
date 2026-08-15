/**
 * エントリポイント（ディスパッチャ）
 *
 * 設計根拠:
 *  - 改修設計書 v6 5.3(3) 認証チェックをディスパッチャ層で一元化する
 *  - 同 4.2【コード実証】現行のディスパッチャは $_REQUEST を読んで Action を呼ぶだけで認証がない
 *  - 同 4.13.6【コード実証】shift3updateAction には認証失敗時の遷移が無かった（B-5）
 *
 * 本ファイルの要点:
 *   認証を通っていないリクエストがハンドラ本体に到達しない構造にする。
 *   ハンドラ側で認証を書き忘れても、ここを通らなければ実行されない。
 */
import { AuthzError, nowUtc, toJstCalendarDate, sha256Hex, canAccessAttendance } from "./core.ts";
import { loginPage, homePage, shiftSheetPage, employeeListPage, employeeFormPage, attendancePage } from "./pages.ts";
import { login, logout, registerEmployee, RegistrationError, upsertShift, summarizePeriod, ShiftServiceError, bootstrapSetup, evaluateAttendance, setUrgentCheck, getShiftSheet, listEmployees, getEmployee, updateEmployee, listShiftTypes } from "./services.ts";
import type { Principal } from "./core.ts";

export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  /** "on" のときだけ例外の詳細を応答に含める。⚠ 本番では設定しないこと */
  DIAGNOSTIC_ERRORS?: string;
  /** 初期セットアップ用トークン。⚠ セットアップ完了後は削除すること */
  SETUP_TOKEN?: string;
}

export interface RequestContext {
  env: Env;
  principal: Principal;
  requestId: string;
  ip: string | null;
}

type Handler = (req: Request, ctx: RequestContext) => Promise<Response>;

interface RouteDef {
  method: string;
  path: string;
  /** 認証不要のルートは明示的に public: true を書かせる（既定は要認証） */
  public?: boolean;
  handler: Handler;
}

// ------------------------------------------------------------------
// ルート登録
// ------------------------------------------------------------------
function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // 画面にも最低限のセキュリティヘッダを付ける
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
    },
  });
}

export const routes: RouteDef[] = [
  // 画面（現行 loginuser*Template.php の構造を踏襲）
  { method: "GET", path: "/", public: true, handler: async () => Response.redirect("/login", 302) },
  { method: "GET", path: "/login", public: true, handler: async () => html(loginPage()) },
  { method: "GET", path: "/home", public: true, handler: async () => html(homePage()) },
  { method: "GET", path: "/shifts", public: true, handler: async () => html(shiftSheetPage()) },
  { method: "GET", path: "/employees", public: true, handler: async () => html(employeeListPage()) },
  { method: "GET", path: "/employees/new", public: true, handler: async () => html(employeeFormPage()) },
  { method: "GET", path: "/attendance", public: true, handler: async () => html(attendancePage()) },
  {
    // 設定の反映状況を確認できるようにする。⚠ 値そのものは絶対に返さない
    method: "GET",
    path: "/healthz",
    public: true,
    handler: async (_req, ctx) =>
      json({
        ok: true,
        bindings: {
          db: typeof ctx.env.DB?.prepare === "function",
          photos: typeof ctx.env.PHOTOS?.get === "function",
        },
        setupTokenConfigured: typeof ctx.env.SETUP_TOKEN === "string" && ctx.env.SETUP_TOKEN.length > 0,
      }),
  },
  {
    method: "GET",
    path: "/api/me",
    handler: async (_req, ctx) =>
      json({ accountId: ctx.principal.accountId, tenantId: ctx.principal.tenantId, roles: ctx.principal.roleCodes }),
  },
  {
    // 初期セットアップ。テナントが0件のときだけ動作する
    method: "POST",
    path: "/api/setup",
    public: true,
    handler: async (req, ctx) => {
      const b = (await req.json()) as Record<string, unknown>;
      const r = await bootstrapSetup(ctx.env.DB, ctx.env.SETUP_TOKEN, String(b.token ?? ""), {
        tenantName: String(b.tenantName ?? ""),
        cutoffDay: Number(b.cutoffDay ?? 31),
        adminLoginId: String(b.adminLoginId ?? ""),
        adminPassword: String(b.adminPassword ?? ""),
        adminEmail: (b.adminEmail as string | null) ?? null,
      });
      if (!r.ok) {
        const status = r.reason === "already_initialized" ? 409 : r.reason === "invalid_input" ? 422 : 403;
        return json({ error: r.reason }, status);
      }
      return json({ ok: true, tenantId: r.tenantId, accountId: r.accountId }, 201);
    },
  },
  {
    method: "POST",
    path: "/api/login",
    public: true,
    handler: async (req, ctx) => {
      const b = (await req.json()) as { loginId?: string; password?: string; tenantId?: string | null };
      if (typeof b.loginId !== "string" || typeof b.password !== "string") {
        return json({ error: "bad_request" }, 400);
      }
      const r = await login(ctx.env.DB, {
        loginId: b.loginId,
        password: b.password,
        tenantId: b.tenantId ?? null,
        ip: ctx.ip,
        userAgent: req.headers.get("User-Agent"),
      });
      if (!r.ok) return json({ error: r.reason }, r.reason === "rate_limited" ? 429 : 401);
      return new Response(JSON.stringify({ ok: true, expiresAt: r.expiresAt }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          // 🔴 HttpOnly: JS から読めない / Secure: HTTPS のみ / SameSite=Strict: CSRF 対策
          "Set-Cookie": `pp_session=${r.token}; HttpOnly; Secure; SameSite=Strict; Path=/`,
        },
      });
    },
  },
  {
    method: "POST",
    path: "/api/logout",
    handler: async (req, ctx) => {
      const token = readSessionToken(req);
      if (token !== null) await logout(ctx.env.DB, token);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": "pp_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0",
        },
      });
    },
  },
  {
    method: "POST",
    path: "/api/employees",
    handler: async (req, ctx) => {
      // 従業員の登録は人事権系統のロールに限る
      if (!canAccessAttendance(ctx.principal)) return json({ error: "forbidden" }, 403);
      if (ctx.principal.tenantId === null) return json({ error: "no_tenant" }, 400);
      const b = (await req.json()) as Record<string, unknown>;
      try {
        const r = await registerEmployee(
          ctx.env.DB,
          ctx.principal.tenantId,
          {
            name: String(b.name ?? ""),
            nameKana: (b.nameKana as string | null) ?? null,
            employeeCode: (b.employeeCode as string | null) ?? null,
            email: (b.email as string | null) ?? null,
            loginId: String(b.loginId ?? ""),
            password: String(b.password ?? ""),
            shiftTypeId: (b.shiftTypeId as string | null) ?? null,
            employmentType: String(b.employmentType ?? ""),
            birthOn: (b.birthOn as string | null) ?? null,
            hiredOn: (b.hiredOn as string | null) ?? null,
            gender: (b.gender as string | null) ?? null,
            worksiteId: (b.worksiteId as string | null) ?? null,
          },
          toJstCalendarDate(nowUtc())
        );
        return json({ ok: true, employeeId: r.employeeId }, 201);
      } catch (e) {
        if (e instanceof RegistrationError) return json({ error: "validation_failed", issues: e.issues }, 422);
        throw e;
      }
    },
  },
  {
    // ⚠ パス変数（/api/employees/:id）は使わない。
    //    ディスパッチャのルート探索は完全一致であり、変数対応を入れると
    //    認証・CSRF を一元化している中核部分に手が入る。
    //    既存の /api/shifts/sheet と同じくクエリ文字列で受ける。
    method: "GET",
    path: "/api/employees",
    handler: async (req, ctx) => {
      if (!canAccessAttendance(ctx.principal)) return json({ error: "forbidden" }, 403);
      if (ctx.principal.tenantId === null) return json({ error: "no_tenant" }, 400);
      const u = new URL(req.url);
      try {
        const rows = await listEmployees(ctx.env.DB, ctx.principal.tenantId, {
          status: u.searchParams.get("status"),
          keyword: u.searchParams.get("keyword"),
        });
        return json({ ok: true, employees: rows, count: rows.length });
      } catch (e) {
        if (e instanceof RegistrationError) return json({ error: "validation_failed", issues: e.issues }, 422);
        throw e;
      }
    },
  },
  {
    method: "GET",
    path: "/api/employees/detail",
    handler: async (req, ctx) => {
      if (ctx.principal.tenantId === null) return json({ error: "no_tenant" }, 400);
      const employeeId = new URL(req.url).searchParams.get("employeeId");
      if (employeeId === null) return json({ error: "invalid_input" }, 422);
      const emp = await getEmployee(ctx.env.DB, ctx.principal.tenantId, employeeId);
      if (emp === null) return json({ error: "not_found" }, 404);
      // 人事権系統でなければ自分自身の情報だけ見られる
      if (!canAccessAttendance(ctx.principal)) {
        const owner = await ctx.env.DB.prepare(`SELECT account_id FROM employees WHERE id = ?1`)
          .bind(employeeId)
          .first<{ account_id: string | null }>();
        if (owner?.account_id !== ctx.principal.accountId) return json({ error: "forbidden" }, 403);
      }
      return json({ ok: true, employee: emp });
    },
  },
  {
    method: "GET",
    path: "/api/shift-types",
    handler: async (_req, ctx) => {
      if (ctx.principal.tenantId === null) return json({ error: "no_tenant" }, 400);
      const rows = await listShiftTypes(ctx.env.DB, ctx.principal.tenantId);
      return json({ ok: true, shiftTypes: rows });
    },
  },
  {
    // PATCH ではなく POST。既存ルートが GET/POST のみで統一されているため
    method: "POST",
    path: "/api/employees/update",
    handler: async (req, ctx) => {
      if (!canAccessAttendance(ctx.principal)) return json({ error: "forbidden" }, 403);
      if (ctx.principal.tenantId === null) return json({ error: "no_tenant" }, 400);
      const b = (await req.json()) as Record<string, unknown>;
      const employeeId = typeof b.employeeId === "string" ? b.employeeId : null;
      if (employeeId === null) return json({ error: "invalid_input" }, 422);
      // 送られてきたキーだけを変更対象にする（部分更新）
      const patch: Record<string, unknown> = {};
      for (const k of [
        "name", "nameKana", "employeeCode", "employmentType", "status",
        "birthOn", "hiredOn", "gender", "shiftTypeId", "worksiteId",
      ]) {
        if (k in b) patch[k] = b[k];
      }
      try {
        await updateEmployee(ctx.env.DB, ctx.principal.tenantId, employeeId, patch, toJstCalendarDate(nowUtc()));
        return json({ ok: true });
      } catch (e) {
        if (e instanceof RegistrationError) {
          const notFound = e.issues.some((i) => i.field === "employeeId" && i.code === "not_found");
          return json({ error: notFound ? "not_found" : "validation_failed", issues: e.issues }, notFound ? 404 : 422);
        }
        throw e;
      }
    },
  },
  {
    // 現行の shift1update / shift2update / shift3update / shift23update の4本を1本に集約
    method: "POST",
    path: "/api/shifts",
    handler: async (req, ctx) => {
      if (ctx.principal.tenantId === null) return json({ error: "no_tenant" }, 400);
      const b = (await req.json()) as Record<string, unknown>;
      // 従業員は自分のシフトのみ。管理者は自テナント全員分を操作できる
      if (!canAccessAttendance(ctx.principal)) {
        const own = await ctx.env.DB.prepare(`SELECT id FROM employees WHERE account_id = ?1 AND tenant_id = ?2`)
          .bind(ctx.principal.accountId, ctx.principal.tenantId)
          .first<{ id: string }>();
        if (own === null || own.id !== String(b.employeeId ?? "")) return json({ error: "forbidden" }, 403);
      }
      try {
        const r = await upsertShift(ctx.env.DB, ctx.principal.tenantId, {
          employeeId: String(b.employeeId ?? ""),
          workedOn: String(b.workedOn ?? ""),
          shiftTypeId: (b.shiftTypeId as string | null) ?? null,
          clockIn: (b.clockIn as string | null) ?? null,
          clockOut: (b.clockOut as string | null) ?? null,
          breakMinutes: Number(b.breakMinutes ?? 0),
          overtimeMinutes: Number(b.overtimeMinutes ?? 0),
          isAbsent: b.isAbsent === true,
          isLate: b.isLate === true,
          isEarlyLeave: b.isEarlyLeave === true,
          isConfirmed: b.isConfirmed === true,
          isDayLocked: b.isDayLocked === true,
          note: (b.note as string | null) ?? null,
          dayNote: (b.dayNote as string | null) ?? null,
          worksiteId: (b.worksiteId as string | null) ?? null,
        });
        return json({ ok: true, ...r }, 200);
      } catch (e) {
        if (e instanceof ShiftServiceError) {
          // 締め済み期間への登録は 409（競合）として返す
          return json({ error: e.code }, e.code === "period_closed" ? 409 : 422);
        }
        if (e instanceof Error && e.name === "ShiftValidationError") return json({ error: "invalid_input" }, 422);
        throw e;
      }
    },
  },
  {
    method: "GET",
    path: "/api/shifts/summary",
    handler: async (req, ctx) => {
      if (ctx.principal.tenantId === null) return json({ error: "no_tenant" }, 400);
      const u = new URL(req.url);
      const employeeId = u.searchParams.get("employeeId") ?? "";
      const yearMonth = u.searchParams.get("yearMonth") ?? "";
      if (!canAccessAttendance(ctx.principal)) {
        const own = await ctx.env.DB.prepare(`SELECT id FROM employees WHERE account_id = ?1 AND tenant_id = ?2`)
          .bind(ctx.principal.accountId, ctx.principal.tenantId)
          .first<{ id: string }>();
        if (own === null || own.id !== employeeId) return json({ error: "forbidden" }, 403);
      }
      const tenant = await ctx.env.DB.prepare(`SELECT cutoff_day FROM tenants WHERE id = ?1`)
        .bind(ctx.principal.tenantId).first<{ cutoff_day: number }>();
      if (tenant === null) return json({ error: "tenant_not_found" }, 404);
      try {
        return json(await summarizePeriod(ctx.env.DB, ctx.principal.tenantId, employeeId, yearMonth, tenant.cutoff_day));
      } catch {
        return json({ error: "invalid_input" }, 422);
      }
    },
  },
  {
    // シフト入力画面のデータ（現行 shift1View.php の aryCalendar 相当）
    method: "GET",
    path: "/api/shifts/sheet",
    handler: async (req, ctx) => {
      if (ctx.principal.tenantId === null) return json({ error: "no_tenant" }, 400);
      const u = new URL(req.url);
      const employeeId = u.searchParams.get("employeeId") ?? "";
      const yearMonth = u.searchParams.get("yearMonth") ?? "";
      if (!canAccessAttendance(ctx.principal)) {
        const own = await ctx.env.DB.prepare(`SELECT id FROM employees WHERE account_id = ?1 AND tenant_id = ?2`)
          .bind(ctx.principal.accountId, ctx.principal.tenantId)
          .first<{ id: string }>();
        if (own === null || own.id !== employeeId) return json({ error: "forbidden" }, 403);
      }
      const tenant = await ctx.env.DB.prepare(`SELECT cutoff_day FROM tenants WHERE id = ?1`)
        .bind(ctx.principal.tenantId).first<{ cutoff_day: number }>();
      if (tenant === null) return json({ error: "tenant_not_found" }, 404);
      try {
        return json(await getShiftSheet(ctx.env.DB, ctx.principal.tenantId, employeeId, yearMonth, tenant.cutoff_day));
      } catch (e) {
        if (e instanceof ShiftServiceError) return json({ error: e.code }, 422);
        return json({ error: "invalid_input" }, 422);
      }
    },
  },
  {
    // 勤怠評価（WBS ブロック8）
    method: "GET",
    path: "/api/attendance/evaluation",
    handler: async (req, ctx) => {
      if (ctx.principal.tenantId === null) return json({ error: "no_tenant" }, 400);
      const u = new URL(req.url);
      const employeeId = u.searchParams.get("employeeId") ?? "";
      const yearMonth = u.searchParams.get("yearMonth") ?? "";
      // 🔴 勤怠評価は人事権系統に許可される。段階2のストレスチェック結果とは
      //    逆の非対称性になる（改修設計書 6.3 / 7.2・スキーマ設計 7章）
      if (!canAccessAttendance(ctx.principal)) {
        const own = await ctx.env.DB.prepare(`SELECT id FROM employees WHERE account_id = ?1 AND tenant_id = ?2`)
          .bind(ctx.principal.accountId, ctx.principal.tenantId)
          .first<{ id: string }>();
        if (own === null || own.id !== employeeId) return json({ error: "forbidden" }, 403);
      }
      const tenant = await ctx.env.DB.prepare(`SELECT cutoff_day FROM tenants WHERE id = ?1`)
        .bind(ctx.principal.tenantId).first<{ cutoff_day: number }>();
      if (tenant === null) return json({ error: "tenant_not_found" }, 404);
      try {
        return json(await evaluateAttendance(ctx.env.DB, ctx.principal.tenantId, {
          employeeId, yearMonth, cutoffDay: tenant.cutoff_day,
        }));
      } catch (e) {
        if (e instanceof ShiftServiceError) return json({ error: e.code }, 422);
        return json({ error: "invalid_input" }, 422);
      }
    },
  },
  {
    // 期間単位の「緊急確認」（現行 shift1_r1_flg1 相当）
    method: "POST",
    path: "/api/shifts/urgent-check",
    handler: async (req, ctx) => {
      if (ctx.principal.tenantId === null) return json({ error: "no_tenant" }, 400);
      if (!canAccessAttendance(ctx.principal)) return json({ error: "forbidden" }, 403);
      const b = (await req.json()) as Record<string, unknown>;
      const tenant = await ctx.env.DB.prepare(`SELECT cutoff_day FROM tenants WHERE id = ?1`)
        .bind(ctx.principal.tenantId).first<{ cutoff_day: number }>();
      if (tenant === null) return json({ error: "tenant_not_found" }, 404);
      try {
        const r = await setUrgentCheck(
          ctx.env.DB, ctx.principal.tenantId, String(b.employeeId ?? ""),
          String(b.yearMonth ?? ""), tenant.cutoff_day, b.needsUrgentCheck === true, ctx.principal.accountId
        );
        return json({ ok: true, ...r });
      } catch (e) {
        if (e instanceof ShiftServiceError) return json({ error: e.code }, 422);
        return json({ error: "invalid_input" }, 422);
      }
    },
  },
];

// ------------------------------------------------------------------
// CSRF（改修設計書 6.2.4: 現行は共通処理層に0件）
// ------------------------------------------------------------------
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function checkCsrf(req: Request): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const origin = req.headers.get("Origin");
  const host = req.headers.get("Host");
  if (origin === null || host === null) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------
export const worker = {
  async fetch(req: Request, env: Env, execCtx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    // CSRF はルート探索より先に判定する。順序が逆だと、クロスオリジンからの
    // 書き込み要求に対して 404 と 403 の differing 応答を返し、ルートの
    // 存在有無を読み取られる（統合テストで検出）
    if (!checkCsrf(req)) return json({ error: "csrf_check_failed" }, 403);

    // ルート名を文字列加工しない（現行 View_Manager は "_"→"/" 変換後に "/" を
    // 除去してしまい、サブディレクトリ配下の View を呼べなくなっていた・B-25）。
    // 未登録ルートは die() ではなく 404 を返す（現行は HTTP 200 のまま・B-28）
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
    if (route === undefined) return json({ error: "not_found" }, 404);

    // 🔴 public ルートも同じ try/catch を通す。
    //    以前は public だけ例外処理の外にあり、ハンドラが投げた例外が
    //    Cloudflare の HTML エラー画面（Worker threw exception）になっていた。
    //    実機デプロイで検出（2026-08-15）。
    const ctx: RequestContext = route.public === true
      ? {
          env,
          principal: { accountId: "", tenantId: null, roleCodes: [] },
          requestId: crypto.randomUUID(),
          ip: req.headers.get("CF-Connecting-IP"),
        }
      : await (async (): Promise<RequestContext | null> => {
          const principal = await authenticate(req, env);
          if (principal === null) return null;
          return {
            env,
            principal,
            requestId: crypto.randomUUID(),
            ip: req.headers.get("CF-Connecting-IP"),
          };
        })() ?? { env, principal: { accountId: "", tenantId: null, roleCodes: [] }, requestId: "", ip: null };

    if (route.public !== true && ctx.requestId === "") {
      return json({ error: "unauthorized" }, 401);
    }

    try {
      const res = await route.handler(req, ctx);
      // 監査ログは応答をブロックしない（D1 の書き込みは単一スレッド・設計書 5.5②）
      execCtx.waitUntil(writeAudit(ctx, req.method, url.pathname, res.status));
      return res;
    } catch (e) {
      if (e instanceof AuthzError) {
        execCtx.waitUntil(writeAudit(ctx, req.method, url.pathname, 403, e.reason));
        return json({ error: "forbidden" }, 403);
      }
      // ⚠ 例外の中身をそのまま返さない。ログにも個人データを出さない（設計書 6.1）
      execCtx.waitUntil(writeAudit(ctx, req.method, url.pathname, 500));
      // DIAGNOSTIC_ERRORS=on のときだけ例外の種類を返す。
      // ⚠ 本番では必ず未設定にすること（内部情報の露出を防ぐため）
      if (env.DIAGNOSTIC_ERRORS === "on") {
        const err = e as Error;
        return json({ error: "internal_error", name: err?.name, message: String(err?.message).slice(0, 300) }, 500);
      }
      return json({ error: "internal_error" }, 500);
    }
  },
};

// ------------------------------------------------------------------
async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const token = readSessionToken(req);
  if (token === null) return null;

  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT s.account_id, s.tenant_id, s.expires_at, s.revoked_at, a.status
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.id = ?1`
  )
    .bind(tokenHash)
    .first<{ account_id: string; tenant_id: string | null; expires_at: string; revoked_at: string | null; status: string }>();

  if (row === null) return null;
  if (row.revoked_at !== null) return null;
  if (row.status !== "active") return null;
  // UTC 同士の比較（設計書 4.12 の再発防止）
  if (row.expires_at <= nowUtc()) return null;

  // セッションにロールをキャッシュしない。権限剥奪を即時反映させるため（設計書 4.14.1）
  const roles = await env.DB.prepare(
    `SELECT r.code FROM account_roles ar JOIN roles r ON r.id = ar.role_id
      WHERE ar.account_id = ?1 AND ar.revoked_at IS NULL`
  )
    .bind(row.account_id)
    .all<{ code: string }>();

  return {
    accountId: row.account_id,
    tenantId: row.tenant_id,
    roleCodes: (roles.results ?? []).map((r) => r.code),
  };
}

function readSessionToken(req: Request): string | null {
  const cookie = req.headers.get("Cookie");
  if (cookie === null) return null;
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === "pp_session") return rest.join("=");
  }
  return null;
}

async function writeAudit(
  ctx: RequestContext,
  method: string,
  path: string,
  status: number,
  note?: string
): Promise<void> {
  try {
    await ctx.env.DB.prepare(
      `INSERT INTO audit_logs (id, tenant_id, actor_id, actor_role, action, target_type, target_id, ip_address, occurred_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
    )
      .bind(
        crypto.randomUUID(),
        ctx.principal.tenantId,
        ctx.principal.accountId,
        ctx.principal.roleCodes.join(","),
        method === "GET" ? "view" : method.toLowerCase(),
        path,
        note ?? String(status),
        ctx.ip,
        nowUtc()
      )
      .run();
  } catch {
    // 監査ログの失敗で本処理を落とさない。ただし握り潰しはここだけに限定する
  }
}

export default worker;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
