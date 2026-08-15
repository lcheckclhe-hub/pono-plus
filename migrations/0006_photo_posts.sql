-- PONO-PLUS 段階1 マイグレーション 0006
-- 目的: 社内フォト共有（機能権限表 区分8）
--
-- ⚠ 現行のテーブル名は tb_m_chat1（885件）だが、チャット機能ではない。
--    Action は全ファイルで $title1="社内フォト" を設定しており、
--    LINE 通知フラグも LINE_FLG4「社内フォト」である【コード実証・Session 04】。
--    設計書 5.1 優先6 の「チャット」はテーブル名からの誤読だった。
--
-- 現行との対応（chat2Template.php / chat2updateAction.php で実証）:
--   CHAT1_PIC1      -> photo_object_key（R2。現行は ../image/{c_id}/{YYYYMM}/ の公開ディレクトリ）
--   CHAT1_COMMENT1  -> caption（画面ラベル「ひと言」）
--   CHAT1_U_ID      -> employee_id
--   CHAT1_C_ID      -> tenant_id
--   CHAT1_DAY2      -> posted_on から導けるため持たない（現行は date("Ym") の年月）
--
-- 🔴 現行から意図的に外したもの:
--   CHAT1_PIC2〜5 / CHAT1_COMMENT2〜5
--     画面上で8項目すべてコメントアウトされており、送信されない【コード実証】。
--     Action 側にだけ処理が残っていた。使われていない列は作らない（設計書 5.5③ の趣旨）。
--   company_name1 / company_name2
--     hidden で送られるが Action が受け取っていない。完全な未使用。

CREATE TABLE photo_posts (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  employee_id       TEXT NOT NULL REFERENCES employees(id),
  caption           TEXT,
  photo_object_key  TEXT NOT NULL,
  posted_on         TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE INDEX idx_photo_posts_tenant ON photo_posts(tenant_id, posted_on);
CREATE INDEX idx_photo_posts_employee ON photo_posts(employee_id, posted_on);
