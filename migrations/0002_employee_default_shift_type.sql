-- PONO-PLUS 段階1 マイグレーション 0002
-- 目的: 従業員に「既定の勤務時間帯」を持たせる
--
-- 経緯:
--   0001 の時点では登録入力に shiftGroupCode（'A'..'D'）があったが、
--   保存先の列が無く、受け取って捨てていた（Session 04 で F-3 として検出）。
--   さらに 'A'..'D' という値域そのものが誤りであり、正しくは会社ごとに
--   最大21種を shift_types に定義する（引継ぎシート Session 03 第6章の訂正）。
--   よって shift_types への参照列を追加し、入力を shift_types.id に置き換える。
--
-- 注意: SQLite の ALTER TABLE ADD COLUMN は既定値 NULL の外部キー列を追加できる。
--       既存行はすべて NULL（未設定）になる。

ALTER TABLE employees ADD COLUMN default_shift_type_id TEXT REFERENCES shift_types(id);
