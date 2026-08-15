-- PONO-PLUS 段階1 マイグレーション 0003
-- 目的: プロフィール機能（機能権限表 区分5）の本文2項目を持たせる
--
-- 現行の対応（profile3Template.php / profile2updateAction.php で実証）:
--   su2_remarks3 = 画面ラベル「Profile」  -> profile_text
--   su2_remarks4 = 画面ラベル「Note」     -> profile_note
--   su2_pic1     = 顔写真1枚              -> employees.photo_object_key（0001 で作成済み・R2）
--
-- ⚠ マスタ①のプロフィールを別系統（P_SU2_* 列）に持つ現行の構造は踏襲しない。
--    段階1でアカウントを employees に一本化済みのため、階層を問わず同じ列に保存する。

ALTER TABLE employees ADD COLUMN profile_text TEXT;
ALTER TABLE employees ADD COLUMN profile_note TEXT;
