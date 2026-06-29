-- ============================================================
-- Sprint 2 Fix: Hild Friday lunch break (schema-correct version)
-- ============================================================
-- working_hours kolonu: day_of_week (1=Mo..7=So), NOT weekday.
-- Friday = day_of_week=5.
--
-- Mevcut: Cuma = 08:00–15:00 (öğle arası yok)
-- Hedef:  Cuma = 08:00–12:00 · 13:00–15:00
--
-- Çalıştırma (worker/ klasöründen):
--   wrangler d1 execute praxmate --file=../db/fix-friday-demo-hild.sql --remote
-- ============================================================

SELECT 'BEFORE:' AS state;
SELECT wh.id, wh.doctor_id, d.name, wh.day_of_week, wh.start_time, wh.end_time
FROM working_hours wh
JOIN doctors d ON d.id = wh.doctor_id
WHERE wh.practice_id = (SELECT id FROM practices WHERE slug = 'hild')
  AND wh.day_of_week = 5
ORDER BY wh.doctor_id, wh.start_time;

DELETE FROM working_hours
WHERE practice_id = (SELECT id FROM practices WHERE slug = 'hild')
  AND day_of_week = 5;

INSERT INTO working_hours (id, practice_id, doctor_id, day_of_week, start_time, end_time)
SELECT 'wh_' || lower(hex(randomblob(8))), d.practice_id, d.id, 5, '08:00', '12:00'
FROM doctors d
WHERE d.practice_id = (SELECT id FROM practices WHERE slug = 'hild')
  AND d.is_active = 1;

INSERT INTO working_hours (id, practice_id, doctor_id, day_of_week, start_time, end_time)
SELECT 'wh_' || lower(hex(randomblob(8))), d.practice_id, d.id, 5, '13:00', '15:00'
FROM doctors d
WHERE d.practice_id = (SELECT id FROM practices WHERE slug = 'hild')
  AND d.is_active = 1;

SELECT 'AFTER:' AS state;
SELECT wh.id, wh.doctor_id, d.name, wh.day_of_week, wh.start_time, wh.end_time
FROM working_hours wh
JOIN doctors d ON d.id = wh.doctor_id
WHERE wh.practice_id = (SELECT id FROM practices WHERE slug = 'hild')
  AND wh.day_of_week = 5
ORDER BY wh.doctor_id, wh.start_time;
