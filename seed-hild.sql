-- =========================================
-- PRAXMATE SEED DATA: Zahnarztpraxis Hild & Kollegen
-- =========================================

-- 1. Practice
INSERT INTO practices (
  id, name, slug, address, city, postal_code, phone, email, website, logo_url,
  brand_primary, brand_accent, specialty, timezone, language, active, beta
) VALUES (
  'prc_hild',
  'Zahnarztpraxis Hild & Kollegen',
  'hild-kollegen',
  'Lupinenweg 1',
  'Vaihingen a.d. Enz',
  '71665',
  '07042 14069',
  'mail@zahnarzthild.de',
  'https://zahnarzthild.de',
  'https://zahnarzthild.de/wp-content/uploads/2024/10/241002_Logo_HildKollegen_Zahnarztpraxis.svg',
  '#2d6a8e',
  '#e9b949',
  'zahnarzt',
  'Europe/Berlin',
  'de',
  1,
  1
);

-- 2. Doctors
INSERT INTO doctors (id, practice_id, name, title, role, bio, avatar_initials, sort_order, active) VALUES
  ('doc_juliane', 'prc_hild', 'Frau Juliane Hild', 'Zahnärztin', 'Praxisinhaberin',
   'Staatsexamen 2012 in Würzburg. Praxisübernahme 2016. Mitgliedschaften: DGZMK, Dentimed, APW.',
   'JH', 1, 1),
  ('doc_wolfgang', 'prc_hild', 'Herr Wolfgang Hild', 'Zahnarzt', 'Senior',
   'Staatsexamen 1979 in Marburg. Praxisgründer 1987. Über 40 Jahre Erfahrung.',
   'WH', 2, 1),
  ('doc_angestellter', 'prc_hild', 'Angestellter Zahnarzt', 'Zahnarzt', 'Angestellt',
   'Moderne Zahnmedizin. Allgemeine Behandlungen und Vorsorge.',
   'AZ', 3, 1);

-- 3. Appointment Types
INSERT INTO appointment_types (
  id, practice_id, code, name, description, duration_minutes, icon, color,
  allow_gkv, allow_privat, allow_selbst, allow_new_patients, sort_order, active
) VALUES
  ('apt_kontrolle', 'prc_hild', 'kontrolle', 'Kontrolle / Vorsorge',
   'Halbjährliche Untersuchung, Röntgen bei Bedarf', 20, '🦷', '#2d6a8e',
   1, 1, 1, 1, 1, 1),
  ('apt_pzr', 'prc_hild', 'pzr', 'Prophylaxe (PZR)',
   'Professionelle Zahnreinigung, Politur, Beratung', 45, '✨', '#4a8eb0',
   1, 1, 1, 1, 2, 1),
  ('apt_fuellung', 'prc_hild', 'fuellung', 'Füllung / Karies',
   'Kunststoff- oder Keramikfüllung', 30, '◉', '#2d6a8e',
   1, 1, 1, 0, 3, 1),
  ('apt_schmerz', 'prc_hild', 'schmerz', 'Schmerzbehandlung',
   'Akute Beschwerden — schnelle Abhilfe', 20, '⚡', '#e9b949',
   1, 1, 1, 1, 4, 1),
  ('apt_prothetik', 'prc_hild', 'prothetik', 'Prothetik-Beratung',
   'Kronen, Brücken, Implantate, Zahnersatz', 45, '⎈', '#2d6a8e',
   1, 1, 1, 0, 5, 1),
  ('apt_kinder', 'prc_hild', 'kinder', 'Kinderzahnheilkunde',
   'Spielerisch, kindgerecht, angstfrei', 30, '🧸', '#4a8eb0',
   1, 1, 1, 1, 6, 1),
  ('apt_weisheit', 'prc_hild', 'weisheitszahn', 'Weisheitszahn',
   'Beratung und operative Entfernung', 60, '⌕', '#2d6a8e',
   1, 1, 1, 0, 7, 1),
  ('apt_neu', 'prc_hild', 'neuaufnahme', 'Neuaufnahme',
   'Erstgespräch für neue Patienten', 30, '★', '#e9b949',
   1, 1, 1, 1, 8, 1);

-- 4. Doctor x Appointment Type (hepsi her şeyi yapar - esneklik için, Hild isterse kısıtlar)
INSERT INTO doctor_appointment_types (doctor_id, appointment_type_id)
SELECT d.id, a.id FROM doctors d CROSS JOIN appointment_types a;

-- 5. Working Hours (tüm doktorlar aynı, Hild sprechzeiten)
-- Mo, Di, Mi: 08-12 + 15-18
-- Do: 08-12 + 13-17
-- Fr: 08-15
INSERT INTO working_hours (id, doctor_id, day_of_week, start_time, end_time) VALUES
  -- Juliane
  ('wh_juliane_mo_am', 'doc_juliane', 1, '08:00', '12:00'),
  ('wh_juliane_mo_pm', 'doc_juliane', 1, '15:00', '18:00'),
  ('wh_juliane_di_am', 'doc_juliane', 2, '08:00', '12:00'),
  ('wh_juliane_di_pm', 'doc_juliane', 2, '15:00', '18:00'),
  ('wh_juliane_mi_am', 'doc_juliane', 3, '08:00', '12:00'),
  ('wh_juliane_mi_pm', 'doc_juliane', 3, '15:00', '18:00'),
  ('wh_juliane_do_am', 'doc_juliane', 4, '08:00', '12:00'),
  ('wh_juliane_do_pm', 'doc_juliane', 4, '13:00', '17:00'),
  ('wh_juliane_fr',    'doc_juliane', 5, '08:00', '15:00'),
  -- Wolfgang (aynı saatler)
  ('wh_wolfgang_mo_am', 'doc_wolfgang', 1, '08:00', '12:00'),
  ('wh_wolfgang_mo_pm', 'doc_wolfgang', 1, '15:00', '18:00'),
  ('wh_wolfgang_di_am', 'doc_wolfgang', 2, '08:00', '12:00'),
  ('wh_wolfgang_di_pm', 'doc_wolfgang', 2, '15:00', '18:00'),
  ('wh_wolfgang_mi_am', 'doc_wolfgang', 3, '08:00', '12:00'),
  ('wh_wolfgang_mi_pm', 'doc_wolfgang', 3, '15:00', '18:00'),
  ('wh_wolfgang_do_am', 'doc_wolfgang', 4, '08:00', '12:00'),
  ('wh_wolfgang_do_pm', 'doc_wolfgang', 4, '13:00', '17:00'),
  ('wh_wolfgang_fr',    'doc_wolfgang', 5, '08:00', '15:00'),
  -- Angestellter
  ('wh_ang_mo_am', 'doc_angestellter', 1, '08:00', '12:00'),
  ('wh_ang_mo_pm', 'doc_angestellter', 1, '15:00', '18:00'),
  ('wh_ang_di_am', 'doc_angestellter', 2, '08:00', '12:00'),
  ('wh_ang_di_pm', 'doc_angestellter', 2, '15:00', '18:00'),
  ('wh_ang_mi_am', 'doc_angestellter', 3, '08:00', '12:00'),
  ('wh_ang_mi_pm', 'doc_angestellter', 3, '15:00', '18:00'),
  ('wh_ang_do_am', 'doc_angestellter', 4, '08:00', '12:00'),
  ('wh_ang_do_pm', 'doc_angestellter', 4, '13:00', '17:00'),
  ('wh_ang_fr',    'doc_angestellter', 5, '08:00', '15:00');
