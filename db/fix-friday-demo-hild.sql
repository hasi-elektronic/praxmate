-- ============================================================
-- Sprint 2 Fix: Hild Friday lunch break
-- ============================================================
-- Mevcut: Hild praxis, Cuma (weekday=5) = 08:00–15:00 (öğle arası YOK)
-- Hedef:  Cuma = 08:00–12:00 · 13:00–15:00 (gerçek hayat öğle arası)
--
-- Çalıştırma:
--   wrangler d1 execute praxmate-db --file=db/fix-friday-demo-hild.sql --local    (önce test)
--   wrangler d1 execute praxmate-db --file=db/fix-friday-demo-hild.sql --remote   (canlı)
-- ============================================================

-- 1. Önce mevcut durumu göster
SELECT 'BEFORE:' AS state;
SELECT wh.id, wh.doctor_id, d.name, wh.weekday, wh.start_time, wh.end_time
FROM working_hours wh
JOIN doctors d ON d.id = wh.doctor_id
WHERE wh.practice_id = (SELECT id FROM practices WHERE slug = 'hild')
  AND wh.weekday = 5
ORDER BY wh.doctor_id, wh.start_time;

-- 2. Cuma için tek-segment (08-15) kayıtlarını sil
DELETE FROM working_hours
WHERE practice_id = (SELECT id FROM practices WHERE slug = 'hild')
  AND weekday = 5;

-- 3. Hild'in tüm aktif doktorlarına Cuma 08-12 + 13-15 ekle
INSERT INTO working_hours (id, practice_id, doctor_id, weekday, start_time, end_time)
SELECT
  'wh_' || lower(hex(randomblob(8))),
  d.practice_id,
  d.id,
  5,            -- weekday Friday
  '08:00',
  '12:00'
FROM doctors d
WHERE d.practice_id = (SELECT id FROM practices WHERE slug = 'hild')
  AND d.is_active = 1;

INSERT INTO working_hours (id, practice_id, doctor_id, weekday, start_time, end_time)
SELECT
  'wh_' || lower(hex(randomblob(8))),
  d.practice_id,
  d.id,
  5,
  '13:00',
  '15:00'
FROM doctors d
WHERE d.practice_id = (SELECT id FROM practices WHERE slug = 'hild')
  AND d.is_active = 1;

-- 4. Sonuçları göster
SELECT 'AFTER:' AS state;
SELECT wh.id, wh.doctor_id, d.name, wh.weekday, wh.start_time, wh.end_time
FROM working_hours wh
JOIN doctors d ON d.id = wh.doctor_id
WHERE wh.practice_id = (SELECT id FROM practices WHERE slug = 'hild')
  AND wh.weekday = 5
ORDER BY wh.doctor_id, wh.start_time;
