/**
 * 画面（HTML）
 *
 * 現行の loginuser2Template.php / loginuser3Template.php（md5 62e86a88.. / 36cbdf28..）
 * の構造を踏襲する。
 *
 * 🔴 現行から意図的に変えた点（B分類）:
 *   B-35 入力値を エスケープせず埋め戻していた → エスケープする
 *   B-36 エラーメッセージに HTML を直接埋め込んでいた → テキストのみ
 *   B-38 jQuery 1.11.1（2014年）を CDN から読み込み → 依存なし
 *   会社の入力欄は現行どおり設けない。ログインIDから特定する
 */

import { canView, canEdit, canEditReportCategory, isSystemAdmin } from "./core.ts";
import type { Principal, Section } from "./core.ts";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #eef1f5;
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif;
    color: #1c2530;
  }
  .login { width: 100%; max-width: 380px; padding: 24px; }
  .login h1 { font-size: 20px; text-align: center; margin: 0 0 20px; letter-spacing: .06em; }
  .box { background: #fff; border-radius: 10px; padding: 28px 24px; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  .row { margin-bottom: 16px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #46535f; }
  input[type=text], input[type=password] {
    width: 100%; padding: 11px 12px; font-size: 16px;
    border: 1px solid #c8d0d8; border-radius: 6px; background: #fff;
  }
  input:focus { outline: 2px solid #2f6fbf; outline-offset: 0; border-color: #2f6fbf; }
  button {
    width: 100%; padding: 12px; font-size: 16px; font-weight: 600; color: #fff;
    background: #2f6fbf; border: 0; border-radius: 6px; cursor: pointer; margin-top: 4px;
  }
  button:hover { background: #275d9f; }
  button:disabled { background: #9bb0c7; cursor: default; }
  .error {
    background: #fdeaea; border: 1px solid #e6b4b4; color: #a32020;
    padding: 10px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 16px;
  }
  .note { margin-top: 18px; font-size: 12px; color: #6b7885; text-align: center; line-height: 1.7; }
  select { width: 100%; padding: 11px 12px; font-size: 16px; border: 1px solid #c8d0d8; border-radius: 6px; }
  /* 共通ヘッダー（Session 06・G-2〜G-5）
     ⚠ 常に2行。1行目=素性とログアウト／2行目=メニュー。
       折り返しに頼らないので、どの画面幅でも重ならない。 */
  .apphdr {
    position: sticky; top: 0; z-index: 50; width: 100%;
    background: #1f3b63; color: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.2);
  }
  .hdrtop, .hdrbar { max-width: 1100px; margin: 0 auto; padding: 0 14px; }
  .hdrtop {
    display: flex; align-items: center; gap: 10px;
    min-height: 52px; min-width: 0; padding-top: 6px; padding-bottom: 6px;
  }
  .brand { color: #fff; font-weight: 700; text-decoration: none; letter-spacing: .04em; flex: 0 0 auto; }
  .who { display: flex; align-items: center; gap: 8px; font-size: 12px; margin-left: auto; min-width: 0; }
  .wid { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
  .wrole { background: rgba(255,255,255,.18); padding: 3px 10px; border-radius: 999px;
           white-space: nowrap; flex: 0 0 auto; line-height: 1.4; }
  /* 🔴 共通の button は width:100% を持つ（ログイン画面の送信ボタン用）。
     それを継ぐとログアウトが枠外へ押し出されるため、ここで必ず打ち消す。
     ⚠ width:auto と flex:0 0 auto の両方が要る。実機で2度はみ出した原因。 */
  .apphdr .who button {
    width: auto !important; min-width: 0; margin: 0;
    font-size: 13px; padding: 0 14px; min-height: 40px;
    white-space: nowrap; flex: 0 0 auto;
    border: 1px solid rgba(255,255,255,.55); background: transparent; color: #fff;
    border-radius: 6px; cursor: pointer; font-weight: 600;
  }
  .apphdr .who button:hover:not(:disabled) { background: rgba(255,255,255,.15); }
  .apphdr .who button:disabled { opacity: .6; cursor: default; }
  .hdrbar { overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .hdrbar::-webkit-scrollbar { display: none; }
  .hdrnav { display: flex; gap: 4px; padding-bottom: 8px; width: max-content; }
  /* 指で押せる大きさを確保する（目安44px）。狭い画面ほど重要 */
  .hdrnav a {
    color: #d8e3f2; text-decoration: none; font-size: 14px;
    display: flex; align-items: center; min-height: 40px; padding: 0 14px;
    border-radius: 6px; white-space: nowrap;
  }
  .hdrnav a:hover { background: rgba(255,255,255,.12); color: #fff; }
  .hdrnav a.on { background: #fff; color: #1f3b63; font-weight: 600; }

  /* 🔴 ヘッダーがある画面は上寄せにする（body の中央寄せを打ち消す）。
     ただし body の flex を外すと本文が左端に寄るため、
     ヘッダー以外の直下要素を margin:auto で中央に戻す（Session 06 実機で修正）。 */
  body.hashdr { display: block; align-items: initial; justify-content: initial; }
  body.hashdr > .login, body.hashdr > .wrap, body.hashdr > div:not(.apphdr) {
    margin-left: auto; margin-right: auto;
  }

  /* アコーディオン（更新履歴など） */
  .acc > summary {
    cursor: pointer; list-style: none; display: flex; align-items: center;
    justify-content: space-between; gap: 8px; font-weight: 600; padding: 2px 0;
  }
  .acc > summary::-webkit-details-marker { display: none; }
  .acc > summary::after { content: "＋"; font-weight: 400; opacity: .6; }
  .acc[open] > summary::after { content: "－"; }
  .acc > summary .cnt { margin-left: auto; margin-right: 6px; font-weight: 400; font-size: 12px; opacity: .7; }
  .acc > summary:focus-visible { outline: 2px solid #1f3b63; outline-offset: 2px; }

  /* ============================================================
     スマホ対応（Session 06・実機で崩れを確認）
     ⚠ 640px 以下では、ヘッダーのメニューを横スクロールにする。
       折り返すとヘッダーが画面の半分を占め、本文が見えなくなる。
     ============================================================ */
  @media (max-width: 640px) {
    .hdrtop, .hdrbar { padding: 0 10px; }
    .hdrtop { min-height: 52px; gap: 8px; }
    .brand { font-size: 15px; }
    .who { gap: 6px; font-size: 12px; }
    /* ⚠ ここを縮めすぎない。押せない大きさにすると使えなくなる */
    .wid { max-width: 64px; }
    .wrole { padding: 3px 8px; font-size: 11px; }
    .apphdr .who button { padding: 0 12px; font-size: 13px; min-height: 40px; }
    .hdrnav a { font-size: 14px; padding: 0 13px; min-height: 40px; }

    /* 本文。左右に余白が無いと端末の縁に貼り付く */
    body.hashdr > .login, body.hashdr > .wrap, body.hashdr > div:not(.apphdr) {
      padding-left: 12px; padding-right: 12px;
    }
    /* 表は横スクロールに逃がす（縮めると読めなくなる） */
    .wrap, .tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
    table { min-width: 0; }
  }
  @media (max-width: 400px) {
    .brand { font-size: 13px; }
    .wid { max-width: 70px; }
  }
`;

export function loginPage(opts: { errorMessage?: string; loginId?: string } = {}): string {
  const err = opts.errorMessage === undefined ? "" : `<p class="error">${esc(opts.errorMessage)}</p>`;
  const id = esc(opts.loginId ?? "");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>PONO-PLUS ログイン</title>
<style>${STYLE}</style>
</head>
<body>
<div class="login">
  <h1>PONO-PLUS</h1>
  <div class="box">
    ${err}
    <form id="f" method="POST" action="/login">
      <div class="row">
        <label for="login_id">ID</label>
        <input type="text" id="login_id" name="login_id" value="${id}" autocomplete="username" autocapitalize="off" required>
      </div>
      <div class="row">
        <label for="login_pass">パスワード</label>
        <input type="password" id="login_pass" name="login_pass" autocomplete="current-password" required>
      </div>
      <div id="tenant_row" class="row" hidden>
        <label for="tenant_id">会社</label>
        <select id="tenant_id" name="tenant_id"></select>
      </div>
      <button type="submit" id="btn">ログイン</button>
    </form>
    <p class="note">推奨ブラウザ：Chrome、Firefox、Edge、iPhone、Android</p>
  </div>
</div>
<script>
const f = document.getElementById('f');
const btn = document.getElementById('btn');
const row = document.getElementById('tenant_row');
const sel = document.getElementById('tenant_id');

function showError(msg) {
  let p = document.querySelector('.error');
  if (!p) {
    p = document.createElement('p');
    p.className = 'error';
    document.querySelector('.box').prepend(p);
  }
  p.textContent = msg;
}

f.addEventListener('submit', async (e) => {
  e.preventDefault();
  btn.disabled = true;
  btn.textContent = '確認中…';
  try {
    const body = {
      loginId: document.getElementById('login_id').value,
      password: document.getElementById('login_pass').value,
      tenantId: row.hidden ? null : sel.value,
    };
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) { location.href = '/home'; return; }

    if (data.error === 'tenant_required') {
      sel.innerHTML = '';
      for (const t of data.tenants) {
        const o = document.createElement('option');
        o.value = t.id; o.textContent = t.name;
        sel.appendChild(o);
      }
      row.hidden = false;
      showError('会社を選択してください');
    } else if (data.error === 'rate_limited') {
      showError('試行回数が上限に達しました。しばらく待ってからお試しください');
    } else if (data.error === 'account_inactive') {
      showError('このアカウントは利用できません。管理者にお問い合わせください');
    } else {
      showError('IDまたはパスワードが正しくありません');
    }
  } catch {
    showError('通信に失敗しました。しばらく待ってからお試しください');
  } finally {
    btn.disabled = false;
    btn.textContent = 'ログイン';
  }
});
</script>
</body>
</html>`;
}

/**
 * 🔴 メニューは権限で組み立てる（Session 06・機能権限表 §2）。
 *    「—＝メニューに存在しない」を満たすため、リンクごとに必要な区分を持たせる。
 *    ルートを塞ぐだけでは不十分で、③に従業員一覧や店舗情報のリンクが見えていた。
 *
 * ⚠ need が "edit" のものは、閲覧できてもリンクを出さない。
 *   勤怠評価は①②のみ（③に自分の評価を見せるかは【未確認】。現行に該当画面が無い）。
 */
const MENU: Array<{ href: string; label: string; section: Section; need: "view" | "edit" }> = [
  { href: "/employees", label: "従業員一覧", section: "account", need: "edit" },
  { href: "/shifts", label: "シフト", section: "shift", need: "view" },
  { href: "/attendance", label: "勤怠評価", section: "shift", need: "edit" },
  { href: "/profile", label: "プロフィール", section: "profile", need: "view" },
  { href: "/reports", label: "店舗情報（月次）", section: "worksite", need: "view" },
  { href: "/daily-reports", label: "業務日報", section: "daily_report", need: "view" },
  { href: "/photos", label: "社内フォト共有", section: "photo", need: "view" },
  { href: "/thanks", label: "ありがとう情報", section: "thanks", need: "view" },
  { href: "/skill-sheets", label: "スキルシート", section: "skill", need: "view" },
  { href: "/support", label: "サポート", section: "support", need: "view" },
];

/** 階層の表示名。ロールコードそのままでは意味が伝わらない */
const ROLE_LABEL: Record<string, string> = {
  system_admin: "システム管理者",
  tenant_admin: "会社管理者",
  worksite_manager: "店舗管理者",
  employee: "スタッフ",
  sc_implementer: "ストレスチェック実施者",
  sc_clerk: "ストレスチェック事務従事者",
};

export function roleLabel(p: Principal): string {
  const named = p.roleCodes.map((c) => ROLE_LABEL[c]).filter((x) => x !== undefined);
  return named.length === 0 ? "権限なし" : named.join(" / ");
}

/**
 * 🔴 全画面に出す共通ヘッダー（Session 06・G-2〜G-5）。
 *
 * これが無かったために実機で次の事故が起きた:
 *   - 誰としてログインしているか画面から分からず、`/api/me` を直接叩くまで判明しなかった
 *   - ログアウトが /home の最下部にしかなく、他の画面から抜けられなかった
 *   - ログアウトの結果を見ずに /login へ飛ばしていたため、失敗しても気づけなかった
 *
 * ⚠ ログインIDは HTML に埋めず、/api/me から描画する。画面はキャッシュされうるため。
 * ⚠ メニューは menuFor() で組み立てる。権限の無いリンクは【生成しない】。
 *   style="display:none" で隠すのは不可（開発者ツールで見える・到達できる）。
 */
export function headerHtml(p: Principal, current: string): string {
  const links = menuFor(p)
    .map((m) => `<a href="${m.href}"${m.href === current ? ' class="on"' : ""}>${m.label}</a>`)
    .join("");
  // 🔴 常に2行で組む（Session 06 実機で2度崩れたため構造を固定した）。
  //   1行目: ブランド ＋ ログインID ＋ 権限 ＋ ログアウト
  //   2行目: メニュー（横スクロール）
  //   ⚠ flex の折り返しに頼ると、指定の組み合わせ次第で1行に潰れて重なる。
  //     行を別々の要素に分けることで、画面幅に関係なく崩れなくなる。
  return `<header class="apphdr">
  <div class="hdrtop">
    <a class="brand" href="/home">PONO-PLUS</a>
    <div class="who">
      <span class="wid" id="hdrid">…</span>
      <span class="wrole">${esc(roleLabel(p))}</span>
      <button type="button" id="hdrout">ログアウト</button>
    </div>
  </div>
  <div class="hdrbar"><nav class="hdrnav">${links}</nav></div>
</header>
<script>
(async () => {
  try {
    const r = await fetch('/api/me');
    if (r.status === 401) { location.href = '/login'; return; }
    const me = await r.json();
    document.getElementById('hdrid').textContent = me.loginId || me.accountId;
  } catch (e) { document.getElementById('hdrid').textContent = '-'; }
})();
document.getElementById('hdrout').addEventListener('click', async () => {
  const b = document.getElementById('hdrout');
  b.disabled = true; b.textContent = 'ログアウト中…';
  try {
    const r = await fetch('/api/logout', { method: 'POST', headers: { 'Origin': location.origin } });
    // 🔴 結果を見てから遷移する。従来は見ずに飛ばしており、失敗しても気づけなかった
    if (!r.ok) { b.disabled = false; b.textContent = 'ログアウト（失敗）'; alert('ログアウトできませんでした。通信を確認してください。'); return; }
  } catch (e) {
    b.disabled = false; b.textContent = 'ログアウト（失敗）'; alert('ログアウトできませんでした。'); return;
  }
  location.href = '/login';
});
</script>`;
}

export function menuFor(p: Principal): Array<{ href: string; label: string }> {
  // 🔴 ホームは区分を持たない。誰でも戻れる場所が必要で、ブランド名のリンクだけでは
  //    それと分からないという指摘を受けて明示した（Session 06 実機）。
  //
  // 🔴 super管理者は業務区分を1つも持たない（機能権限表 1.1）。
  //    弊社側の機能だけを出し、業務メニューは1つも出さない。
  if (isSystemAdmin(p)) {
    return [
      { href: "/home", label: "ホーム" },
      { href: "/admin/tenants", label: "テナント一覧" },
      { href: "/admin/support", label: "サポート編集" },
    ];
  }
  return [
    { href: "/home", label: "ホーム" },
    ...MENU
      .filter((m) => (m.need === "edit" ? canEdit(p, m.section) : canView(p, m.section)))
      .map((m) => ({ href: m.href, label: m.label })),
  ];
}

export function homePage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>PONO-PLUS</title>
<style>${STYLE}
  body { align-items: flex-start; }
  .login { max-width: 560px; padding-top: 40px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #e4e9ee; }
  th { color: #6b7885; font-weight: 600; width: 40%; }
  .logout { margin-top: 20px; }
  .logout button { background: #6b7885; }
  .nav { display: flex; flex-direction: column; gap: 8px; margin-top: 20px; }
  .nav a {
    display: block; padding: 12px 14px; border: 1px solid #c8d0d8; border-radius: 6px;
    color: #2f6fbf; text-decoration: none; font-size: 15px; font-weight: 600; background: #fff;
  }
  .nav a:hover { background: #f2f6fb; border-color: #2f6fbf; }
  .notice { border: 1px solid #e4e9ee; border-radius: 8px; padding: 14px; margin-bottom: 18px; background: #fff; }
  .notice h2 { font-size: 14px; color: #6b7885; margin: 0 0 8px; }
  .notice .msg { font-size: 15px; color: #23303a; white-space: pre-wrap; word-break: break-word; }
  .notice iframe { width: 100%; aspect-ratio: 16 / 9; border: 0; border-radius: 6px; margin-top: 10px; }
  .notice ul { list-style: none; padding: 0; margin: 10px 0 0; }
  .notice li { margin-bottom: 6px; font-size: 14px; }
  .notice li a { color: #2f6fbf; }
  .notice img { width: 100%; border-radius: 6px; margin-top: 10px; display: block; }
  .acts { list-style: none; padding: 0; margin: 0; font-size: 13px; }
  .acts li { padding: 6px 0; border-bottom: 1px solid #eef1f4; color: #46535f; }
  .acts .t { color: #6b7885; font-size: 12px; }
  .editlink { font-size: 13px; margin-top: 10px; }
  .editlink a { color: #2f6fbf; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/home")}
<div class="login">
  <h1>PONO-PLUS</h1>
  <div class="box">
    <div class="notice" id="notice" style="display:none">
      <h2>お知らせ</h2>
      <div id="noticebody"></div>
      ${canEdit(p, "notice") ? '<p class="editlink" id="noticeedit" style="display:none"><a href="/notices/edit">トップ表示を編集する</a></p>' : ""}
    </div>
    <table id="me"><tbody><tr><td colspan="2">読み込み中…</td></tr></tbody></table>

    <details class="notice acc" style="margin-top:20px">
      <summary><span>更新履歴</span><span class="cnt" id="actcnt"></span></summary>
      <ul class="acts" id="acts"><li>読み込み中…</li></ul>
    </details>
  </div>
  <p class="note">段階1（基盤・認証・シフト・勤怠評価）まで実装済み</p>
</div>
<script>
(async () => {
  const res = await fetch('/api/me');
  if (res.status === 401) { location.href = '/login'; return; }
  const me = await res.json();
  document.querySelector('#me tbody').innerHTML =
    '<tr><th>アカウントID</th><td>' + me.accountId + '</td></tr>' +
    '<tr><th>会社ID</th><td>' + (me.tenantId || '-') + '</td></tr>' +
    '<tr><th>権限</th><td>' + me.roles.join(', ') + '</td></tr>';
})();

// --- トップ表示（区分1）---
(async () => {
  const res = await fetch('/api/notices');
  if (!res.ok) return;
  const d = await res.json();
  const n = d.notice;
  const box = document.getElementById('noticebody');
  box.replaceChildren();
  let any = false;
  if (n.message !== null && n.message !== '') {
    const p = document.createElement('div');
    p.className = 'msg';
    p.textContent = n.message;
    box.appendChild(p);
    any = true;
  }
  if (n.embedUrl !== null) {
    // 🔴 埋め込みURLはサーバーが動画IDから組み立てたもの。利用者のHTMLは使わない
    const f = document.createElement('iframe');
    f.src = n.embedUrl;
    f.allowFullscreen = true;
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    box.appendChild(f);
    any = true;
  }
  if (n.links.length > 0) {
    const ul = document.createElement('ul');
    for (const [i, l] of n.links.entries()) {
      const li = document.createElement('li');
      const num = document.createElement('span');
      num.textContent = String(i + 1) + '. ';
      const a = document.createElement('a');
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = l.label === null || l.label === '' ? l.url : l.label;
      li.appendChild(num); li.appendChild(a);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    any = true;
  }
  for (const img of n.images) {
    const e = document.createElement('img');
    e.alt = 'お知らせの画像';
    e.loading = 'lazy';
    e.src = '/api/notices/image?imageId=' + encodeURIComponent(img.id);
    box.appendChild(e);
    any = true;
  }
  if (d.canEdit) { document.getElementById('noticeedit').style.display = 'block'; any = true; }
  if (any) document.getElementById('notice').style.display = 'block';
})();

// --- 更新履歴（区分2）---
(async () => {
  const res = await fetch('/api/activities');
  const ul = document.getElementById('acts');
  ul.replaceChildren();
  if (!res.ok) { const li = document.createElement('li'); li.textContent = '取得できませんでした'; ul.appendChild(li); return; }
  const d = await res.json();
  if (d.activities.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'まだ記録がありません';
    ul.appendChild(li);
    return;
  }
  const cnt = document.getElementById('actcnt');
  if (cnt) cnt.textContent = d.activities.length + ' 件';
  for (const a of d.activities) {
    const li = document.createElement('li');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = a.occurredAt.slice(0, 16).replace('T', ' ');
    const b = document.createElement('div');
    // 現行の文言を踏襲：「{名前}さんが{機能名}を{更新/投稿}しました」
    b.textContent = (a.actorName === null ? '管理者' : a.actorName) + ' さんが' + a.label + 'を' + a.verb;
    li.appendChild(t); li.appendChild(b);
    ul.appendChild(li);
  }
})();
</script>
</body>
</html>`;
}

/**
 * シフト入力画面
 *
 * 現行 shift1Template.php（md5 53b4db4d..）の列構成を踏襲する。
 *   日付/曜日・確定・時間帯・フリー入力・当日確認・出勤・退勤・休憩・残業・実働・当日フリー
 *
 * 🔴 現行から意図的に変えた点:
 *   B-39 timepicker を rawgit.com（2019年終了）から読み込んでいた → 依存なし
 *   B-40 同一スクリプトを日数分（最大31回）出力していた → 1回
 *   B-42 timepicker の maxTime が 23:59 で日跨ぎを入力できなかった → 24時超えを許可
 *   実働はサーバ側の計算結果を表示する（現行も同じ。入力欄は持たない）
 */
/**
 * 退勤時刻の表示変換。
 * 保存は 24時超え表記（例 30:00）のままにし、画面でだけ「翌 06:00」と見せる。
 * ⚠ 保存形式を 06:00 に戻すと、当日か翌日かが判別できなくなり、
 *   現行 shift23updateAction が抱えていた曖昧さが復活する。
 */
export function formatClockOut(value: string | null): string {
  if (value === null || value === "") return "";
  const m = /^(\d{1,3}):([0-5]\d)$/.exec(value);
  if (m === null) return value;
  const h = Number(m[1]);
  if (h < 24) return value;
  return `翌 ${String(h - 24).padStart(2, "0")}:${m[2]}`;
}

/** 「翌 06:00」「翌06:00」「6:00」などを 06:00 に正規化する（サーバ側で日跨ぎ判定される） */
export function parseClockOut(input: string): string {
  let v = input.trim();
  // 全角を半角へ（現行は変換していないため入力できなかった）
  v = v.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
       .replace(/[：︓]/g, ":")
       .replace(/[\s　]/g, "");
  v = v.replace(/^翌日?/, "");
  const m = /^(\d{1,3}):?([0-5]?\d)?$/.exec(v);
  if (m === null) return v;
  const hh = String(Number(m[1])).padStart(2, "0");
  const mm = (m[2] ?? "0").padStart(2, "0");
  return `${hh}:${mm}`;
}

export function shiftSheetPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>シフト登録/修正</title>
<style>${STYLE}
  body { align-items: flex-start; background: #f4f6f8; }
  .login { max-width: 1100px; padding: 20px; }
  .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .bar input, .bar select { width: auto; }
  .summary { font-size: 14px; color: #46535f; margin: 0 0 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; }
  th, td { border: 1px solid #dde3e9; padding: 5px 6px; text-align: center; white-space: nowrap; }
  thead th { background: #eef2f6; font-size: 12px; color: #46535f; position: sticky; top: 0; }
  td input[type=text] { width: 66px; padding: 5px; font-size: 13px; text-align: center; }
  td textarea { width: 130px; height: 30px; padding: 4px; font-size: 12px; border: 1px solid #c8d0d8; border-radius: 4px; }
  td select { width: 100px; padding: 5px; font-size: 13px; }
  .sat { background: #f0f6fd; } .sun { background: #fdf1f1; }
  .worked { font-weight: 600; }
  .wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  @media (max-width: 640px) {
    /* ⚠ シフト表は縮めると読めなくなる。横スクロールに逃がし、
       ヘッダー行だけ固定してどの日か分かるようにする */
    .wrap table { font-size: 12px; }
    th, td { padding: 4px 5px; }
    td input[type=text] { width: 56px; }
    td textarea { width: 110px; }
    td select { width: 88px; }
  }
  .actions { margin-top: 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .actions button { width: auto; padding: 11px 28px; }
  .msg { margin-top: 12px; font-size: 14px; }
  .msg.ok { color: #1c7a3e; } .msg.ng { color: #a32020; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/shifts")}
<div class="login">
  <h1>シフト登録/修正</h1>
  <div class="box">
    <div class="bar">
      <input type="text" id="ym" placeholder="2026-09" size="8">
      <button id="load" style="width:auto;padding:11px 20px">表示</button>
      <label style="margin:0"><input type="checkbox" id="urgent" style="width:auto"> 緊急確認</label>
    </div>
    <p class="summary" id="summary">従業員を選び、年月を入力して表示してください</p>
    <div class="wrap">
      <table>
        <thead><tr>
          <th>日付</th><th>確定</th><th>時間帯</th><th>フリー入力</th>
          <th>当日確認</th><th>出勤</th><th>退勤</th><th>休憩(分)</th><th>残業(分)</th>
          <th>実働</th><th>当日フリー</th>
        </tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div class="actions">
      <button id="save">登録/修正</button>
      <span class="msg" id="msg"></span>
    </div>
  </div>
</div>
<script>
let sheet = null;

// 保存は 24時超え表記のまま。表示だけ「翌 06:00」にする
function fmtOut(v) {
  if (!v) return '';
  const m = /^(\\d{1,3}):([0-5]\\d)$/.exec(v);
  if (!m) return v;
  const h = Number(m[1]);
  return h < 24 ? v : '翌 ' + String(h - 24).padStart(2, '0') + ':' + m[2];
}

// 「翌 06:00」「6:00」「２２：００」などを 06:00 形式へ
function normTime(s) {
  let v = (s || '').trim()
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[：︓]/g, ':')
    .replace(/[\\s　]/g, '')
    .replace(/^翌日?/, '');
  if (!v) return '';
  const m = /^(\\d{1,3}):?([0-5]?\\d)?$/.exec(v);
  if (!m) return v;
  return String(Number(m[1])).padStart(2, '0') + ':' + (m[2] || '0').padStart(2, '0');
}

function hhmm(min) {
  if (!min) return '0:00';
  return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0');
}

async function load() {
  const ym = document.getElementById('ym').value.trim();
  const me = await (await fetch('/api/me')).json().catch(() => null);
  if (!me) { location.href = '/login'; return; }
  const empId = new URLSearchParams(location.search).get('employeeId') || '';
  const res = await fetch('/api/shifts/sheet?employeeId=' + encodeURIComponent(empId) + '&yearMonth=' + encodeURIComponent(ym));
  if (!res.ok) { setMsg('表示できませんでした', false); return; }
  sheet = await res.json();
  render();
}

function setMsg(t, ok) {
  const m = document.getElementById('msg');
  m.textContent = t;
  m.className = 'msg ' + (ok ? 'ok' : 'ng');
}

function render() {
  document.getElementById('summary').textContent =
    sheet.employeeName + '　[' + sheet.periodStartOn + ' 〜 ' + sheet.periodEndOn + ']　合計 ' + hhmm(sheet.totalWorkedMinutes);
  document.getElementById('urgent').checked = sheet.needsUrgentCheck;

  const opts = ['<option value="">（未設定）</option>', '<option value="__off">休み</option>']
    .concat(sheet.shiftTypes.map(t => '<option value="' + t.id + '">' + t.name + '</option>')).join('');

  document.getElementById('rows').innerHTML = sheet.rows.map((r, i) => {
    const cls = r.weekday === '土' ? 'sat' : r.weekday === '日' ? 'sun' : '';
    return '<tr class="' + cls + '" data-i="' + i + '">' +
      '<td>' + r.day + '日(' + r.weekday + ')</td>' +
      '<td><input type="checkbox" class="c-confirm"' + (r.isConfirmed ? ' checked' : '') + '></td>' +
      '<td><select class="c-type">' + opts + '</select></td>' +
      '<td><textarea class="c-note"></textarea></td>' +
      '<td><input type="checkbox" class="c-lock"' + (r.isDayLocked ? ' checked' : '') + '></td>' +
      '<td><input type="text" class="c-in" value="' + (r.clockIn || '') + '" placeholder="09:00"></td>' +
      '<td><input type="text" class="c-out" value="' + fmtOut(r.clockOut) + '" placeholder="18:00"></td>' +
      '<td><input type="text" class="c-brk" value="' + r.breakMinutes + '"></td>' +
      '<td><input type="text" class="c-ot" value="' + r.overtimeMinutes + '"></td>' +
      '<td class="worked">' + hhmm(r.workedMinutes) + '</td>' +
      '<td><textarea class="c-dnote"></textarea></td>' +
      '</tr>';
  }).join('');

  // textarea と select は値を DOM 経由で入れる（HTML 埋め込みを避ける）
  sheet.rows.forEach((r, i) => {
    const tr = document.querySelector('tr[data-i="' + i + '"]');
    tr.querySelector('.c-note').value = r.note || '';
    tr.querySelector('.c-dnote').value = r.dayNote || '';
    tr.querySelector('.c-type').value = r.isAbsent ? '__off' : (r.shiftTypeId || '');
    applyLock(tr);
    tr.querySelector('.c-lock').addEventListener('change', () => applyLock(tr));
  });
}

// 現行 shift_flg2（当日確認）: 立つと実績側の入力を編集不可にする
function applyLock(tr) {
  const locked = tr.querySelector('.c-lock').checked;
  for (const sel of ['.c-in', '.c-out', '.c-brk', '.c-ot', '.c-dnote']) {
    tr.querySelector(sel).readOnly = locked;
  }
}

document.getElementById('load').addEventListener('click', load);

document.getElementById('save').addEventListener('click', async () => {
  if (!sheet) return;
  setMsg('保存中…', true);
  let ng = 0;
  for (let i = 0; i < sheet.rows.length; i++) {
    const tr = document.querySelector('tr[data-i="' + i + '"]');
    const type = tr.querySelector('.c-type').value;
    const cin = normTime(tr.querySelector('.c-in').value);
    const cout = normTime(tr.querySelector('.c-out').value);
    const note = tr.querySelector('.c-note').value;
    const dnote = tr.querySelector('.c-dnote').value;
    const confirmed = tr.querySelector('.c-confirm').checked;
    // 何も入っていない日は送らない
    if (!type && !cin && !cout && !note && !dnote && !confirmed) continue;

    const res = await fetch('/api/shifts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeId: sheet.employeeId,
        workedOn: sheet.rows[i].workedOn,
        shiftTypeId: (type && type !== '__off') ? type : null,
        clockIn: cin || null,
        clockOut: cout || null,
        breakMinutes: Number(tr.querySelector('.c-brk').value || 0),
        overtimeMinutes: Number(tr.querySelector('.c-ot').value || 0),
        isAbsent: type === '__off',
        isConfirmed: confirmed,
        isDayLocked: tr.querySelector('.c-lock').checked,
        note: note || null,
        dayNote: dnote || null,
      }),
    });
    if (!res.ok) ng++;
  }

  await fetch('/api/shifts/urgent-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeId: sheet.employeeId,
      yearMonth: sheet.yearMonth,
      needsUrgentCheck: document.getElementById('urgent').checked,
    }),
  });

  setMsg(ng === 0 ? '登録しました' : (ng + '件が登録できませんでした'), ng === 0);
  await load();
});

(() => {
  const p = new URLSearchParams(location.search);
  if (p.get('yearMonth')) { document.getElementById('ym').value = p.get('yearMonth'); load(); }
})();
</script>
</body>
</html>`;
}

// ===============================================================
// 従業員一覧・登録・修正（T-7）
// ===============================================================
/**
 * 🔴 現行から意図的に変えた点:
 *   B-35 入力値のエスケープ。画面は textContent 経由で描画し innerHTML に値を混ぜない
 *   B-38 外部 CDN 依存なし
 *   現行の登録画面（index2.html）にあった「勤務時間帯 ki（1〜4=A〜D）」は
 *   会社ごとの shift_types から選ばせる形に変えた（設計書 4.5 の訂正）
 *   現行に無かった「入社日」を追加した。これが無いと勤続年数が常に空になる
 */
const ADMIN_STYLE = `
  body { align-items: flex-start; }
  .login { max-width: 960px; padding-top: 32px; }
  .bar { display: flex; gap: 8px; align-items: flex-end; margin-bottom: 16px; flex-wrap: wrap; }
  .bar .row { margin-bottom: 0; }
  .bar button { width: auto; padding: 10px 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #e4e9ee; white-space: nowrap; }
  th { color: #6b7885; font-weight: 600; background: #f7f9fb; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .tag.active { background: #e6f2e6; color: #256b25; }
  .tag.suspended { background: #fdf0e0; color: #8a5a12; }
  .tag.resigned { background: #eceff2; color: #6b7885; }
  .scroll { overflow-x: auto; }
  a.btn { display: inline-block; padding: 10px 16px; background: #2f6fbf; color: #fff;
          border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 600; }
  .links { margin-top: 16px; font-size: 13px; }
  .links a { color: #2f6fbf; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 16px; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
  .req { color: #a32020; }
  .hint { font-size: 12px; color: #6b7885; margin-top: 4px; }
  input[type=date], input[type=email] {
    width: 100%; padding: 11px 12px; font-size: 16px;
    border: 1px solid #c8d0d8; border-radius: 6px; background: #fff;
  }
  .ok { background: #e6f2e6; border: 1px solid #a8cfa8; color: #256b25;
        padding: 10px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
`;

export function employeeListPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>従業員一覧 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}</style>
</head>
<body class="hashdr">
${headerHtml(p, "/employees")}
<div class="login">
  <h1>従業員一覧</h1>
  <div class="box">
    <div class="bar">
      <div class="row" style="flex:1 1 200px">
        <label for="kw">氏名・カナ・従業員番号</label>
        <input type="text" id="kw" placeholder="部分一致">
      </div>
      <div class="row" style="flex:0 0 140px">
        <label for="st">状態</label>
        <select id="st">
          <option value="">すべて</option>
          <option value="active" selected>在籍</option>
          <option value="suspended">休止</option>
          <option value="resigned">退職</option>
        </select>
      </div>
      <div class="row"><button id="go">表示</button></div>
      <div class="row"><a class="btn" href="/employees/new">新規登録</a></div>
    </div>
    <p id="msg"></p>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>番号</th><th>氏名</th><th>カナ</th><th>ログインID</th>
          <th>雇用形態</th><th>勤務時間帯</th><th>入社日</th><th>状態</th><th></th>
        </tr></thead>
        <tbody id="rows"><tr><td colspan="9">読み込み中…</td></tr></tbody>
      </table>
    </div>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a> ／ <a href="/attendance">勤怠評価</a></p>
</div>
<script>
const EMPLOYMENT = { assistant_manager:'副店長', regular:'社員', part_time:'アルバイト', cleaner:'清掃員', other:'その他' };
const STATUS = { active:'在籍', suspended:'休止', resigned:'退職' };

function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text === null || text === undefined || text === '' ? '-' : String(text);
  return td;
}

async function load() {
  const q = new URLSearchParams();
  const kw = document.getElementById('kw').value.trim();
  const st = document.getElementById('st').value;
  if (kw !== '') q.set('keyword', kw);
  if (st !== '') q.set('status', st);
  const res = await fetch('/api/employees?' + q.toString());
  if (res.status === 401) { location.href = '/login'; return; }
  const tbody = document.getElementById('rows');
  tbody.replaceChildren();
  if (res.status === 403) {
    const tr = document.createElement('tr');
    tr.appendChild(cell('この画面を見る権限がありません'));
    tr.firstChild.colSpan = 9;
    tbody.appendChild(tr);
    return;
  }
  const data = await res.json();
  document.getElementById('msg').textContent = data.count + ' 件';
  if (data.employees.length === 0) {
    const tr = document.createElement('tr');
    const td = cell('該当する従業員がいません');
    td.colSpan = 9;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const e of data.employees) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(e.employeeCode));
    tr.appendChild(cell(e.name));
    tr.appendChild(cell(e.nameKana));
    tr.appendChild(cell(e.loginId));
    tr.appendChild(cell(EMPLOYMENT[e.employmentType] || e.employmentType));
    tr.appendChild(cell(e.shiftTypeName));
    tr.appendChild(cell(e.hiredOn));
    const tdS = document.createElement('td');
    const span = document.createElement('span');
    span.className = 'tag ' + e.status;
    span.textContent = STATUS[e.status] || e.status;
    tdS.appendChild(span);
    tr.appendChild(tdS);
    const tdA = document.createElement('td');
    const a = document.createElement('a');
    a.href = '/employees/new?employeeId=' + encodeURIComponent(e.id);
    a.textContent = '修正';
    a.style.color = '#2f6fbf';
    tdA.appendChild(a);
    tdA.appendChild(document.createTextNode(' '));
    const a2 = document.createElement('a');
    a2.href = '/attendance?employeeId=' + encodeURIComponent(e.id);
    a2.textContent = '勤怠';
    a2.style.color = '#2f6fbf';
    tdA.appendChild(a2);
    tdA.appendChild(document.createTextNode(' '));
    const a3 = document.createElement('a');
    a3.href = '/profile/view?employeeId=' + encodeURIComponent(e.id);
    a3.textContent = 'プロフィール';
    a3.style.color = '#2f6fbf';
    tdA.appendChild(a3);
    tr.appendChild(tdA);
    tbody.appendChild(tr);
  }
}
document.getElementById('go').addEventListener('click', load);
document.getElementById('kw').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') load(); });
load();
</script>
</body>
</html>`;
}

/** 登録と修正を1つの画面で兼ねる。employeeId があれば修正モード */
export function employeeFormPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>従業員登録 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}
  .login { max-width: 620px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/employees")}
<div class="login">
  <h1 id="title">従業員登録</h1>
  <div class="box">
    <p class="error" id="err" style="display:none"></p>
    <p class="ok" id="ok" style="display:none"></p>
    <div class="grid">
      <div class="row">
        <label for="name">氏名 <span class="req">*</span></label>
        <input type="text" id="name" required>
      </div>
      <div class="row">
        <label for="nameKana">カナ</label>
        <input type="text" id="nameKana">
      </div>
      <div class="row">
        <label for="employeeCode">従業員番号</label>
        <input type="text" id="employeeCode">
        <p class="hint">会社内で重複できません</p>
      </div>
      <div class="row">
        <label for="employmentType">雇用形態 <span class="req">*</span></label>
        <select id="employmentType">
          <option value="regular">社員</option>
          <option value="assistant_manager">副店長</option>
          <option value="part_time">アルバイト</option>
          <option value="cleaner">清掃員</option>
          <option value="other">その他</option>
        </select>
      </div>
      <div class="row">
        <label for="birthOn">生年月日</label>
        <input type="date" id="birthOn">
      </div>
      <div class="row">
        <label for="hiredOn">入社日</label>
        <input type="date" id="hiredOn">
        <p class="hint">未入力だと勤続年数が出ません</p>
      </div>
      <div class="row">
        <label for="gender">性別</label>
        <select id="gender">
          <option value="">未選択</option>
          <option value="male">男性</option>
          <option value="female">女性</option>
          <option value="other">その他</option>
          <option value="undisclosed">回答しない</option>
        </select>
      </div>
      <div class="row">
        <label for="shiftTypeId">既定の勤務時間帯</label>
        <select id="shiftTypeId"><option value="">未設定</option></select>
      </div>
    </div>

    <div id="newOnly">
      <div class="row">
        <label for="loginId">ログインID <span class="req">*</span></label>
        <input type="text" id="loginId" autocapitalize="off">
        <p class="hint">全社で重複できません</p>
      </div>
      <div class="row">
        <label for="email">メールアドレス</label>
        <input type="email" id="email">
      </div>
      <div class="row">
        <label for="password">初期パスワード <span class="req">*</span></label>
        <input type="password" id="password" autocomplete="new-password">
        <p class="hint">12文字以上。控えて本人に直接伝えてください（メール送信はしません）</p>
      </div>
    </div>

    <div class="row" id="editOnly" style="display:none">
      <label for="status">状態</label>
      <select id="status">
        <option value="active">在籍</option>
        <option value="suspended">休止</option>
        <option value="resigned">退職</option>
      </select>
    </div>

    <button id="save">保存</button>
  </div>
  <p class="links"><a href="/employees">従業員一覧へ戻る</a> ／ <a href="/home">ホーム</a></p>
</div>
<script>
const LABEL = {
  name:'氏名', nameKana:'カナ', employeeCode:'従業員番号', loginId:'ログインID',
  password:'パスワード', email:'メールアドレス', employmentType:'雇用形態',
  gender:'性別', birthOn:'生年月日', hiredOn:'入社日', shiftTypeId:'勤務時間帯',
  worksiteId:'事業場', status:'状態', employeeId:'従業員'
};
const CODE = {
  required:'を入力してください', too_short:'が短すぎます',
  invalid_format:'の形式が正しくありません', invalid_value:'の値が正しくありません',
  already_taken:'は既に使われています', not_a_real_date:'が実在しない日付です',
  out_of_range:'が範囲外です', in_the_future:'が未来の日付です',
  before_birth:'が生年月日より前です', not_found:'が見つかりません'
};
const employeeId = new URLSearchParams(location.search).get('employeeId');
const $ = (id) => document.getElementById(id);

function show(el, text) { el.textContent = text; el.style.display = text === '' ? 'none' : 'block'; }

async function init() {
  const st = await fetch('/api/shift-types');
  if (st.status === 401) { location.href = '/login'; return; }
  if (st.ok) {
    const d = await st.json();
    for (const t of d.shiftTypes) {
      const o = document.createElement('option');
      o.value = t.id;
      o.textContent = t.code + ': ' + t.name;
      $('shiftTypeId').appendChild(o);
    }
  }
  if (employeeId === null) return;

  $('title').textContent = '従業員の修正';
  $('newOnly').style.display = 'none';
  $('editOnly').style.display = 'block';
  const res = await fetch('/api/employees/detail?employeeId=' + encodeURIComponent(employeeId));
  if (!res.ok) { show($('err'), '従業員を読み込めませんでした'); return; }
  const e = (await res.json()).employee;
  for (const k of ['name','nameKana','employeeCode','employmentType','birthOn','hiredOn','gender','shiftTypeId','status']) {
    $(k).value = e[k] === null ? '' : e[k];
  }
}

$('save').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), '');
  $('save').disabled = true;
  const base = {
    name: $('name').value,
    nameKana: $('nameKana').value,
    employeeCode: $('employeeCode').value,
    employmentType: $('employmentType').value,
    birthOn: $('birthOn').value === '' ? null : $('birthOn').value,
    hiredOn: $('hiredOn').value === '' ? null : $('hiredOn').value,
    gender: $('gender').value === '' ? null : $('gender').value,
    shiftTypeId: $('shiftTypeId').value === '' ? null : $('shiftTypeId').value
  };
  const isEdit = employeeId !== null;
  const url = isEdit ? '/api/employees/update' : '/api/employees';
  const body = isEdit
    ? Object.assign({ employeeId: employeeId, status: $('status').value }, base)
    : Object.assign({ loginId: $('loginId').value, email: $('email').value === '' ? null : $('email').value,
                      password: $('password').value }, base);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify(body)
  });
  $('save').disabled = false;
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.ok) {
    if (isEdit) { show($('ok'), '保存しました'); }
    else { location.href = '/employees'; }
    return;
  }
  const d = await res.json().catch(() => ({}));
  if (d.issues) {
    show($('err'), d.issues.map((i) => (LABEL[i.field] || i.field) + (CODE[i.code] || 'が不正です')).join(' / '));
  } else if (res.status === 403) {
    show($('err'), 'この操作を行う権限がありません');
  } else {
    show($('err'), '保存できませんでした');
  }
});
init();
</script>
</body>
</html>`;
}

// ===============================================================
// 勤怠評価の表示（Session 04 / T-10）
// ===============================================================
/**
 * ⚠ 「点数化」は要件に含めない【会話合意 2026-08-15】。
 *
 *   Session 04 で改修設計書 v6 全文（1,459行）を検索した結果:
 *     - 勤怠の点数化の計算式・配点・重み付けの記述は 0件
 *     - 5.1 優先5 の定義は「遅刻・早退・欠勤・残業・勤続・年齢」= 実績値のみ
 *     - 6.3 の「点数」は Session 02 で **ストレスチェックの結果** と訂正済み
 *   ➡ 勤怠の点数化は現行システムに存在せず、v1 の誤読に由来していた。
 *      本画面の項目で設計書 5.1 の定義を満たしている。
 *
 * ⚠ 期間は締め日基準。yearMonth=2026-08・締め日20日 なら 2026-07-21〜2026-08-20
 *   （仕様書 v1 5.2）。画面にも期間を明示し、誤読を防ぐ。
 */
export function attendancePage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>勤怠評価 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}
  .login { max-width: 720px; }
  .kpi { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 20px; }
  @media (max-width: 560px) { .kpi { grid-template-columns: repeat(2, 1fr); } }
  /* ⚠ 子セレクタにすること。.kpi div だと内側の .k / .v にも枠が付き二重になる */
  .kpi > div { background: #f7f9fb; border: 1px solid #e4e9ee; border-radius: 8px; padding: 12px 14px; }
  .kpi .k { font-size: 12px; color: #6b7885; }
  .kpi .v { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .kpi .u { font-size: 12px; font-weight: 400; color: #6b7885; margin-left: 2px; }
  .period { font-size: 13px; color: #46535f; margin-bottom: 16px; }
  .pending { background: #fdf6e3; border: 1px solid #e6d5a8; color: #6b5510;
             padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-top: 18px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/attendance")}
<div class="login">
  <h1>勤怠評価</h1>
  <div class="box">
    <div class="bar">
      <div class="row" style="flex:1 1 220px">
        <label for="emp">従業員</label>
        <select id="emp"><option value="">読み込み中…</option></select>
      </div>
      <div class="row" style="flex:0 0 140px">
        <label for="ym">年月</label>
        <input type="text" id="ym" placeholder="2026-09">
      </div>
      <div class="row"><button id="go">表示</button></div>
    </div>
    <p class="error" id="err" style="display:none"></p>
    <p class="period" id="period"></p>
    <div class="kpi" id="kpi"></div>
    <table id="detail"><tbody></tbody></table>
    <p class="pending">この画面は実績値を表示します。勤怠の点数化は行いません。</p>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a>${canEdit(p, "account") ? ' ／ <a href="/employees">従業員一覧</a>' : ""}</p>
</div>
<script>
const $ = (id) => document.getElementById(id);
function show(el, text) { el.textContent = text; el.style.display = text === '' ? 'none' : 'block'; }
function hm(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return h + ':' + String(m).padStart(2, '0');
}
function card(k, v, u) {
  const d = document.createElement('div');
  const a = document.createElement('div'); a.className = 'k'; a.textContent = k;
  const b = document.createElement('div'); b.className = 'v'; b.textContent = v;
  if (u) { const s = document.createElement('span'); s.className = 'u'; s.textContent = u; b.appendChild(s); }
  d.appendChild(a); d.appendChild(b);
  return d;
}
function row(k, v) {
  const tr = document.createElement('tr');
  const th = document.createElement('th'); th.textContent = k;
  const td = document.createElement('td'); td.textContent = v;
  tr.appendChild(th); tr.appendChild(td);
  return tr;
}

async function init() {
  const res = await fetch('/api/employees?status=active');
  if (res.status === 401) { location.href = '/login'; return; }
  const sel = $('emp');
  sel.replaceChildren();
  if (!res.ok) {
    const o = document.createElement('option');
    o.textContent = '取得できません';
    sel.appendChild(o);
    return;
  }
  const d = await res.json();
  for (const e of d.employees) {
    const o = document.createElement('option');
    o.value = e.id;
    o.textContent = e.name + (e.employeeCode ? ' (' + e.employeeCode + ')' : '');
    sel.appendChild(o);
  }
  const q = new URLSearchParams(location.search);
  if (q.get('employeeId')) sel.value = q.get('employeeId');
  const now = new Date();
  $('ym').value = q.get('yearMonth') ||
    now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  if (d.employees.length > 0) load();
}

async function load() {
  show($('err'), '');
  const employeeId = $('emp').value;
  const yearMonth = $('ym').value.trim();
  if (employeeId === '' || yearMonth === '') { show($('err'), '従業員と年月を指定してください'); return; }
  const res = await fetch('/api/attendance/evaluation?employeeId=' + encodeURIComponent(employeeId) +
                          '&yearMonth=' + encodeURIComponent(yearMonth));
  if (res.status === 401) { location.href = '/login'; return; }
  $('kpi').replaceChildren();
  $('detail').querySelector('tbody').replaceChildren();
  if (!res.ok) {
    show($('err'), res.status === 403 ? 'この従業員を見る権限がありません' : '取得できませんでした');
    $('period').textContent = '';
    return;
  }
  const r = await res.json();
  $('period').textContent = '対象期間 ' + r.periodStartOn + ' 〜 ' + r.periodEndOn + '（締め日基準）';
  const kpi = $('kpi');
  kpi.appendChild(card('出勤日数', String(r.workDays), '日'));
  kpi.appendChild(card('実働', hm(r.workedMinutes)));
  kpi.appendChild(card('残業', hm(r.overtimeMinutes)));
  kpi.appendChild(card('遅刻', String(r.lateCount), '回'));
  kpi.appendChild(card('早退', String(r.earlyLeaveCount), '回'));
  kpi.appendChild(card('欠勤', String(r.absenceCount), '回'));
  const tb = $('detail').querySelector('tbody');
  // ⚠ attendanceRate は services 側で既に百分率（例 75）。ここで100倍しない
  tb.appendChild(row('出勤率', r.attendanceRate === null ? '－（登録なし）'
    : r.attendanceRate + ' %'));
  tb.appendChild(row('勤続', r.tenure === null ? '－（入社日が未登録）'
    : r.tenure.years + '年' + r.tenure.months + 'か月'));
  tb.appendChild(row('年齢', r.age === null ? '－（生年月日が未登録）' : r.age + '歳'));
  const bt = Object.entries(r.byShiftType).filter(([, v]) => v > 0);
  tb.appendChild(row('勤務時間帯の内訳',
    bt.length === 0 ? '－' : bt.map(([k, v]) => k + ': ' + v + '日').join(' / ')));
}
$('go').addEventListener('click', load);
$('ym').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') load(); });
init();
</script>
</body>
</html>`;
}

// ===============================================================
// プロフィール（機能権限表 区分5 / T-16）
// ===============================================================
/**
 * 現行 profile3Template.php の項目をそのまま踏襲する:
 *   画像（1枚）／ Profile（自由入力）／ Note（自由入力）
 *
 * 🔴 現行から変えた点:
 *   ・写真は認証必須の /api/profile/photo から読む（公開ディレクトリに置かない）
 *   ・パスワード列を表示分岐に使わない（現行は {if $userp->SU1_PASS ==""}）
 *   ・編集できるのは自分のプロフィールだけ
 */
const PROFILE_STYLE = `
  .photo { width: 160px; height: 160px; border-radius: 8px; object-fit: cover;
           border: 1px solid #c8d0d8; background: #f7f9fb; display: block; }
  .nophoto { width: 160px; height: 160px; border-radius: 8px; border: 1px dashed #c8d0d8;
             background: #f7f9fb; color: #6b7885; font-size: 13px;
             display: flex; align-items: center; justify-content: center; }
  .photorow { display: flex; gap: 16px; align-items: flex-start; margin-bottom: 20px; flex-wrap: wrap; }
  .photorow .ctl { flex: 1 1 220px; }
  @media (max-width: 480px) {
    .photo, .nophoto { width: 120px; height: 120px; }
    .photorow { gap: 12px; }
    .photorow .ctl { flex: 1 1 100%; }
  }
  .photorow .ctl button { width: auto; padding: 9px 14px; margin-right: 8px; }
  .danger { background: #a32020; }
  textarea { width: 100%; padding: 11px 12px; font-size: 16px; box-sizing: border-box;
             border: 1px solid #c8d0d8; border-radius: 6px; min-height: 120px; font-family: inherit; }
  .body { white-space: pre-wrap; font-size: 15px; line-height: 1.7; }
`;

export function profilePage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>プロフィール | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}${PROFILE_STYLE}
  .login { max-width: 620px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/profile")}
<div class="login">
  <h1>プロフィール</h1>
  <div class="box">
    <p class="error" id="err" style="display:none"></p>
    <p class="ok" id="ok" style="display:none"></p>
    <p id="who" class="hint"></p>

    <div class="photorow">
      <div id="photobox"></div>
      <div class="ctl">
        <label for="file">顔写真</label>
        <input type="file" id="file" accept="image/jpeg,image/png,image/gif">
        <p class="hint">JPEG / PNG / GIF・5MB まで</p>
        <button id="up">この画像に変更</button>
        <button id="del" class="danger">写真を削除</button>
      </div>
    </div>

    <div class="row">
      <label for="text">Profile</label>
      <textarea id="text" maxlength="2000"></textarea>
    </div>
    <div class="row">
      <label for="note">Note</label>
      <textarea id="note" maxlength="2000"></textarea>
    </div>
    <button id="save">保存</button>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a>${canEdit(p, "account") ? ' ／ <a href="/employees">従業員一覧</a>' : ""}</p>
</div>
<script>
const $ = (id) => document.getElementById(id);
let employeeId = null;
function show(el, t) { el.textContent = t; el.style.display = t === '' ? 'none' : 'block'; }

function drawPhoto(has) {
  const box = $('photobox');
  box.replaceChildren();
  if (has) {
    const img = document.createElement('img');
    img.className = 'photo';
    img.alt = '顔写真';
    // キャッシュを避けるため時刻を付ける
    img.src = '/api/profile/photo?employeeId=' + encodeURIComponent(employeeId) + '&t=' + Date.now();
    box.appendChild(img);
  } else {
    const d = document.createElement('div');
    d.className = 'nophoto';
    d.textContent = '写真なし';
    box.appendChild(d);
  }
}

async function load() {
  const res = await fetch('/api/profile');
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.status === 404) {
    // このアカウントに従業員レコードが無い（F-8 の修正前に作られたテナント）
    show($('err'), 'このアカウントには従業員の登録がないため、プロフィールを使えません。従業員一覧から登録してください。');
    return;
  }
  if (!res.ok) { show($('err'), 'プロフィールを読み込めませんでした'); return; }
  const p = (await res.json()).profile;
  employeeId = p.employeeId;
  $('who').textContent = p.name + ' さんのプロフィール';
  $('text').value = p.profileText === null ? '' : p.profileText;
  $('note').value = p.profileNote === null ? '' : p.profileNote;
  drawPhoto(p.hasPhoto);
}

$('save').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), '');
  const res = await fetch('/api/profile/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify({ profileText: $('text').value, profileNote: $('note').value })
  });
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.ok) { show($('ok'), '保存しました'); return; }
  const d = await res.json().catch(() => ({}));
  show($('err'), d.issues ? '入力が長すぎます（2000文字まで）' : '保存できませんでした');
});

// F-9: ファイルを選び直したら、前のエラー表示を消す
$('file').addEventListener('change', () => { show($('err'), ''); show($('ok'), ''); });

$('up').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), '');
  const f = $('file').files[0];
  if (!f) { show($('err'), '画像を選んでください'); return; }
  if (f.size > 5 * 1024 * 1024) { show($('err'), '画像が大きすぎます（5MBまで）'); return; }
  $('up').disabled = true;
  const res = await fetch('/api/profile/photo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Origin': location.origin },
    body: f
  });
  $('up').disabled = false;
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.ok) { show($('ok'), '写真を変更しました'); $('file').value = ''; drawPhoto(true); return; }
  if (res.status === 413) { show($('err'), '画像が大きすぎます（5MBまで）'); return; }
  show($('err'), 'JPEG / PNG / GIF の画像を選んでください');
});

$('del').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), '');
  const res = await fetch('/api/profile/photo/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: '{}'
  });
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.ok) { show($('ok'), '写真を削除しました'); drawPhoto(false); return; }
  show($('err'), '削除できませんでした');
});
load();
</script>
</body>
</html>`;
}

/** 他人のプロフィールの閲覧。編集の手段を一切置かない */
export function profileViewPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>プロフィール詳細 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}${PROFILE_STYLE}
  .login { max-width: 620px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/profile")}
<div class="login">
  <h1 id="title">プロフィール詳細</h1>
  <div class="box">
    <p class="error" id="err" style="display:none"></p>
    <div class="photorow"><div id="photobox"></div></div>
    <div class="row"><label>Profile</label><p class="body" id="text">-</p></div>
    <div class="row"><label>Note</label><p class="body" id="note">-</p></div>
    <p id="mine" class="hint" style="display:none"><a href="/profile">自分のプロフィールを編集する</a></p>
  </div>
  <p class="links">${canEdit(p, "account") ? '<a href="/employees">従業員一覧へ戻る</a> ／ ' : ""}<a href="/home">ホーム</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
const employeeId = new URLSearchParams(location.search).get('employeeId');

async function load() {
  if (employeeId === null) { $('err').textContent = '従業員が指定されていません'; $('err').style.display = 'block'; return; }
  const res = await fetch('/api/profile/detail?employeeId=' + encodeURIComponent(employeeId));
  if (res.status === 401) { location.href = '/login'; return; }
  if (!res.ok) {
    $('err').textContent = res.status === 404 ? '見つかりませんでした' : '読み込めませんでした';
    $('err').style.display = 'block';
    return;
  }
  const d = await res.json();
  const p = d.profile;
  $('title').textContent = p.name + ' さんのプロフィール';
  $('text').textContent = p.profileText === null || p.profileText === '' ? '-' : p.profileText;
  $('note').textContent = p.profileNote === null || p.profileNote === '' ? '-' : p.profileNote;
  const box = $('photobox');
  box.replaceChildren();
  if (p.hasPhoto) {
    const img = document.createElement('img');
    img.className = 'photo';
    img.alt = '顔写真';
    img.src = '/api/profile/photo?employeeId=' + encodeURIComponent(employeeId);
    box.appendChild(img);
  } else {
    const e = document.createElement('div');
    e.className = 'nophoto';
    e.textContent = '写真なし';
    box.appendChild(e);
  }
  if (d.editable) $('mine').style.display = 'block';
}
load();
</script>
</body>
</html>`;
}

// ===============================================================
// 店舗情報＝月次の人事指標レポート（機能権限表 区分4 / T-21）
// ===============================================================
/**
 * 現行 company1Template.php の項目を踏襲する:
 *   対象月 ／ 募集数 ／ 採用数 ／ 離職数 ／ 予備管理（→「備考」に改称）
 *
 * 🔴 現行から変えた点:
 *   ・平均勤続と平均年齢は保存値ではなく、都度算出した値を参考表示する
 *   ・年間集計テーブルを持たず、一覧で合算する
 *   ・締め日の扱いを階層で分けない（現行はマスタ②に分岐が無かった）
 */
export function reportListPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>店舗情報（月次） | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}
  .kpi { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
  @media (max-width: 640px) { .kpi { grid-template-columns: repeat(2, 1fr); gap: 8px; } }
  @media (max-width: 380px) { .kpi { grid-template-columns: 1fr; } }
  .kpi > div { background: #f7f9fb; border: 1px solid #e4e9ee; border-radius: 8px; padding: 12px 14px; }
  .kpi .k { font-size: 12px; color: #6b7885; }
  .kpi .v { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .kpi .u { font-size: 12px; font-weight: 400; color: #6b7885; margin-left: 2px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/reports")}
<div class="login">
  <h1>店舗情報（月次）</h1>
  <div class="box">
    <div class="bar">
      <div class="row" style="flex:0 0 140px">
        <label for="year">年</label>
        <input type="text" id="year" placeholder="2026">
      </div>
      <div class="row"><button id="go">表示</button></div>
      <div class="row"><a class="btn" href="/reports/edit">月次を登録</a></div>
    </div>
    <p class="error" id="err" style="display:none"></p>
    <div class="kpi" id="kpi"></div>
    <div class="scroll">
      <table>
        <thead><tr><th>対象月</th><th>店舗</th><th>募集</th><th>採用</th><th>離職</th><th>備考</th><th></th></tr></thead>
        <tbody id="rows"><tr><td colspan="7">読み込み中…</td></tr></tbody>
      </table>
    </div>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
function cell(t, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = t === null || t === undefined || t === '' ? '-' : String(t);
  return td;
}
function card(k, v, u) {
  const d = document.createElement('div');
  const a = document.createElement('div'); a.className = 'k'; a.textContent = k;
  const b = document.createElement('div'); b.className = 'v'; b.textContent = v;
  if (u) { const s = document.createElement('span'); s.className = 'u'; s.textContent = u; b.appendChild(s); }
  d.appendChild(a); d.appendChild(b);
  return d;
}

async function load() {
  $('err').style.display = 'none';
  const q = new URLSearchParams();
  const y = $('year').value.trim();
  if (y !== '') q.set('year', y);
  const res = await fetch('/api/reports?' + q.toString());
  if (res.status === 401) { location.href = '/login'; return; }
  const tbody = $('rows');
  tbody.replaceChildren();
  $('kpi').replaceChildren();
  if (res.status === 403) {
    const tr = document.createElement('tr');
    const td = cell('この画面を見る権限がありません'); td.colSpan = 7;
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  if (!res.ok) { $('err').textContent = '取得できませんでした'; $('err').style.display = 'block'; return; }
  const d = await res.json();
  const k = $('kpi');
  k.appendChild(card('募集', String(d.totals.recruitCount), '人'));
  k.appendChild(card('採用', String(d.totals.hireCount), '人'));
  k.appendChild(card('離職', String(d.totals.turnoverCount), '人'));
  k.appendChild(card('離職率', d.turnoverRate === null ? '－' : d.turnoverRate + ' %'));
  if (d.reports.length === 0) {
    const tr = document.createElement('tr');
    const td = cell('登録がありません'); td.colSpan = 7;
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  for (const r of d.reports) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(r.periodYearMonth));
    tr.appendChild(cell(r.worksiteName));
    tr.appendChild(cell(r.recruitCount, 'num'));
    tr.appendChild(cell(r.hireCount, 'num'));
    tr.appendChild(cell(r.turnoverCount, 'num'));
    tr.appendChild(cell(r.note));
    const td = document.createElement('td');
    const a = document.createElement('a');
    a.href = '/reports/edit?reportId=' + encodeURIComponent(r.id);
    a.textContent = '修正';
    a.style.color = '#2f6fbf';
    td.appendChild(a);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}
$('go').addEventListener('click', load);
$('year').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
$('year').value = String(new Date().getFullYear());
load();
</script>
</body>
</html>`;
}

export function reportFormPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>月次の登録 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}
  .login { max-width: 560px; }
  input[type=number] { width: 100%; padding: 11px 12px; font-size: 16px; box-sizing: border-box;
                       border: 1px solid #c8d0d8; border-radius: 6px; }
  .ref { background: #f7f9fb; border: 1px solid #e4e9ee; border-radius: 8px;
         padding: 12px 14px; font-size: 13px; color: #46535f; margin-top: 18px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/reports")}
<div class="login">
  <h1 id="title">月次の登録</h1>
  <div class="box">
    <p class="error" id="err" style="display:none"></p>
    <p class="ok" id="ok" style="display:none"></p>
    <div class="row">
      <label for="ym">対象月 <span class="req">*</span></label>
      <input type="text" id="ym" placeholder="2026-08">
      <p class="hint">同じ店舗・同じ月は上書きされます</p>
    </div>
    <div class="row">
      <label for="ws">店舗</label>
      <select id="ws"><option value="">未指定</option></select>
    </div>
    <div class="grid">
      <div class="row"><label for="recruit">募集数</label><input type="number" id="recruit" min="0" value="0"></div>
      <div class="row"><label for="hire">採用数</label><input type="number" id="hire" min="0" value="0"></div>
      <div class="row"><label for="turnover">離職数</label><input type="number" id="turnover" min="0" value="0"></div>
    </div>
    <div class="row">
      <label for="note">備考</label>
      <input type="text" id="note">
      <p class="hint">現行の「予備管理」にあたります</p>
    </div>
    <button id="save">登録／修正</button>
    <div class="ref" id="ref">在籍・平均勤続・平均年齢は、対象月を入れると表示されます。</div>
  </div>
  <p class="links"><a href="/reports">一覧へ戻る</a> ／ <a href="/home">ホーム</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
const reportId = new URLSearchParams(location.search).get('reportId');
function show(el, t) { el.textContent = t; el.style.display = t === '' ? 'none' : 'block'; }

async function loadWorksites() {
  const res = await fetch('/api/employees?status=active');
  if (res.status === 401) { location.href = '/login'; return; }
}

async function loadRef() {
  const ym = $('ym').value.trim();
  if (!/^\\d{4}-\\d{2}$/.test(ym)) { $('ref').textContent = '在籍・平均勤続・平均年齢は、対象月を入れると表示されます。'; return; }
  const res = await fetch('/api/reports/workforce?periodYearMonth=' + encodeURIComponent(ym));
  if (!res.ok) { $('ref').textContent = '参考値を取得できませんでした'; return; }
  const d = await res.json();
  const tenure = d.avgTenureMonths === null ? '－'
    : Math.floor(d.avgTenureMonths / 12) + '年' + Math.round(d.avgTenureMonths % 12) + 'か月';
  $('ref').textContent = '参考（' + ym + '末時点・保存しません）　在籍 ' + d.headcount +
    '人／平均勤続 ' + tenure + '／平均年齢 ' + (d.avgAge === null ? '－' : d.avgAge + '歳');
}

async function init() {
  const now = new Date();
  $('ym').value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  if (reportId !== null) {
    $('title').textContent = '月次の修正';
    const res = await fetch('/api/reports/detail?reportId=' + encodeURIComponent(reportId));
    if (res.status === 401) { location.href = '/login'; return; }
    if (res.ok) {
      const r = (await res.json()).report;
      $('ym').value = r.periodYearMonth;
      $('recruit').value = r.recruitCount;
      $('hire').value = r.hireCount;
      $('turnover').value = r.turnoverCount;
      $('note').value = r.note === null ? '' : r.note;
      if (r.worksiteId !== null) {
        const o = document.createElement('option');
        o.value = r.worksiteId;
        o.textContent = r.worksiteName === null ? r.worksiteId : r.worksiteName;
        o.selected = true;
        $('ws').appendChild(o);
      }
    }
  }
  loadRef();
}

$('ym').addEventListener('change', loadRef);
$('save').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), '');
  const res = await fetch('/api/reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify({
      worksiteId: $('ws').value === '' ? null : $('ws').value,
      periodYearMonth: $('ym').value.trim(),
      recruitCount: Number($('recruit').value || 0),
      hireCount: Number($('hire').value || 0),
      turnoverCount: Number($('turnover').value || 0),
      note: $('note').value
    })
  });
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.ok) { show($('ok'), '保存しました'); loadRef(); return; }
  if (res.status === 403) { show($('err'), 'この操作を行う権限がありません'); return; }
  const d = await res.json().catch(() => ({}));
  if (d.issues) {
    const L = { periodYearMonth: '対象月', recruitCount: '募集数', hireCount: '採用数',
                turnoverCount: '離職数', note: '備考', worksiteId: '店舗' };
    show($('err'), d.issues.map((i) => (L[i.field] || i.field) + 'を確認してください').join(' / '));
  } else { show($('err'), '保存できませんでした'); }
});
init();
</script>
</body>
</html>`;
}

// ===============================================================
// 業務日報（機能権限表 区分10 / T-28）
// ===============================================================
/**
 * 現行 dreport2Template.php の項目を踏襲する:
 *   日付 ／ カテゴリ ／ 時間（開始〜終了）／ 内容 ／ 画像
 *
 * 🔴 現行から変えた点:
 *   ・外部CDN（cdn.rawgit.com）に依存しない。rawgit は2019年に終了しており、
 *     timepicker が読み込めていなかった可能性が高い。標準の input[type=time] を使う
 *   ・画像は認証必須の API から読む（現行は ../images/ の公開ディレクトリ）
 *   ・削除は URL クエリではなく POST で、所有者を突き合わせてから実行する
 */
export function dailyReportListPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>業務日報 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}</style>
</head>
<body class="hashdr">
${headerHtml(p, "/daily-reports")}
<div class="login">
  <h1>業務日報</h1>
  <div class="box">
    <div class="bar">
      <div class="row" style="flex:0 0 150px">
        <label for="month">対象月</label>
        <input type="text" id="month" placeholder="2026-08">
      </div>
      <div class="row"><button id="go">表示</button></div>
      ${canEdit(p, "daily_report") ? '<div class="row"><a class="btn" href="/daily-reports/edit">新規登録</a></div>' : ""}
    </div>
    <p id="msg"></p>
    <div class="scroll">
      <table>
        <thead><tr><th>日付</th><th>時間</th><th>所要</th><th>カテゴリ</th><th>担当</th><th>内容</th><th></th></tr></thead>
        <tbody id="rows"><tr><td colspan="7">読み込み中…</td></tr></tbody>
      </table>
    </div>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a>${canEditReportCategory(p) ? ' ／ <a href="/daily-reports/categories">カテゴリの管理</a>' : ""}</p>
</div>
<script>
const $ = (id) => document.getElementById(id);
function cell(t) {
  const td = document.createElement('td');
  td.textContent = t === null || t === undefined || t === '' ? '-' : String(t);
  return td;
}
function hm(min) { return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0'); }
// 24時超え表記を「翌 HH:MM」に直す（保存は 26:30 のまま）
function showEnd(t) {
  const [h, m] = t.split(':').map(Number);
  return h >= 24 ? '翌 ' + String(h - 24).padStart(2, '0') + ':' + String(m).padStart(2, '0') : t;
}

async function load() {
  const q = new URLSearchParams();
  const m = $('month').value.trim();
  if (m !== '') q.set('month', m);
  const res = await fetch('/api/daily-reports?' + q.toString());
  if (res.status === 401) { location.href = '/login'; return; }
  const tbody = $('rows');
  tbody.replaceChildren();
  if (!res.ok) {
    const tr = document.createElement('tr');
    const td = cell('取得できませんでした'); td.colSpan = 7;
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  const d = await res.json();
  $('msg').textContent = d.count + ' 件';
  if (d.reports.length === 0) {
    const tr = document.createElement('tr');
    const td = cell('登録がありません'); td.colSpan = 7;
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  for (const r of d.reports) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(r.reportedOn));
    tr.appendChild(cell(r.startTime + '〜' + showEnd(r.endTime)));
    tr.appendChild(cell(hm(r.durationMinutes)));
    tr.appendChild(cell(r.categoryName));
    tr.appendChild(cell(r.employeeName));
    tr.appendChild(cell(r.body === null ? '' : r.body.slice(0, 20)));
    const td = document.createElement('td');
    const a = document.createElement('a');
    a.href = '/daily-reports/edit?reportId=' + encodeURIComponent(r.id);
    a.textContent = '修正';
    a.style.color = '#2f6fbf';
    td.appendChild(a);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}
$('go').addEventListener('click', load);
$('month').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
const now = new Date();
$('month').value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
load();
</script>
</body>
</html>`;
}

export function dailyReportFormPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>業務日報 登録 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}
  .login { max-width: 560px; }
  input[type=date], input[type=time] { width: 100%; padding: 11px 12px; font-size: 16px;
    box-sizing: border-box; border: 1px solid #c8d0d8; border-radius: 6px; background: #fff; }
  textarea { width: 100%; padding: 11px 12px; font-size: 16px; box-sizing: border-box;
    border: 1px solid #c8d0d8; border-radius: 6px; min-height: 120px; font-family: inherit; }
  .warn { background: #fdf6e3; border: 1px solid #e6d5a8; color: #6b5510;
          padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; }
  .photo { max-width: 100%; border-radius: 8px; border: 1px solid #c8d0d8; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/daily-reports")}
<div class="login">
  <h1 id="title">業務日報 登録</h1>
  <div class="box">
    <p class="error" id="err" style="display:none"></p>
    <p class="ok" id="ok" style="display:none"></p>
    <p class="warn" id="warn" style="display:none"></p>

    <div class="row">
      <label for="day">日付 <span class="req">*</span></label>
      <input type="date" id="day">
    </div>
    <div class="row">
      <label for="cate">カテゴリ</label>
      <select id="cate"><option value="">未設定</option></select>
    </div>
    <div class="grid">
      <div class="row"><label for="t1">開始 <span class="req">*</span></label><input type="time" id="t1"></div>
      <div class="row"><label for="t2">終了 <span class="req">*</span></label><input type="time" id="t2"></div>
    </div>
    <p class="hint" id="dur">終了が開始より前なら翌日として扱います</p>
    <div class="row">
      <label for="body">内容</label>
      <textarea id="body" maxlength="2000"></textarea>
    </div>
    <button id="save">保存</button>

    <div id="photobox" style="display:none">
      <div class="row" style="margin-top:20px">
        <label for="file">画像</label>
        <input type="file" id="file" accept="image/jpeg,image/png,image/gif">
        <p class="hint">JPEG / PNG / GIF・5MB まで</p>
        <button id="up">この画像を添付</button>
      </div>
      <div id="preview"></div>
    </div>
    <button id="del" class="danger" style="display:none;background:#a32020;margin-top:12px">この日報を削除</button>
  </div>
  <p class="links"><a href="/daily-reports">一覧へ戻る</a> ／ <a href="/home">ホーム</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
let reportId = new URLSearchParams(location.search).get('reportId');
function show(el, t) { el.textContent = t; el.style.display = t === '' ? 'none' : 'block'; }

function updateDur() {
  const a = $('t1').value, b = $('t2').value;
  if (a === '' || b === '') { $('dur').textContent = '終了が開始より前なら翌日として扱います'; return; }
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  let d = (bh * 60 + bm) - (ah * 60 + am);
  if (d < 0) d += 24 * 60;
  $('dur').textContent = d === 0 ? '開始と終了が同じです' :
    '所要 ' + Math.floor(d / 60) + '時間' + (d % 60) + '分' + (bh * 60 + bm < ah * 60 + am ? '（翌日にまたがります）' : '');
}

function drawPhoto(has) {
  const p = $('preview');
  p.replaceChildren();
  if (!has) return;
  const img = document.createElement('img');
  img.className = 'photo';
  img.alt = '添付画像';
  img.src = '/api/daily-reports/photo?reportId=' + encodeURIComponent(reportId) + '&t=' + Date.now();
  p.appendChild(img);
}

async function init() {
  const res = await fetch('/api/daily-reports/categories');
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.ok) {
    for (const c of (await res.json()).categories) {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      $('cate').appendChild(o);
    }
  }
  const now = new Date();
  $('day').value = now.toISOString().slice(0, 10);
  if (reportId === null) return;

  $('title').textContent = '業務日報 修正';
  const r2 = await fetch('/api/daily-reports/detail?reportId=' + encodeURIComponent(reportId));
  if (!r2.ok) { show($('err'), '日報を読み込めませんでした'); return; }
  const d = await r2.json();
  const r = d.report;
  $('day').value = r.reportedOn;
  $('cate').value = r.categoryId === null ? '' : r.categoryId;
  $('t1').value = r.startTime;
  // 24時超え表記は input[type=time] に入らないので戻す
  const [eh, em] = r.endTime.split(':').map(Number);
  $('t2').value = String(eh >= 24 ? eh - 24 : eh).padStart(2, '0') + ':' + String(em).padStart(2, '0');
  $('body').value = r.body === null ? '' : r.body;
  $('photobox').style.display = 'block';
  $('del').style.display = 'block';
  drawPhoto(r.hasPhoto);
  updateDur();
}

$('t1').addEventListener('change', updateDur);
$('t2').addEventListener('change', updateDur);

$('save').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), ''); show($('warn'), '');
  const res = await fetch('/api/daily-reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify({
      reportId: reportId,
      categoryId: $('cate').value === '' ? null : $('cate').value,
      reportedOn: $('day').value,
      startTime: $('t1').value,
      endTime: $('t2').value,
      body: $('body').value
    })
  });
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.status === 403) { show($('err'), 'この操作を行う権限がありません'); return; }
  if (res.ok) {
    const d = await res.json();
    reportId = d.id;
    show($('ok'), '保存しました');
    $('photobox').style.display = 'block';
    $('del').style.display = 'block';
    if (d.overlaps && d.overlaps.length > 0) {
      show($('warn'), '注意：時間帯が重なる日報が ' + d.overlaps.length + ' 件あります（登録は完了しています）');
    }
    return;
  }
  const d = await res.json().catch(() => ({}));
  if (d.issues) {
    const L = { reportedOn: '日付', startTime: '開始時刻', endTime: '終了時刻', body: '内容',
                categoryId: 'カテゴリ', employeeId: '担当' };
    show($('err'), d.issues.map((i) => (L[i.field] || i.field) +
      (i.code === 'same_as_start' ? 'が開始と同じです' : 'を確認してください')).join(' / '));
  } else { show($('err'), '保存できませんでした'); }
});

// F-9: ファイルを選び直したら、前のエラー表示を消す
$('file').addEventListener('change', () => { show($('err'), ''); show($('ok'), ''); });

$('up').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), '');
  const f = $('file').files[0];
  if (!f) { show($('err'), '画像を選んでください'); return; }
  const res = await fetch('/api/daily-reports/photo?reportId=' + encodeURIComponent(reportId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Origin': location.origin },
    body: f
  });
  if (res.ok) { show($('ok'), '画像を添付しました'); $('file').value = ''; drawPhoto(true); return; }
  if (res.status === 413) { show($('err'), '画像が大きすぎます（5MBまで）'); return; }
  show($('err'), 'JPEG / PNG / GIF の画像を選んでください');
});

$('del').addEventListener('click', async () => {
  if (!confirm('削除します。よろしいですか?')) return;
  const res = await fetch('/api/daily-reports/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify({ reportId: reportId })
  });
  if (res.ok) { location.href = '/daily-reports'; return; }
  show($('err'), '削除できませんでした');
});
init();
</script>
</body>
</html>`;
}

/** 日報カテゴリの管理。現行マスタ①の「業務日報 > マスターデータ」に相当 */
export function reportCategoryPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>日報カテゴリ | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}
  .login { max-width: 620px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/daily-reports")}
<div class="login">
  <h1>日報カテゴリ（マスターデータ）</h1>
  <div class="box">
    <p class="error" id="err" style="display:none"></p>
    <p class="ok" id="ok" style="display:none"></p>
    <div class="bar">
      <div class="row" style="flex:1 1 200px">
        <label for="name">カテゴリ名</label>
        <input type="text" id="name" maxlength="100">
      </div>
      <div class="row" style="flex:0 0 100px">
        <label for="order">並び順</label>
        <input type="text" id="order" value="0">
      </div>
      <div class="row"><button id="add">追加</button></div>
    </div>
    <table>
      <thead><tr><th>並び</th><th>カテゴリ名</th><th>状態</th><th></th></tr></thead>
      <tbody id="rows"><tr><td colspan="4">読み込み中…</td></tr></tbody>
    </table>
  </div>
  <p class="links"><a href="/daily-reports">業務日報へ戻る</a> ／ <a href="/home">ホーム</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
function show(el, t) { el.textContent = t; el.style.display = t === '' ? 'none' : 'block'; }
function cell(t) {
  const td = document.createElement('td');
  td.textContent = t === null || t === undefined || t === '' ? '-' : String(t);
  return td;
}

async function load() {
  const res = await fetch('/api/daily-reports/categories?includeInactive=1');
  if (res.status === 401) { location.href = '/login'; return; }
  const tbody = $('rows');
  tbody.replaceChildren();
  if (res.status === 403) {
    const tr = document.createElement('tr');
    const td = cell('この画面を見る権限がありません'); td.colSpan = 4;
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  const cats = (await res.json()).categories;
  if (cats.length === 0) {
    const tr = document.createElement('tr');
    const td = cell('カテゴリがありません'); td.colSpan = 4;
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  for (const c of cats) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(c.sortOrder));
    tr.appendChild(cell(c.name));
    tr.appendChild(cell(c.isActive ? '有効' : '停止'));
    const td = document.createElement('td');
    const b = document.createElement('button');
    b.textContent = c.isActive ? '停止する' : '有効に戻す';
    b.style.width = 'auto';
    b.style.padding = '6px 12px';
    b.style.fontSize = '13px';
    b.addEventListener('click', () => toggle(c));
    td.appendChild(b);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

async function post(body) {
  return fetch('/api/daily-reports/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify(body)
  });
}

async function toggle(c) {
  show($('err'), ''); show($('ok'), '');
  const res = await post({ id: c.id, name: c.name, sortOrder: c.sortOrder, isActive: !c.isActive });
  if (res.ok) { show($('ok'), '更新しました'); load(); return; }
  show($('err'), '更新できませんでした');
}

$('add').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), '');
  const name = $('name').value.trim();
  if (name === '') { show($('err'), 'カテゴリ名を入力してください'); return; }
  const res = await post({ name: name, sortOrder: Number($('order').value || 0) });
  if (res.ok) { show($('ok'), '追加しました'); $('name').value = ''; load(); return; }
  if (res.status === 403) { show($('err'), 'この操作を行う権限がありません'); return; }
  const d = await res.json().catch(() => ({}));
  show($('err'), d.issues && d.issues.some((i) => i.code === 'already_taken')
    ? '同じ名前のカテゴリが既にあります' : '追加できませんでした');
});
load();
</script>
</body>
</html>`;
}

// ===============================================================
// 社内フォト共有（機能権限表 区分8 / T-33）
// ===============================================================
/**
 * 現行 chat2Template.php の有効な項目は「画像1枚」と「ひと言」だけ。
 * 画像②〜⑤・ひと言②〜⑤（8項目）はすべてコメントアウトされていた【コード実証】。
 *
 * 🔴 現行から変えた点:
 *   ・画像は認証必須の API から読む（現行は ../image/ の公開ディレクトリ）
 *   ・削除は投稿者本人と人事権系統のみ
 *   ・未使用の hidden（company_name1/2）を置かない
 * ✅ 踏襲した点:
 *   ・投稿前のプレビュー（FileReader）。現行の良い実装
 */
const PHOTO_GRID_STYLE = `
  .grid2 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  @media (max-width: 640px) { .grid2 { grid-template-columns: repeat(2, 1fr); } }
  .card { border: 1px solid #e4e9ee; border-radius: 8px; overflow: hidden; background: #fff; }
  .card img { width: 100%; aspect-ratio: 1 / 1; object-fit: cover; display: block; background: #f7f9fb; }
  .card .meta { padding: 8px 10px; font-size: 13px; }
  .card .cap { color: #23303a; word-break: break-word; }
  .card .by { color: #6b7885; font-size: 12px; margin-top: 4px; }
  .card button { width: auto; padding: 5px 10px; font-size: 12px; background: #a32020; margin-top: 6px; }
  .preview img { max-width: 100%; border-radius: 8px; border: 1px solid #c8d0d8; margin-top: 10px; }
`;

export function photoListPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>社内フォト共有 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}${PHOTO_GRID_STYLE}</style>
</head>
<body class="hashdr">
${headerHtml(p, "/photos")}
<div class="login">
  <h1>社内フォト共有</h1>
  <div class="box">
    <div class="bar">
      <div class="row"><a class="btn" href="/photos/new">写真を投稿</a></div>
      <div class="row" style="flex:1 1 auto"><p id="msg" class="hint"></p></div>
    </div>
    <p class="error" id="err" style="display:none"></p>
    <div class="grid2" id="grid"></div>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
let own = null, canDeleteAny = false;

async function load() {
  const res = await fetch('/api/photos');
  if (res.status === 401) { location.href = '/login'; return; }
  const grid = $('grid');
  grid.replaceChildren();
  if (!res.ok) { $('err').textContent = '取得できませんでした'; $('err').style.display = 'block'; return; }
  const d = await res.json();
  own = d.ownEmployeeId;
  canDeleteAny = d.canDeleteAny;
  $('msg').textContent = d.count + ' 件';
  if (d.posts.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'まだ投稿がありません';
    grid.appendChild(p);
    return;
  }
  for (const post of d.posts) {
    const card = document.createElement('div');
    card.className = 'card';
    const img = document.createElement('img');
    img.alt = post.caption === null ? '投稿写真' : post.caption;
    img.loading = 'lazy';
    img.src = '/api/photos/photo?postId=' + encodeURIComponent(post.id);
    card.appendChild(img);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = post.caption === null || post.caption === '' ? '－' : post.caption;
    meta.appendChild(cap);
    const by = document.createElement('div');
    by.className = 'by';
    by.textContent = (post.employeeName === null ? '不明' : post.employeeName) + '／' + post.postedOn;
    meta.appendChild(by);
    if (post.employeeId === own || canDeleteAny) {
      const b = document.createElement('button');
      b.textContent = '削除';
      b.addEventListener('click', () => del(post.id));
      meta.appendChild(b);
    }
    card.appendChild(meta);
    grid.appendChild(card);
  }
}

async function del(postId) {
  if (!confirm('この写真を削除します。よろしいですか?')) return;
  const res = await fetch('/api/photos/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify({ postId: postId })
  });
  if (res.ok) { load(); return; }
  $('err').textContent = res.status === 403 ? '削除する権限がありません' : '削除できませんでした';
  $('err').style.display = 'block';
}
load();
</script>
</body>
</html>`;
}

export function photoNewPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>写真を投稿 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}${PHOTO_GRID_STYLE}
  .login { max-width: 520px; }
  input[type=date] { width: 100%; padding: 11px 12px; font-size: 16px; box-sizing: border-box;
    border: 1px solid #c8d0d8; border-radius: 6px; background: #fff; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/photos")}
<div class="login">
  <h1>写真を投稿</h1>
  <div class="box">
    <p class="error" id="err" style="display:none"></p>
    <div class="row">
      <label for="file">画像 <span class="req">*</span></label>
      <input type="file" id="file" accept="image/jpeg,image/png,image/gif">
      <p class="hint">JPEG / PNG / GIF・5MB まで</p>
      <div class="preview" id="preview"></div>
    </div>
    <div class="row">
      <label for="cap">ひと言</label>
      <input type="text" id="cap" maxlength="200">
    </div>
    <div class="row">
      <label for="day">日付</label>
      <input type="date" id="day">
    </div>
    <button id="post">投稿する</button>
  </div>
  <p class="links"><a href="/photos">一覧へ戻る</a> ／ <a href="/home">ホーム</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
function show(t) { $('err').textContent = t; $('err').style.display = t === '' ? 'none' : 'block'; }

// 現行 chat2Template の良い実装を踏襲：投稿前にプレビューする
$('file').addEventListener('change', function() {
  const p = $('preview');
  p.replaceChildren();
  const f = this.files[0];
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) { show('画像が大きすぎます（5MBまで）'); this.value = ''; return; }
  show('');
  const img = document.createElement('img');
  img.alt = 'プレビュー';
  const fr = new FileReader();
  fr.onload = () => { img.src = fr.result; };
  fr.readAsDataURL(f);
  p.appendChild(img);
});

$('post').addEventListener('click', async () => {
  show('');
  const f = $('file').files[0];
  if (!f) { show('画像を選んでください'); return; }
  const q = new URLSearchParams();
  q.set('caption', $('cap').value);
  q.set('postedOn', $('day').value);
  $('post').disabled = true;
  const res = await fetch('/api/photos?' + q.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Origin': location.origin },
    body: f
  });
  $('post').disabled = false;
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.ok) { location.href = '/photos'; return; }
  if (res.status === 413) { show('画像が大きすぎます（5MBまで）'); return; }
  show('JPEG / PNG / GIF の画像を選んでください');
});
$('day').value = new Date().toISOString().slice(0, 10);
</script>
</body>
</html>`;
}

// ===============================================================
// ありがとう情報（機能権限表 区分7 / T-39）
// ===============================================================
/**
 * 現行 thanks2Template.php の項目を踏襲する:
 *   日付 ／ 誰へ ／ フリー入力
 *
 * 🔴 現行から変えた点:
 *   ・「ありがとう数(月30まで)」を表示だけでなく実際に効かせる
 *     （現行は Action に検査が0件で、31回目以降も登録できていた）
 *   ・宛先から自分自身を除く
 *   ・獲得順位は集計テーブルではなく都度算出した値を表示する
 */
const THANKS_STYLE = `
  .quota { background: #f7f9fb; border: 1px solid #e4e9ee; border-radius: 8px;
           padding: 12px 14px; font-size: 14px; margin-bottom: 18px; }
  .quota strong { font-size: 20px; font-variant-numeric: tabular-nums; }
  .quota.full { background: #fdf0e0; border-color: #e6c99a; color: #8a5a12; }
  .feed { list-style: none; padding: 0; margin: 0; }
  .feed li { border-bottom: 1px solid #e4e9ee; padding: 12px 2px; }
  .feed .to { font-weight: 600; color: #23303a; }
  .feed .msg { font-size: 14px; color: #46535f; margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
  .feed .by { font-size: 12px; color: #6b7885; margin-top: 4px; }
  td.rank { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; }
  tr.me { background: #f2f6fb; }
`;

export function thanksListPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ありがとう情報 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}${THANKS_STYLE}
  .login { max-width: 620px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/thanks")}
<div class="login">
  <h1>ありがとう情報</h1>
  <div class="box">
    <div class="bar">
      <div class="row"><a class="btn" href="/thanks/new">ありがとうをする</a></div>
      <div class="row"><a class="btn" href="/thanks/ranking" style="background:#6b7885">獲得順位</a></div>
    </div>
    <div class="row" style="max-width:200px">
      <label for="period">対象月</label>
      <input type="text" id="period" placeholder="すべて">
    </div>
    <p class="error" id="err" style="display:none"></p>
    <p id="msg" class="hint"></p>
    <ul class="feed" id="feed"></ul>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);

async function load() {
  const q = new URLSearchParams();
  const p = $('period').value.trim();
  if (p !== '') q.set('period', p);
  const res = await fetch('/api/thanks?' + q.toString());
  if (res.status === 401) { location.href = '/login'; return; }
  const feed = $('feed');
  feed.replaceChildren();
  if (!res.ok) { $('err').textContent = '取得できませんでした'; $('err').style.display = 'block'; return; }
  $('err').style.display = 'none';
  const d = await res.json();
  $('msg').textContent = d.count + ' 件';
  if (d.thanks.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'まだありません';
    feed.appendChild(li);
    return;
  }
  for (const t of d.thanks) {
    const li = document.createElement('li');
    const to = document.createElement('div');
    to.className = 'to';
    to.textContent = (t.toName === null ? '不明' : t.toName) + ' さんへ';
    li.appendChild(to);
    if (t.message !== null && t.message !== '') {
      const m = document.createElement('div');
      m.className = 'msg';
      m.textContent = t.message;
      li.appendChild(m);
    }
    const by = document.createElement('div');
    by.className = 'by';
    by.textContent = (t.fromName === null ? '不明' : t.fromName) + ' より　' + t.thankedOn + '（' + t.periodYearMonth + ' 分）';
    li.appendChild(by);
    feed.appendChild(li);
  }
}
$('period').addEventListener('change', load);
load();
</script>
</body>
</html>`;
}

export function thanksNewPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>ありがとうをする | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}${THANKS_STYLE}
  .login { max-width: 520px; }
  input[type=date] { width: 100%; padding: 11px 12px; font-size: 16px; box-sizing: border-box;
    border: 1px solid #c8d0d8; border-radius: 6px; background: #fff; }
  textarea { width: 100%; padding: 11px 12px; font-size: 16px; box-sizing: border-box;
    border: 1px solid #c8d0d8; border-radius: 6px; min-height: 100px; font-family: inherit; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/thanks")}
<div class="login">
  <h1>ありがとうをする</h1>
  <div class="box">
    <p class="error" id="err" style="display:none"></p>
    <p class="ok" id="ok" style="display:none"></p>
    <div class="quota" id="quota">読み込み中…</div>
    <div class="row">
      <label for="day">日付</label>
      <input type="date" id="day">
    </div>
    <div class="row">
      <label for="to">誰へ <span class="req">*</span></label>
      <select id="to"><option value="">選んでください</option></select>
      <p class="hint">自分自身には送れません</p>
    </div>
    <div class="row">
      <label for="msg">フリー入力</label>
      <textarea id="msg" maxlength="500"></textarea>
    </div>
    <button id="send">ありがとう</button>
  </div>
  <p class="links"><a href="/thanks">一覧へ戻る</a> ／ <a href="/home">ホーム</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
let own = null;
function show(el, t) { el.textContent = t; el.style.display = t === '' ? 'none' : 'block'; }

async function loadQuota() {
  const q = new URLSearchParams();
  if ($('day').value !== '') q.set('thankedOn', $('day').value);
  const res = await fetch('/api/thanks/quota?' + q.toString());
  if (res.status === 401) { location.href = '/login'; return; }
  const box = $('quota');
  box.replaceChildren();
  box.className = 'quota';
  if (!res.ok) { box.textContent = '送信可能数を取得できませんでした'; return; }
  const d = await res.json();
  const s = document.createElement('span');
  s.textContent = d.period + ' 分：';
  const n = document.createElement('strong');
  n.textContent = String(d.sent);
  const rest = document.createElement('span');
  rest.textContent = ' / ' + d.limit + ' 回（あと ' + d.remaining + ' 回）';
  box.appendChild(s); box.appendChild(n); box.appendChild(rest);
  if (d.remaining === 0) {
    box.className = 'quota full';
    $('send').disabled = true;
  } else {
    $('send').disabled = false;
  }
}

async function init() {
  $('day').value = new Date().toISOString().slice(0, 10);
  const me = await fetch('/api/profile');
  if (me.status === 401) { location.href = '/login'; return; }
  if (me.ok) own = (await me.json()).profile.employeeId;
  const res = await fetch('/api/employees?status=active');
  if (res.ok) {
    for (const e of (await res.json()).employees) {
      if (e.id === own) continue; // 🔴 自分自身は宛先に出さない
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.name;
      $('to').appendChild(o);
    }
  }
  loadQuota();
}

$('day').addEventListener('change', loadQuota);

$('send').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), '');
  if ($('to').value === '') { show($('err'), '送る相手を選んでください'); return; }
  const res = await fetch('/api/thanks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify({
      toEmployeeId: $('to').value,
      message: $('msg').value,
      thankedOn: $('day').value
    })
  });
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.ok) {
    show($('ok'), 'ありがとうを送りました');
    $('msg').value = '';
    loadQuota();
    return;
  }
  if (res.status === 429) { show($('err'), '今月の上限（30回）に達しています'); loadQuota(); return; }
  const d = await res.json().catch(() => ({}));
  if (d.issues && d.issues.some((i) => i.code === 'same_as_sender')) {
    show($('err'), '自分自身には送れません');
  } else if (d.issues) {
    show($('err'), '入力を確認してください');
  } else {
    show($('err'), '送信できませんでした');
  }
});
init();
</script>
</body>
</html>`;
}

export function thanksRankingPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>獲得順位 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}${THANKS_STYLE}
  .login { max-width: 560px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/thanks")}
<div class="login">
  <h1>獲得順位</h1>
  <div class="box">
    <div class="bar">
      <div class="row" style="flex:0 0 150px">
        <label for="period">対象月</label>
        <input type="text" id="period" placeholder="すべて">
      </div>
      <div class="row"><button id="go">表示</button></div>
    </div>
    <p class="error" id="err" style="display:none"></p>
    <table>
      <thead><tr><th style="width:60px">順位</th><th>氏名</th><th style="width:90px">獲得数</th></tr></thead>
      <tbody id="rows"><tr><td colspan="3">読み込み中…</td></tr></tbody>
    </table>
    <p class="hint">受け取った「ありがとう」の件数で集計しています。同数は同順位です。</p>
  </div>
  <p class="links"><a href="/thanks">ありがとう情報へ戻る</a> ／ <a href="/home">ホーム</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
let own = null;

async function load() {
  const q = new URLSearchParams();
  const p = $('period').value.trim();
  if (p !== '') q.set('period', p);
  const res = await fetch('/api/thanks/ranking?' + q.toString());
  if (res.status === 401) { location.href = '/login'; return; }
  const tbody = $('rows');
  tbody.replaceChildren();
  if (!res.ok) { $('err').textContent = '取得できませんでした'; $('err').style.display = 'block'; return; }
  $('err').style.display = 'none';
  const d = await res.json();
  if (d.ranking.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.textContent = 'まだ集計できる記録がありません';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const r of d.ranking) {
    const tr = document.createElement('tr');
    if (r.employeeId === own) tr.className = 'me';
    const a = document.createElement('td'); a.className = 'rank'; a.textContent = String(r.rank);
    const b = document.createElement('td'); b.textContent = r.employeeName === null ? '不明' : r.employeeName;
    const c = document.createElement('td'); c.className = 'num'; c.textContent = String(r.receivedCount);
    tr.appendChild(a); tr.appendChild(b); tr.appendChild(c);
    tbody.appendChild(tr);
  }
}
$('go').addEventListener('click', load);
$('period').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
fetch('/api/profile').then((r) => r.ok ? r.json() : null).then((d) => {
  if (d) own = d.profile.employeeId;
  load();
});
</script>
</body>
</html>`;
}

// ===============================================================
// スキルシート（機能権限表 区分9 / T-45）
// ===============================================================
/**
 * 現行 user3skill2Template.php_back（本人用）と user2skill1Template.php（管理用）を踏襲する。
 *
 * 🔴 現行から変えた点:
 *   ・業務内容に公開/非公開の切り替えを設ける（現行は必ず本人に見えた）
 *   ・遅刻・早退・当欠はシフトから算出した値を提示し、上書きできる
 *   ・残業数は本人の画面に出さない（現行のマスタ③画面に列が無い＝踏襲）
 */
const SKILL_STYLE = `
  .note { background: #f7f9fb; border: 1px solid #e4e9ee; border-radius: 8px;
          padding: 10px 12px; font-size: 13px; color: #46535f; margin-bottom: 16px; }
  td.cmt { max-width: 260px; white-space: pre-wrap; word-break: break-word; font-size: 13px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .badge.open { background: #e6f2e6; color: #256b25; }
  .badge.closed { background: #eceff2; color: #6b7885; }
  .sugg { font-size: 12px; color: #6b7885; margin-top: 4px; }
  .sugg button { width: auto; padding: 4px 10px; font-size: 12px; background: #6b7885; margin-left: 6px; }
`;

export function skillSheetPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>スキルシート | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}${SKILL_STYLE}</style>
</head>
<body class="hashdr">
${headerHtml(p, "/skill-sheets")}
<div class="login">
  <h1>スキルシート</h1>
  <div class="box">
    <div class="bar">
      <div class="row" style="flex:1 1 200px">
        <label for="emp">対象者</label>
        <select id="emp"><option value="">自分</option></select>
      </div>
      <div class="row" style="flex:0 0 120px">
        <label for="year">年度</label>
        <input type="text" id="year">
      </div>
      <div class="row"><button id="go">表示</button></div>
      <div class="row" id="editbar" style="display:none">
        <a class="btn" href="/skill-sheets/edit">登録／修正</a>
      </div>
    </div>
    <p class="error" id="err" style="display:none"></p>
    <p class="note" id="note"></p>
    <div class="scroll">
      <table>
        <thead><tr id="head"></tr></thead>
        <tbody id="rows"><tr><td colspan="7">読み込み中…</td></tr></tbody>
      </table>
    </div>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
let canEdit = false;

function cell(t, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = t === null || t === undefined || t === '' ? '-' : String(t);
  return td;
}
function th(t) { const e = document.createElement('th'); e.textContent = t; return e; }

async function loadEmployees() {
  const res = await fetch('/api/employees?status=active');
  if (res.status === 401) { location.href = '/login'; return; }
  if (!res.ok) return; // 権限が無ければ自分の分だけ
  canEdit = true;
  $('editbar').style.display = 'block';
  for (const e of (await res.json()).employees) {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.name;
    $('emp').appendChild(o);
  }
}

async function load() {
  const q = new URLSearchParams();
  q.set('year', $('year').value.trim());
  if ($('emp').value !== '') q.set('employeeId', $('emp').value);
  const res = await fetch('/api/skill-sheets?' + q.toString());
  if (res.status === 401) { location.href = '/login'; return; }
  const tbody = $('rows');
  tbody.replaceChildren();
  $('head').replaceChildren();
  if (!res.ok) { $('err').textContent = '取得できませんでした'; $('err').style.display = 'block'; return; }
  $('err').style.display = 'none';
  const d = await res.json();

  // 🔴 管理側だけ残業数の列を出す
  const cols = ['対象月', '出勤数', '遅刻数', '早退数', '当欠数'];
  if (d.canEdit) cols.push('残業数');
  cols.push('ありがとう数', '業務内容');
  if (d.canEdit) cols.push('公開');
  for (const c of cols) $('head').appendChild(th(c));

  $('note').textContent = d.canEdit
    ? '業務内容は「公開」が有効なものだけ本人に表示されます。残業数は本人には表示されません。'
    : '自分のスキルシートです。管理者が公開した業務内容のみ表示されます。';

  if (d.sheets.length === 0) {
    const tr = document.createElement('tr');
    const td = cell('この年度の記録がありません'); td.colSpan = cols.length;
    tr.appendChild(td); tbody.appendChild(tr);
    return;
  }
  for (const s of d.sheets) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(s.periodYearMonth.slice(5) + '月'));
    tr.appendChild(cell(s.workDays, 'num'));
    tr.appendChild(cell(s.lateCount, 'num'));
    tr.appendChild(cell(s.earlyLeaveCount, 'num'));
    tr.appendChild(cell(s.absenceCount, 'num'));
    if (d.canEdit) tr.appendChild(cell(s.overtimeCount, 'num'));
    tr.appendChild(cell(s.thanksCount, 'num'));
    tr.appendChild(cell(s.comment, 'cmt'));
    if (d.canEdit) {
      const td = document.createElement('td');
      const b = document.createElement('span');
      b.className = 'badge ' + (s.commentVisibleToEmployee ? 'open' : 'closed');
      b.textContent = s.commentVisibleToEmployee ? '公開' : '非公開';
      td.appendChild(b);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}
$('go').addEventListener('click', load);
$('year').value = String(new Date().getFullYear());
loadEmployees().then(load);
</script>
</body>
</html>`;
}

export function skillSheetFormPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>スキルシート 登録/修正 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}${SKILL_STYLE}
  .login { max-width: 560px; }
  textarea { width: 100%; padding: 11px 12px; font-size: 16px; box-sizing: border-box;
    border: 1px solid #c8d0d8; border-radius: 6px; min-height: 120px; font-family: inherit; }
  input[type=number] { width: 100%; padding: 11px 12px; font-size: 16px; box-sizing: border-box;
    border: 1px solid #c8d0d8; border-radius: 6px; }
  .chk { display: flex; align-items: center; gap: 8px; font-size: 14px; }
  .chk input { width: auto; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/skill-sheets")}
<div class="login">
  <h1>スキルシート 登録/修正</h1>
  <div class="box">
    <p class="error" id="err" style="display:none"></p>
    <p class="ok" id="ok" style="display:none"></p>
    <div class="bar">
      <div class="row" style="flex:1 1 180px">
        <label for="emp">対象スタッフ <span class="req">*</span></label>
        <select id="emp"></select>
      </div>
      <div class="row" style="flex:0 0 150px">
        <label for="ym">対象月 <span class="req">*</span></label>
        <input type="text" id="ym" placeholder="2026-08">
      </div>
      <div class="row"><button id="fetch">読み込み</button></div>
    </div>
    <p class="sugg" id="sugg"></p>

    <div class="grid">
      <div class="row"><label for="late">遅刻数</label><input type="number" id="late" min="0" value="0"></div>
      <div class="row"><label for="early">早退数</label><input type="number" id="early" min="0" value="0"></div>
      <div class="row"><label for="absence">当欠数</label><input type="number" id="absence" min="0" value="0"></div>
      <div class="row">
        <label for="overtime">残業数</label>
        <input type="number" id="overtime" min="0" value="0">
        <p class="hint">本人の画面には表示されません</p>
      </div>
    </div>

    <div class="row">
      <label for="comment">業務内容</label>
      <textarea id="comment" maxlength="2000"></textarea>
      <p class="chk" style="margin-top:8px">
        <input type="checkbox" id="visible">
        <label for="visible" style="margin:0">この業務内容を本人にも表示する</label>
      </p>
      <p class="hint">既定は非公開です。本人に見せる前提の内容だけ公開してください</p>
    </div>
    <button id="save">登録／修正</button>
  </div>
  <p class="links"><a href="/skill-sheets">一覧へ戻る</a> ／ <a href="/home">ホーム</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
function show(el, t) { el.textContent = t; el.style.display = t === '' ? 'none' : 'block'; }

async function init() {
  const res = await fetch('/api/employees?status=active');
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.status === 403) { show($('err'), 'この画面を使う権限がありません'); return; }
  if (res.ok) {
    for (const e of (await res.json()).employees) {
      const o = document.createElement('option');
      o.value = e.id; o.textContent = e.name;
      $('emp').appendChild(o);
    }
  }
  const now = new Date();
  $('ym').value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  loadSheet();
}

async function loadSheet() {
  show($('err'), ''); show($('ok'), '');
  if ($('emp').value === '' || $('ym').value.trim() === '') return;
  const q = new URLSearchParams();
  q.set('employeeId', $('emp').value);
  q.set('periodYearMonth', $('ym').value.trim());
  const res = await fetch('/api/skill-sheets/detail?' + q.toString());
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.status === 403) { show($('err'), 'この画面を使う権限がありません'); return; }
  if (!res.ok) { show($('err'), '読み込めませんでした'); return; }
  const d = await res.json();
  const g = d.suggested;
  $('sugg').textContent = 'シフトの実績：出勤 ' + g.workDays + '日／遅刻 ' + g.lateCount +
    '／早退 ' + g.earlyLeaveCount + '／当欠 ' + g.absenceCount + '／残業のあった日 ' + g.overtimeCount;
  if (d.sheet === null) {
    // 未登録ならシフトの実績を初期値にする（保存はされていない提示値）
    $('late').value = g.lateCount;
    $('early').value = g.earlyLeaveCount;
    $('absence').value = g.absenceCount;
    $('overtime').value = g.overtimeCount;
    $('comment').value = '';
    $('visible').checked = false;
  } else {
    $('late').value = d.sheet.lateCount;
    $('early').value = d.sheet.earlyLeaveCount;
    $('absence').value = d.sheet.absenceCount;
    $('overtime').value = d.sheet.overtimeCount;
    $('comment').value = d.sheet.comment === null ? '' : d.sheet.comment;
    $('visible').checked = d.sheet.commentVisibleToEmployee;
  }
}

$('fetch').addEventListener('click', loadSheet);
$('emp').addEventListener('change', loadSheet);
$('ym').addEventListener('change', loadSheet);

$('save').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), '');
  const res = await fetch('/api/skill-sheets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify({
      employeeId: $('emp').value,
      periodYearMonth: $('ym').value.trim(),
      lateCount: Number($('late').value || 0),
      earlyLeaveCount: Number($('early').value || 0),
      absenceCount: Number($('absence').value || 0),
      overtimeCount: Number($('overtime').value || 0),
      comment: $('comment').value,
      commentVisibleToEmployee: $('visible').checked
    })
  });
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.status === 403) { show($('err'), 'この操作を行う権限がありません'); return; }
  if (res.ok) { show($('ok'), '保存しました'); return; }
  const d = await res.json().catch(() => ({}));
  show($('err'), d.issues ? '入力を確認してください' : '保存できませんでした');
});
init();
</script>
</body>
</html>`;
}

// ===============================================================
// トップ表示の編集（区分1）・サポート（区分12）／ T-52
// ===============================================================
/**
 * 🔴 現行から変えた点:
 *   ・動画は URL を貼るだけ。現行は「右クリック→埋め込みコードをコピー→ペースト→
 *     height 以下は削除」という手順を利用者に求めており、
 *     受け取った HTML をそのまま画面に出力していた。
 *   ・URL は3本固定ではなく最大5本まで行として持つ
 *   ・画像は R2 に保存し、配信は認証必須
 */
export function noticeEditPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>トップ表示の編集 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}
  .login { max-width: 620px; }
  textarea { width: 100%; padding: 11px 12px; font-size: 16px; box-sizing: border-box;
    border: 1px solid #c8d0d8; border-radius: 6px; min-height: 90px; font-family: inherit; }
  .linkrow { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
  @media (max-width: 560px) { .linkrow { grid-template-columns: 1fr; } }
  .thumbs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 10px; }
  @media (max-width: 560px) { .thumbs { grid-template-columns: repeat(2, 1fr); gap: 8px; } }
  .thumbs figure { margin: 0; }
  .thumbs img { width: 100%; aspect-ratio: 1/1; object-fit: cover; border-radius: 6px;
                border: 1px solid #c8d0d8; display: block; }
  .thumbs button { width: 100%; padding: 4px; font-size: 12px; background: #a32020; margin-top: 4px; }
  .preview iframe { width: 100%; aspect-ratio: 16/9; border: 0; border-radius: 6px; margin-top: 8px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/notices/edit")}
<div class="login">
  <h1>トップ表示の編集</h1>
  <div class="box">
    <p class="error" id="err" style="display:none"></p>
    <p class="ok" id="ok" style="display:none"></p>

    <div class="row">
      <label for="msg">メッセージ</label>
      <input type="text" id="msg" maxlength="500">
    </div>

    <div class="row">
      <label for="video">動画URL</label>
      <input type="text" id="video" placeholder="https://www.youtube.com/watch?v=...">
      <p class="hint">YouTube か Vimeo の URL を貼ってください。埋め込みコードは不要です</p>
      <div class="preview" id="preview"></div>
    </div>

    <div class="row">
      <label>URL（最大5本）</label>
      <div id="links"></div>
      <button id="addlink" style="width:auto;padding:8px 14px;background:#6b7885">URLを追加</button>
    </div>

    <button id="save">保存</button>

    <div class="row" style="margin-top:24px">
      <label for="file">画像（最大4枚）</label>
      <input type="file" id="file" accept="image/jpeg,image/png,image/gif">
      <p class="hint">JPEG / PNG / GIF・5MB まで</p>
      <button id="up" style="width:auto;padding:8px 14px">この画像を追加</button>
      <div class="thumbs" id="thumbs"></div>
    </div>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
function show(el, t) { el.textContent = t; el.style.display = t === '' ? 'none' : 'block'; }

function addLinkRow(url, label) {
  if ($('links').children.length >= 5) return;
  const d = document.createElement('div');
  d.className = 'linkrow';
  const a = document.createElement('input');
  a.type = 'text'; a.placeholder = 'https://…'; a.value = url || '';
  a.className = 'lurl';
  const b = document.createElement('input');
  b.type = 'text'; b.placeholder = '表示テキスト'; b.value = label || '';
  b.className = 'llabel';
  d.appendChild(a); d.appendChild(b);
  $('links').appendChild(d);
}

function drawPreview(embedUrl) {
  const p = $('preview');
  p.replaceChildren();
  if (embedUrl === null) return;
  const f = document.createElement('iframe');
  f.src = embedUrl;
  f.allowFullscreen = true;
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  p.appendChild(f);
}

function drawThumbs(images) {
  const t = $('thumbs');
  t.replaceChildren();
  for (const img of images) {
    const fig = document.createElement('figure');
    const e = document.createElement('img');
    e.alt = 'お知らせの画像';
    e.src = '/api/notices/image?imageId=' + encodeURIComponent(img.id);
    const b = document.createElement('button');
    b.textContent = '削除';
    b.addEventListener('click', () => delImage(img.id));
    fig.appendChild(e); fig.appendChild(b);
    t.appendChild(fig);
  }
}

async function load() {
  const res = await fetch('/api/notices');
  if (res.status === 401) { location.href = '/login'; return; }
  if (!res.ok) { show($('err'), '読み込めませんでした'); return; }
  const d = await res.json();
  if (!d.canEdit) { show($('err'), 'この画面を使う権限がありません'); return; }
  const n = d.notice;
  $('msg').value = n.message === null ? '' : n.message;
  $('video').value = n.video === null ? ''
    : (n.video.kind === 'youtube' ? 'https://www.youtube.com/watch?v=' + n.video.id
                                  : 'https://vimeo.com/' + n.video.id);
  drawPreview(n.embedUrl);
  $('links').replaceChildren();
  for (const l of n.links) addLinkRow(l.url, l.label);
  if (n.links.length === 0) addLinkRow('', '');
  drawThumbs(n.images);
}

$('addlink').addEventListener('click', () => addLinkRow('', ''));
$('file').addEventListener('change', () => { show($('err'), ''); show($('ok'), ''); });

$('save').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), '');
  const urls = Array.from(document.querySelectorAll('.lurl')).map((e) => e.value.trim());
  const labels = Array.from(document.querySelectorAll('.llabel')).map((e) => e.value.trim());
  const links = urls.map((u, i) => ({ url: u, label: labels[i] })).filter((l) => l.url !== '');
  const res = await fetch('/api/notices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify({ message: $('msg').value, videoInput: $('video').value, links: links })
  });
  if (res.status === 401) { location.href = '/login'; return; }
  if (res.status === 403) { show($('err'), 'この操作を行う権限がありません'); return; }
  if (res.ok) { show($('ok'), '保存しました'); load(); return; }
  const d = await res.json().catch(() => ({}));
  if (d.issues && d.issues.some((i) => i.code === 'unsupported_video')) {
    show($('err'), 'YouTube か Vimeo の URL を貼ってください');
  } else if (d.issues && d.issues.some((i) => i.field === 'links')) {
    show($('err'), 'URL は http:// または https:// で始まるものを入れてください');
  } else {
    show($('err'), '保存できませんでした');
  }
});

$('up').addEventListener('click', async () => {
  show($('err'), ''); show($('ok'), '');
  const f = $('file').files[0];
  if (!f) { show($('err'), '画像を選んでください'); return; }
  const res = await fetch('/api/notices/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Origin': location.origin },
    body: f
  });
  if (res.ok) { show($('ok'), '画像を追加しました'); $('file').value = ''; load(); return; }
  if (res.status === 413) { show($('err'), '画像が大きすぎます（5MBまで）'); return; }
  const d = await res.json().catch(() => ({}));
  show($('err'), d.issues && d.issues.some((i) => i.code === 'too_many')
    ? '画像は4枚までです' : 'JPEG / PNG / GIF の画像を選んでください');
});

async function delImage(imageId) {
  if (!confirm('この画像を削除します。よろしいですか?')) return;
  const res = await fetch('/api/notices/image/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify({ imageId: imageId })
  });
  if (res.ok) { load(); return; }
  show($('err'), '削除できませんでした');
}
load();
</script>
</body>
</html>`;
}

/** サポート（区分12）。⚠ 表示のみ。編集は super 管理者側とまとめて作る */
export function supportPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>サポート | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}
  .login { max-width: 560px; }
  .body { white-space: pre-wrap; font-size: 15px; line-height: 1.7; color: #23303a; }
  .vlink { display: inline-block; margin-bottom: 12px; color: #2f6fbf; word-break: break-all; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/support")}
<div class="login">
  <h1>サポート</h1>
  <div class="box">
    <p id="empty" class="hint" style="display:none">サポート情報はまだ登録されていません。</p>
    <p><a id="vlink" class="vlink" target="_blank" rel="noopener noreferrer" style="display:none"></a></p>
    <p class="body" id="body"></p>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a></p>
</div>
<script>
(async () => {
  const res = await fetch('/api/support');
  if (res.status === 401) { location.href = '/login'; return; }
  if (!res.ok) { document.getElementById('empty').style.display = 'block'; return; }
  const s = (await res.json()).support;
  let any = false;
  if (s.videoUrl !== null && s.videoUrl !== '') {
    const a = document.getElementById('vlink');
    a.href = s.videoUrl;
    a.textContent = s.videoUrl;
    a.style.display = 'inline-block';
    any = true;
  }
  if (s.body !== null && s.body !== '') {
    document.getElementById('body').textContent = s.body;
    any = true;
  }
  if (!any) document.getElementById('empty').style.display = 'block';
})();
</script>
</body>
</html>`;
}

// ===============================================================
// super管理者の画面（機能権限表 1.1）
//
// 🔴 super管理者は【弊社】。テナントの発行・一覧・サポート内容の編集だけを行い、
//    業務機能を一切持たない。メニューも業務区分を出さない。
// ===============================================================

export function tenantListPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>テナント一覧 | PONO-PLUS</title>${STYLE}
<style>
  .login { max-width: 1100px; padding: 20px; }
  .wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; }
  .b-on { background: #e6f4ea; color: #1e7e34; }
  .b-off { background: #eceff1; color: #607d8b; }
  .b-sus { background: #fff4e5; color: #a35b00; }
  .toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-bottom: 12px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/admin/tenants")}
<div class="login">
  <h1>テナント一覧</h1>
  <div class="box">
    <div class="toolbar">
      <span id="cnt">読み込み中…</span>
      <a class="btn" href="/admin/tenants/edit">新規発行</a>
    </div>
    <div class="wrap">
      <table><thead><tr>
        <th>会社名</th><th>状態</th><th>締日</th><th>年間始月</th>
        <th>ストレスチェック</th><th>アカウント</th><th>担当者</th><th></th>
      </tr></thead><tbody id="rows"><tr><td colspan="8">読み込み中…</td></tr></tbody></table>
    </div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s);
const STATUS = { active: ['稼働中','b-on'], suspended: ['停止中','b-sus'], terminated: ['解約','b-off'] };
function cell(t) { const td = document.createElement('td'); td.textContent = t; return td; }
async function init() {
  const res = await fetch('/api/admin/tenants');
  const tb = $('rows'); tb.textContent = '';
  if (res.status === 403) { const tr = document.createElement('tr'); const td = cell('この画面を見る権限がありません'); td.colSpan = 8; tr.appendChild(td); tb.appendChild(tr); return; }
  const d = await res.json();
  $('cnt').textContent = d.tenants.length + ' 件';
  if (d.tenants.length === 0) { const tr = document.createElement('tr'); const td = cell('まだ1件もありません'); td.colSpan = 8; tr.appendChild(td); tb.appendChild(tr); return; }
  for (const t of d.tenants) {
    const tr = document.createElement('tr');
    tr.appendChild(cell(esc(t.name)));
    const st = document.createElement('td'); const sp = document.createElement('span');
    const s = STATUS[t.status] || [t.status, 'b-off'];
    sp.className = 'badge ' + s[1]; sp.textContent = s[0]; st.appendChild(sp); tr.appendChild(st);
    tr.appendChild(cell(t.cutoffDay + ' 日'));
    tr.appendChild(cell(t.fiscalStartMonth == null ? '-' : t.fiscalStartMonth + ' 月'));
    const sc = document.createElement('td'); const sp2 = document.createElement('span');
    sp2.className = 'badge ' + (t.stressCheckEnabled ? 'b-on' : 'b-off');
    sp2.textContent = t.stressCheckEnabled ? '有効' : '無効'; sc.appendChild(sp2); tr.appendChild(sc);
    tr.appendChild(cell(t.accountCount + (t.maxAccounts == null ? '' : ' / ' + t.maxAccounts)));
    tr.appendChild(cell(esc(t.contactName) || '-'));
    const act = document.createElement('td'); const a = document.createElement('a');
    a.href = '/admin/tenants/edit?id=' + encodeURIComponent(t.id); a.textContent = '修正';
    act.appendChild(a); tr.appendChild(act);
    tb.appendChild(tr);
  }
}
init();
</script>
</body></html>`;
}

export function tenantFormPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>テナント発行 | PONO-PLUS</title>${STYLE}
<style>
  .login { max-width: 720px; padding-top: 24px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  .sec { margin-top: 20px; padding-top: 16px; border-top: 1px solid #e3e8ee; }
  .sec h2 { font-size: 15px; margin: 0 0 4px; }
  .note { font-size: 12px; color: #667; margin: 0 0 12px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/admin/tenants")}
<div class="login">
  <h1 id="ttl">テナント発行</h1>
  <div class="box">
    <div class="error" id="err" style="display:none"></div>
    <div class="ok" id="ok" style="display:none"></div>

    <label for="name">会社名 <span class="req">*</span></label>
    <input id="name" type="text" maxlength="100">

    <div class="grid">
      <div><label for="contact">担当者名</label><input id="contact" type="text" maxlength="60"></div>
      <div><label for="manager">責任者名</label><input id="manager" type="text" maxlength="60"></div>
    </div>

    <div class="grid">
      <div>
        <label for="cutoff">締日 <span class="req">*</span></label>
        <input id="cutoff" type="number" min="1" max="31" value="20">
        <p class="hint">1〜31。月の区切りとなる日</p>
      </div>
      <div>
        <label for="fiscal">年間始月</label>
        <input id="fiscal" type="number" min="1" max="12">
        <p class="hint">会社ごとの年度の区切り。未入力可</p>
      </div>
    </div>

    <div class="grid">
      <div>
        <label for="status">状態</label>
        <select id="status">
          <option value="active">稼働中</option>
          <option value="suspended">停止中</option>
          <option value="terminated">解約</option>
        </select>
      </div>
      <div>
        <label for="maxacc">最大登録アカウント数</label>
        <input id="maxacc" type="number" min="1">
        <p class="hint">未入力ならプランに従う</p>
      </div>
    </div>

    <label for="sc">ストレスチェック</label>
    <select id="sc">
      <option value="0">無効</option>
      <option value="1">有効</option>
    </select>
    <p class="hint">🔴 要配慮個人情報を扱う機能。既定は無効</p>

    <div class="sec" id="newonly">
      <h2>初期の会社管理者</h2>
      <p class="note">発行時に1つだけ作ります。以後のアカウント追加は会社側で行います。</p>
      <label for="wsname">店名</label>
      <input id="wsname" type="text" maxlength="100">
      <p class="hint">未入力なら会社名と同じにします</p>
      <div class="grid">
        <div><label for="lid">ログインID <span class="req">*</span></label><input id="lid" type="text" maxlength="60">
          <p class="hint">全社で重複できません</p></div>
        <div><label for="aname">氏名</label><input id="aname" type="text" maxlength="60"></div>
      </div>
      <label for="amail">メールアドレス</label>
      <input id="amail" type="email" maxlength="120">
      <label for="apw">初期パスワード <span class="req">*</span></label>
      <input id="apw" type="text" maxlength="128">
      <p class="hint">12文字以上。控えて本人に直接伝えてください（メール送信はしません）</p>
    </div>

    <button id="save">保存</button>
  </div>
  <p class="links"><a href="/admin/tenants">テナント一覧へ戻る</a> ／ <a href="/home">ホーム</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
const show = (el, t) => { el.textContent = t; el.style.display = 'block'; };
const hide = (el) => { el.style.display = 'none'; };
const params = new URLSearchParams(location.search);
const id = params.get('id');
const isEdit = id !== null && id !== '';
const LABEL = { name: '会社名', cutoffDay: '締日', status: '状態', maxAccounts: '最大登録アカウント数',
  fiscalStartMonth: '年間始月', adminLoginId: 'ログインID', adminPassword: '初期パスワード', role: 'ロール' };
const CODE = { required: 'を入力してください', range: 'の値が範囲外です', invalid: 'が不正です',
  duplicated: 'は既に使われています', too_short: 'は12文字以上にしてください', missing: 'の初期データがありません' };

async function init() {
  if (!isEdit) return;
  $('ttl').textContent = 'テナント修正';
  $('newonly').style.display = 'none';
  const res = await fetch('/api/admin/tenants/detail?id=' + encodeURIComponent(id));
  if (!res.ok) { show($('err'), '読み込めませんでした'); return; }
  const d = await res.json();
  const t = d.tenant;
  $('name').value = t.name || '';
  $('contact').value = t.contactName || '';
  $('manager').value = t.managerName || '';
  $('cutoff').value = t.cutoffDay;
  $('fiscal').value = t.fiscalStartMonth == null ? '' : t.fiscalStartMonth;
  $('status').value = t.status;
  $('maxacc').value = t.maxAccounts == null ? '' : t.maxAccounts;
  $('sc').value = t.stressCheckEnabled ? '1' : '0';
}

$('save').addEventListener('click', async () => {
  hide($('err')); hide($('ok'));
  const num = (v) => v === '' ? null : Number(v);
  const body = {
    id: isEdit ? id : null,
    name: $('name').value,
    status: $('status').value,
    cutoffDay: Number($('cutoff').value),
    stressCheckEnabled: $('sc').value === '1',
    maxAccounts: num($('maxacc').value),
    fiscalStartMonth: num($('fiscal').value),
    contactName: $('contact').value || null,
    managerName: $('manager').value || null,
  };
  if (!isEdit) {
    body.worksiteName = $('wsname').value || null;
    body.adminLoginId = $('lid').value;
    body.adminPassword = $('apw').value;
    body.adminName = $('aname').value || null;
    body.adminEmail = $('amail').value || null;
  }
  const res = await fetch('/api/admin/tenants', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify(body)
  });
  if (res.ok) {
    if (isEdit) { show($('ok'), '保存しました'); }
    else { location.href = '/admin/tenants'; }
    return;
  }
  const d = await res.json().catch(() => ({}));
  if (d.issues) {
    show($('err'), d.issues.map((i) => (LABEL[i.field] || i.field) + (CODE[i.code] || 'が不正です')).join(' / '));
  } else if (res.status === 403) {
    show($('err'), 'この操作を行う権限がありません');
  } else {
    show($('err'), '保存できませんでした');
  }
});
init();
</script>
</body></html>`;
}

export function adminSupportPage(p: Principal): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>サポート内容の編集 | PONO-PLUS</title>${STYLE}
<style>
  .login { max-width: 720px; padding-top: 24px; }
  textarea { width: 100%; min-height: 200px; }
</style>
</head>
<body class="hashdr">
${headerHtml(p, "/admin/support")}
<div class="login">
  <h1>サポート内容の編集</h1>
  <div class="box">
    <div class="error" id="err" style="display:none"></div>
    <div class="ok" id="ok" style="display:none"></div>
    <label for="video">動画のURL</label>
    <input id="video" type="url" maxlength="500">
    <p class="hint">全テナント共通で表示されます</p>
    <label for="body">本文</label>
    <textarea id="body" maxlength="4000"></textarea>
    <button id="save">保存</button>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a></p>
</div>
<script>
const $ = (id) => document.getElementById(id);
const show = (el, t) => { el.textContent = t; el.style.display = 'block'; };
const hide = (el) => { el.style.display = 'none'; };
async function init() {
  const res = await fetch('/api/support');
  if (!res.ok) return;
  const d = await res.json();
  $('video').value = d.support.videoUrl || '';
  $('body').value = d.support.body || '';
}
$('save').addEventListener('click', async () => {
  hide($('err')); hide($('ok'));
  const res = await fetch('/api/admin/support', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': location.origin },
    body: JSON.stringify({ videoUrl: $('video').value || null, body: $('body').value || null })
  });
  if (res.ok) { show($('ok'), '保存しました'); return; }
  show($('err'), res.status === 403 ? 'この操作を行う権限がありません' : '保存できませんでした');
});
init();
</script>
</body></html>`;
}
