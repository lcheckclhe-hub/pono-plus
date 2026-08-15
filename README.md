# PONO-PLUS 段階1（Cloudflare Workers / D1 / R2）

改修設計書 v6（md5 `8ec76336be6bbb93896aff6a29955968`）と
`PONO-PLUS_段階1_新DBスキーマ設計_v5.md` に基づく段階1の実装。

実装済みの内容の正本は `PONO-PLUS_段階1_仕様書_v1.md`。

## 状態

| ブロック（実行計画書 3.1） | 状態 |
|---|---|
| 1. 基盤（Workers / D1 / R2 / CI） | ✅ |
| 2. スキーマ適用（テーブル25本・インデックス25本） | ✅ `migrations/` |
| 3. 認証（scrypt / セッション / レート制限） | ✅ |
| 4. 認可（is_hr_line / テナント境界） | ✅ |
| 5. SaaS基盤（監査ログ / 退会・解約削除） | ✅ |
| 6. マスタ（従業員 一覧・登録・修正） | ✅ 画面あり |
| 6b. プロフィール（Profile / Note / 顔写真） | ✅ 画面あり。写真は R2・配信は認証必須 |
| 6c. 店舗情報＝月次の人事指標（募集・採用・離職） | ✅ 画面あり。平均勤続・平均年齢は都度算出 |
| 6d. 業務日報（カテゴリ管理・登録・画像） | ✅ 画面あり。画像は R2・配信は認証必須 |
| 6e. 社内フォト共有（投稿・一覧・削除） | ✅ 画面あり。⚠ 現行名 tb_m_chat1 はチャットではない |
| 6f. ありがとう情報（送信・一覧・獲得順位） | ✅ 画面あり。集計5本を廃止し都度算出。月次上限を実装 |
| 7. シフト管理 | ✅ 登録・更新・集計・確定（現行4本を1本に集約） |
| 8. 勤怠評価 | ✅ 画面あり。点数化は要件外【会話合意 2026-08-15】 |
| 9. データ投入 | — 現行データは移行しない【会話合意 2026-08-15】 |

**未実装**：日報 / チャット / サンクス / ランキング / 帳票出力 / LINE 連携 → 段階1.5
ストレスチェック → 段階2

## 構成

```
migrations/0001_init.sql                      テーブル20本・インデックス16本
migrations/0002_employee_default_shift_type.sql  employees に既定の勤務時間帯を追加
migrations/0003_employee_profile.sql          employees に Profile / Note を追加
migrations/0004_worksite_monthly_reports.sql  月次の人事指標レポート（テーブル追加）
migrations/0005_daily_reports.sql             業務日報＋カテゴリ（テーブル追加）
migrations/0006_photo_posts.sql               社内フォト共有（テーブル追加）
migrations/0007_thanks.sql                    ありがとう情報（テーブル追加）
src/index.ts               ディスパッチャ（ルート表・認証・CSRF・監査の一元化）
src/core.ts                基盤：日時 / パスワード(scrypt) / 認可(is_hr_line) / データアクセス
src/services.ts            業務：シフト計算 / 認証 / 従業員 / 勤怠評価 / 退会・解約削除
src/pages.ts               画面：ログイン / ホーム / シフト / 従業員 / 勤怠評価 / プロフィール / 店舗情報 / 業務日報
test/all.test.ts           単体 + 統合 + ディスパッチャ + 画面 + スキーマ検査（364件）
```

`package-lock.json` は置かない。`package.json` で依存バージョンを**完全固定**しているため、
lock ファイルが無くても `npm install` で同じ版が入る。

## コマンド

```bash
npm run check      # 型チェック + テスト364件（これだけ通せばよい）
npm test
npm run typecheck
```

## 設計上の不変条件（テストが守る）

1. 業務テーブルは `tenant_id NOT NULL`（現行の認可欠落・設計書 6.2.6）
2. 平文パスワード列を作らない（現行201件・設計書 6.2.1）
3. 経過時間は INTEGER の分（設計書 4.12）
4. `flg1`〜`flg10` 型の汎用列を作らない（設計書 5.5③）
5. 削除計画が全業務テーブルを網羅（設計書 5.2⑦）
6. 認証はディスパッチャで一元化。ハンドラに認証を書かない（設計書 5.3③）
7. ログに個人データ・SQL 全文を出さない（設計書 6.1）
8. ルートは既定で認証必須。`public: true` を書いたものだけが素通し
9. CSRF 判定はルート探索より前（ルートの存在有無を漏らさない）
10. 一覧系は `SELECT *` を使わず列を列挙する（将来の列追加で情報が漏れ出さないため）
11. アップロードは中身（マジックナンバー）で判定する。拡張子と Content-Type を信用しない
12. R2 のオブジェクトキーをユーザー入力から作らない（現行の任意ファイル削除対策）
13. 個人の写真を公開経路に置かない。配信は認証必須のルートを通す

**未実装の機能は `PONO-PLUS_機能権限表_v2.md` を参照すること。** 12区分中4区分が実装済み。

**テーブルを追加したら `TENANT_SCOPED_TABLES` と削除計画に登録すること。**
登録漏れは `npm test` が落として知らせる。
**public ルートを増やしたらテストの許可リストも更新すること。**

---

## デプロイ手順

### 0. 🔴 先に決めておくこと

| # | 事項 | 理由 |
|---|---|---|
| ① | **Workers Paid プランを契約する** | scrypt のハッシュに約400ms かかる。**Free の CPU 制限（10ms）では通らない**（PoC-F 報告書 v2）|
| ② | **dev / staging に現行の実データを投入しない** | `.sql` は要配慮個人情報（ストレスチェック92件）と平文パスワード201件を含む（改修設計書 3.2）|
| ③ | ㉕（現行データを移行するか）| 移行するなら `legacy_*` 列にマッピングが必要。**移行しないなら3列を削除できる** |

---

### 1. 事前準備

```bash
npm install -g wrangler
wrangler login          # ブラウザで Cloudflare アカウントを認証
```

作業ディレクトリで依存を入れる。

```bash
cd pono-plus
npm install
npm run check           # 型チェック + テスト364件。ここが通らないなら先に進まない
```

---

### 2. D1 データベースの作成

環境ごとに1つずつ作る。

```bash
wrangler d1 create pono-plus-dev
wrangler d1 create pono-plus-staging
wrangler d1 create pono-plus-prod
```

各コマンドが `database_id` を出力する。**`wrangler.toml` の `REPLACE_ME` 3箇所を実際の ID に置き換える。**

```toml
[[env.dev.d1_databases]]
binding = "DB"
database_name = "pono-plus-dev"
database_id = "ここに出力された ID"
```

---

### 3. R2 バケットの作成

```bash
wrangler r2 bucket create pono-plus-photos-dev
wrangler r2 bucket create pono-plus-photos-staging
wrangler r2 bucket create pono-plus-photos-prod
```

従業員写真の保存先。**D1 に BLOB を持たない設計のため必須**（改修設計書 5.5④）。

---

### 4. マイグレーションの適用

```bash
wrangler d1 migrations apply pono-plus-dev
```

**適用後に必ず確認する。**

```bash
wrangler d1 execute pono-plus-dev \
  --command "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
```

**期待値：25**（テーブル25本）。一致しなければ適用が途中で失敗している。

⚠ D1 は内部テーブル `_cf_KV` を自動生成する。数える際は `AND name NOT LIKE '_cf_%'` を付ける。

---

### 5. ロールの初期データ投入

**🔴 `roles` が空だと誰も権限を持てない。** 段階2の法令要件（`is_hr_line`）の中核でもあるため、必ず投入する。

```bash
wrangler d1 execute pono-plus-dev --command "
INSERT INTO roles (id,code,name,is_hr_line,created_at) VALUES
 ('r_sys','system_admin','システム管理者',0,datetime('now')),
 ('r_ten','tenant_admin','会社管理者',1,datetime('now')),
 ('r_ws','worksite_manager','事業場管理者',1,datetime('now')),
 ('r_emp','employee','従業員',0,datetime('now')),
 ('r_sci','sc_implementer','ストレスチェック実施者',0,datetime('now')),
 ('r_scc','sc_clerk','実施事務従事者',0,datetime('now'));"
```

**⚠ `is_hr_line` の値を変えてはならない。** 人事権を有する者は実施者・実施事務従事者になれない（労働安全衛生規則第52条の10第2項）。この値がストレスチェック結果へのアクセス判定を決める。

確認：

```bash
wrangler d1 execute pono-plus-dev \
  --command "SELECT code, is_hr_line FROM roles ORDER BY code"
```

`tenant_admin` と `worksite_manager` だけが `1` であること。

---

### 6. デプロイ

```bash
wrangler deploy
```

出力された URL で疎通を確認する。

```bash
curl https://<出力されたURL>/healthz
## 期待: {"ok":true}
```

---

### 7. デプロイ後の受け入れ確認

| # | 確認 | コマンド | 期待 |
|---|---|---|---|
| ① | 疎通 | `curl .../healthz` | `{"ok":true}` |
| ② | **未認証で保護ルートに入れないこと** | `curl -i .../api/me` | **401** |
| ③ | **未登録ルートが 404 であること**（現行は HTTP 200 のまま `die()`）| `curl -i .../no/such/route` | **404** |
| ④ | **CSRF 判定が効くこと** | `curl -i -X POST .../api/me` | **403** |
| ⑤ | テーブル数 | 4章のコマンド | **25** |
| ⑥ | ロールの `is_hr_line` | 5章のコマンド | 2件のみ `1` |

**②③④が現行システムとの主要な差分**であり、ここが期待どおりでなければデプロイをやり直す。

---

### 8. staging / production

⚠ **`--env staging` を付ける方法は使えない。** `wrangler.toml` をトップレベル構成に
しているため（GitHub 連携の既定デプロイが `--env` を付けないことへの対応）、
環境を増やすときは **Worker とリポジトリを分ける**か、デプロイコマンドの変更を
あわせて検討すること。

**🔴 production には③（未登録ルート404）まで確認してから顧客データを入れる。**

---

### 9. まだ実装に含まれていないもの

| ブロック | 状態 |
|---|---|
| 段階1.5（日報・チャット・サンクス・ランキング・帳票・LINE）| 現行 Template の受領待ち |
| 段階2（ストレスチェック）| 公認心理師との連携が前提 |

**➡ 段階1のスコープ（WBS 1〜8）は実装済み。**

---

### 10. トラブル時の切り分け

| 症状 | 疑うところ |
|---|---|
| ログインが CPU 時間超過で失敗 | **Free プランになっている**（0章①）|
| 環境変数を変えたのに反映されない | **再デプロイしていない。**`/healthz` の `setupTokenConfigured` で確認する |
| `/healthz` は通るが `/api/me` が常に 401 | `sessions` への書き込み失敗、または Cookie 名（`pp_session`）の不一致 |
| マイグレーションが途中で止まる | テーブル数を数えて、どこまで作られたか確認する（4章）|
| 権限エラーが常に出る | `roles` が空（5章の投入漏れ）|
