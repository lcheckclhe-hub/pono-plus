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
</style>
</head>
<body>
<div class="login">
  <h1>PONO-PLUS</h1>
  <div class="box">
    <table id="me"><tbody><tr><td colspan="2">読み込み中…</td></tr></tbody></table>
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
