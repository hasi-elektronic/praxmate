-- =========================================
-- PRAXMATE SCHEMA v1.0
-- Single-tenant per database
-- Target: Cloudflare D1 (SQLite dialect)
-- =========================================

-- 1. PRACTICES (bu DB'de her zaman 1 satır olacak)
CREATE TABLE IF NOT EXISTS practices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  address TEXT,
  city TEXT,
  postal_code TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  logo_url TEXT,
  brand_primary TEXT DEFAULT '#2d6a8e',
  brand_accent TEXT DEFAULT '#e9b949',
  specialty TEXT,
  timezone TEXT DEFAULT 'Europe/Berlin',
  language TEXT DEFAULT 'de',
  active INTEGER DEFAULT 1,
  beta INTEGER DEFAULT 1,
  settings_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 2. DOCTORS (Behandler)
CREATE TABLE IF NOT EXISTS doctors (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  role TEXT,
  bio TEXT,
  avatar_initials TEXT,
  avatar_url TEXT,
  color TEXT DEFAULT '#2d6a8e',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (practice_id) REFERENCES practices(id)
);

-- 3. APPOINTMENT TYPES
CREATE TABLE IF NOT EXISTS appointment_types (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL,
  icon TEXT,
  color TEXT,
  allow_gkv INTEGER DEFAULT 1,
  allow_privat INTEGER DEFAULT 1,
  allow_selbst INTEGER DEFAULT 1,
  allow_new_patients INTEGER DEFAULT 1,
  buffer_minutes INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (practice_id, code),
  FOREIGN KEY (practice_id) REFERENCES practices(id)
);

-- 4. DOCTOR x APPOINTMENT TYPE (hangi behandler hangi tipi yapar)
CREATE TABLE IF NOT EXISTS doctor_appointment_types (
  doctor_id TEXT NOT NULL,
  appointment_type_id TEXT NOT NULL,
  PRIMARY KEY (doctor_id, appointment_type_id),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  FOREIGN KEY (appointment_type_id) REFERENCES appointment_types(id)
);

-- 5. WORKING HOURS (doktor başına haftalık)
CREATE TABLE IF NOT EXISTS working_hours (
  id TEXT PRIMARY KEY,
  doctor_id TEXT NOT NULL,
  day_of_week INTEGER NOT NULL,        -- 1=Mo ... 7=So
  start_time TEXT NOT NULL,            -- '08:00'
  end_time TEXT NOT NULL,              -- '12:00'
  FOREIGN KEY (doctor_id) REFERENCES doctors(id)
);

-- 6. BLOCKED SLOTS (tatil, ara, özel günler)
CREATE TABLE IF NOT EXISTS blocked_slots (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL,
  doctor_id TEXT,
  start_datetime TEXT NOT NULL,
  end_datetime TEXT NOT NULL,
  reason TEXT,
  all_day INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (practice_id) REFERENCES practices(id),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id)
);

-- 7. PATIENTS
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  insurance_type TEXT NOT NULL,
  insurance_number TEXT,
  is_new_patient INTEGER DEFAULT 1,
  consent_at TEXT NOT NULL,
  consent_ip TEXT,
  language TEXT DEFAULT 'de',
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (practice_id, email, birth_date),
  FOREIGN KEY (practice_id) REFERENCES practices(id)
);

-- 8. APPOINTMENTS (ana tablo)
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  booking_code TEXT UNIQUE NOT NULL,
  magic_token TEXT UNIQUE NOT NULL,
  practice_id TEXT NOT NULL,
  doctor_id TEXT,
  appointment_type_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  start_datetime TEXT NOT NULL,
  end_datetime TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  status TEXT DEFAULT 'confirmed',  -- confirmed | cancelled | completed | noshow | rescheduled
  patient_note TEXT,
  doctor_note TEXT,
  source TEXT DEFAULT 'online',     -- online | phone | walkin
  confirmation_sent_at TEXT,
  reminder_sent_at TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT,
  rescheduled_to TEXT,              -- yeni randevu ID'si
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (practice_id) REFERENCES practices(id),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  FOREIGN KEY (appointment_type_id) REFERENCES appointment_types(id),
  FOREIGN KEY (patient_id) REFERENCES patients(id)
);

-- 9. AUDIT LOG (DSGVO için kim ne zaman ne yaptı)
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,        -- system | doctor | patient | admin
  actor_id TEXT,
  action TEXT NOT NULL,             -- appointment.created | patient.deleted | ...
  target_type TEXT,                 -- appointment | patient | doctor
  target_id TEXT,
  meta_json TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- INDEXES
CREATE INDEX IF NOT EXISTS idx_appointments_practice_date ON appointments(practice_id, start_datetime);
CREATE INDEX IF NOT EXISTS idx_appointments_doctor_date ON appointments(doctor_id, start_datetime);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appointments_token ON appointments(magic_token);
CREATE INDEX IF NOT EXISTS idx_appointments_code ON appointments(booking_code);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_patients_email ON patients(practice_id, email);
CREATE INDEX IF NOT EXISTS idx_working_hours_doctor ON working_hours(doctor_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_blocked_slots_time ON blocked_slots(practice_id, start_datetime, end_datetime);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
