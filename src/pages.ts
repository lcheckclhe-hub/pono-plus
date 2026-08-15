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

export function homePage(): string {
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
</style>
</head>
<body>
<div class="login">
  <h1>PONO-PLUS</h1>
  <div class="box">
    <table id="me"><tbody><tr><td colspan="2">読み込み中…</td></tr></tbody></table>
    <nav class="nav">
      <a href="/employees">従業員一覧</a>
      <a href="/shifts">シフト登録/修正</a>
      <a href="/attendance">勤怠評価</a>
    </nav>
    <div class="logout"><button id="out">ログアウト</button></div>
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
document.getElementById('out').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', headers: { 'Origin': location.origin } });
  location.href = '/login';
});
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

export function shiftSheetPage(): string {
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
  .wrap { overflow-x: auto; }
  .actions { margin-top: 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .actions button { width: auto; padding: 11px 28px; }
  .msg { margin-top: 12px; font-size: 14px; }
  .msg.ok { color: #1c7a3e; } .msg.ng { color: #a32020; }
</style>
</head>
<body>
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

export function employeeListPage(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>従業員一覧 | PONO-PLUS</title>
<style>${STYLE}${ADMIN_STYLE}</style>
</head>
<body>
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
const EMPLOYMENT = { regular:'社員', part_time:'アルバイト', cleaner:'清掃員', other:'その他' };
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
export function employeeFormPage(): string {
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
<body>
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
 * ⚠ 「点数化」は実装していない【未確認】。
 *   現行の評価系 Action / Template が未受領のため、点数の材料となる
 *   実績値のみを表示する（仕様書 v1 5.3・引継ぎシート §4.4 優先2）。
 *   受領後に点数欄を追加する。推測で点数式を作らない。
 *
 * ⚠ 期間は締め日基準。yearMonth=2026-08・締め日20日 なら 2026-07-21〜2026-08-20
 *   （仕様書 v1 5.2）。画面にも期間を明示し、誤読を防ぐ。
 */
export function attendancePage(): string {
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
  .kpi div { background: #f7f9fb; border: 1px solid #e4e9ee; border-radius: 8px; padding: 12px; }
  .kpi .k { font-size: 12px; color: #6b7885; }
  .kpi .v { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .kpi .u { font-size: 12px; font-weight: 400; color: #6b7885; margin-left: 2px; }
  .period { font-size: 13px; color: #46535f; margin-bottom: 16px; }
  .pending { background: #fdf6e3; border: 1px solid #e6d5a8; color: #6b5510;
             padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-top: 18px; }
</style>
</head>
<body>
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
    <p class="pending">⚠ 点数化のルールは未確認のため、実績値のみを表示しています。</p>
  </div>
  <p class="links"><a href="/home">ホームへ戻る</a> ／ <a href="/employees">従業員一覧</a></p>
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
  tb.appendChild(row('出勤率', r.attendanceRate === null ? '－（登録なし）'
    : (Math.round(r.attendanceRate * 1000) / 10) + ' %'));
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
