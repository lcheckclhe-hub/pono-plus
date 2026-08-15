-- PONO-PLUS 段階1 マイグレーション 0009
-- 目的: トップ表示（機能権限表 区分1）とサポート（区分12）
--
-- 現行との対応（user1Template.php / user3Template.php で実証）:
--   tb_m_company の列を切り出す:
--     COMPANY_REMARKS1        -> tenant_notices.message（メッセージ）
--     COMPANY_REMARKS2        -> tenant_notices.video_id（動画。下記 🔴 を参照）
--     COMPANY_REMARKS3/4/5    -> tenant_notice_links.url        （URL①②③）
--     COMPANY_REMARKS31/41/51 -> tenant_notice_links.label      （表示テキスト）
--     COMPANY_PIC1〜4         -> tenant_notice_images.object_key（画像4枚）
--   tb_m_contact（40件）:
--     CONTACT_REMARKS3        -> support_contents.video_url
--     CONTACT_REMARKS1        -> support_contents.body
--
-- 🔴 現行から意図的に変えた点:
--   ① 動画は「YouTube の埋め込みコード（iframe の HTML）」をそのまま保存していた。
--      画面にもそのまま出力しており、任意のスクリプトを埋め込める経路だった。
--      新実装は動画IDだけを保存し、埋め込みは自前で組み立てる【会話合意 2026-08-16】。
--   ② URL と画像を固定の列（3本・4枚）ではなく行として持つ。
--      現行は remarks3/4/5・pic1〜4 と番号付きの列だった（設計書 5.5③ の趣旨）。
--   ③ 画像を公開ディレクトリ（../upload/）に置かない。R2 に保存し配信は認証必須。
--
-- ⚠ サポート（support_contents）は表示のみ実装する【会話合意 2026-08-16】。
--    編集画面は現行のマスタ①②③のどこにも無く、super管理者が設定するものと見られる【未確認】。

CREATE TABLE tenant_notices (
  -- ⚠ SQLite の PRIMARY KEY は NULL を許すため NOT NULL を明示する
  tenant_id   TEXT PRIMARY KEY NOT NULL REFERENCES tenants(id),
  message     TEXT,
  -- 🔴 iframe の HTML ではなく動画IDのみ（例 'dQw4w9WgXcQ'）
  video_id    TEXT,
  -- 'youtube' | 'vimeo'。将来の追加に備えて種別を持つ
  video_kind  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  CHECK (video_kind IS NULL OR video_kind IN ('youtube','vimeo'))
);

CREATE TABLE tenant_notice_links (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  url         TEXT NOT NULL,
  label       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_notice_links_tenant ON tenant_notice_links(tenant_id, sort_order);

CREATE TABLE tenant_notice_images (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  object_key  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_notice_images_tenant ON tenant_notice_images(tenant_id, sort_order);

-- サポートは全テナント共通の1件（現行 tb_m_contact に相当）。
-- tenant_id を持たないため TENANT_SCOPED_TABLES には登録しない。
CREATE TABLE support_contents (
  id          TEXT PRIMARY KEY,
  video_url   TEXT,
  body        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
