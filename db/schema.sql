-- ============================================================
-- PRAXMATE v2 — Multi-tenant schema
-- ============================================================
-- Every table with practice-scoped data has a practice_id column.
-- Every API query MUST include WHERE practice_id = ? for isolation.
-- ============================================================

-- ============================================================
-- PRACTICES (tenants)
-- ============================================================
CREATE TABLE practices (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,         -- used in subdomain: hild.praxmate.de
  name TEXT NOT NULL,                -- "Zahnarztpraxis Hild & Kollegen"
  specialty TEXT,                    -- 'dentist', 'gp', 'physio', etc.

  -- Contact / address
  street TEXT,
  postal_code TEXT,
  city TEXT,
  country TEXT DEFAULT 'DE',
  phone TEXT,
  email TEXT,
  website TEXT,

  -- Branding
  brand_primary TEXT DEFAULT '#2d6a8e',
  brand_accent  TEXT DEFAULT '#e9b949',
  brand_ink     TEXT DEFAULT '#1a2a3a',
  logo_url TEXT,

  -- Legal (Impressum)
  legal_name TEXT,                   -- "Dr. Wolfgang Hild & Kollegen GbR"
  tax_id TEXT,                       -- USt-IdNr
  responsible_person TEXT,           -- "Dr. Wolfgang Hild"
  professional_chamber TEXT,         -- "Zahnärztekammer Baden-Württemberg"

  -- Locale
  timezone TEXT DEFAULT 'Europe/Berlin',
  locale TEXT DEFAULT 'de-DE',

  -- Billing plan
  plan TEXT DEFAULT 'solo',          -- 'solo', 'team', 'praxis'
  plan_status TEXT DEFAULT 'trial',  -- 'trial', 'active', 'cancelled', 'suspended'
  trial_ends_at TEXT,
  max_doctors INTEGER DEFAULT 3,

  -- Timestamps
  created_at TEXT DEFAULT (datetime('now')),
  activated_at TEXT,
  suspended_at TEXT
);

CREATE INDEX idx_practices_slug ON practices(slug);
CREATE INDEX idx_practices_status ON practices(plan_status);

-- ============================================================
-- USERS (admin/staff accounts)
-- ============================================================
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,                -- 'owner', 'doctor', 'staff'
  doctor_id TEXT,                    -- optional link to doctors table
  avatar_initials TEXT,

  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_updated_at TEXT,

  totp_secret TEXT,                  -- 2FA (optional)
  totp_enabled INTEGER DEFAULT 0,

  phone TEXT,
  language TEXT DEFAULT 'de',

  status TEXT DEFAULT 'active',      -- 'active', 'invited', 'suspended'
  last_login_at TEXT,
  failed_login_count INTEGER DEFAULT 0,
  locked_until TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  created_by TEXT,

  UNIQUE(practice_id, email)         -- Same email allowed across practices
);

CREATE INDEX idx_users_practice ON users(practice_id);
CREATE INDEX idx_users_email ON users(email);

-- ============================================================
-- DOCTORS (Behandler)
-- ============================================================
CREATE TABLE doctors (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  name TEXT NOT NULL,                -- "Frau Juliane Hild"
  title TEXT,                        -- "Zahnärztin"
  role TEXT,                         -- "Praxisinhaberin"
  specialty TEXT,
  avatar_initials TEXT,
  avatar_url TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  accepts_new_patients INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_doctors_practice ON doctors(practice_id);

-- ============================================================
-- APPOINTMENT TYPES (Behandlungsarten)
-- ============================================================
CREATE TABLE appointment_types (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  code TEXT NOT NULL,                -- 'kontrolle', 'pzr', 'impfung', 'physiobasic'
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL,
  icon TEXT,                         -- emoji or symbol
  color TEXT,                        -- optional custom color
  online_bookable INTEGER DEFAULT 1,
  requires_approval INTEGER DEFAULT 0,
  new_patient_only INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_types_practice ON appointment_types(practice_id);
CREATE UNIQUE INDEX idx_types_code ON appointment_types(practice_id, code);

-- Many-to-many: doctor <-> appointment_type
CREATE TABLE doctor_appointment_types (
  doctor_id TEXT NOT NULL,
  appointment_type_id TEXT NOT NULL,
  practice_id TEXT NOT NULL,
  PRIMARY KEY (doctor_id, appointment_type_id)
);

CREATE INDEX idx_dat_practice ON doctor_appointment_types(practice_id);

-- ============================================================
-- WORKING HOURS
-- ============================================================
CREATE TABLE working_hours (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  day_of_week INTEGER NOT NULL,      -- 1=Mo..7=So
  start_time TEXT NOT NULL,          -- 'HH:MM'
  end_time TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT
);

CREATE INDEX idx_wh_doctor ON working_hours(doctor_id, day_of_week);
CREATE INDEX idx_wh_practice ON working_hours(practice_id);

-- Exceptions: closures, holidays
CREATE TABLE closures (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  doctor_id TEXT,                    -- NULL = applies to all doctors in practice
  date TEXT NOT NULL,                -- YYYY-MM-DD
  start_time TEXT,                   -- NULL = full day
  end_time TEXT,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_closures_practice_date ON closures(practice_id, date);

-- ============================================================
-- PATIENTS
-- ============================================================
CREATE TABLE patients (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  birth_date TEXT,                   -- YYYY-MM-DD
  email TEXT,
  phone TEXT,
  insurance_type TEXT,               -- 'gkv', 'privat', 'selbst'
  insurance_number TEXT,
  is_new_patient INTEGER DEFAULT 0,
  notes TEXT,                        -- internal staff notes
  consent_at TEXT,                   -- privacy consent timestamp
  marketing_consent INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  created_by_user_id TEXT,           -- NULL = created via online booking
  last_visit_at TEXT,
  -- Soft-delete + GDPR
  deleted_at TEXT,                   -- soft-delete (restore-able for 30 days)
  anonymized_at TEXT                 -- GDPR Art. 17: PII NULL'd, audit kept
);

CREATE INDEX idx_patients_practice ON patients(practice_id);
CREATE INDEX idx_patients_name ON patients(practice_id, last_name, first_name);
CREATE INDEX idx_patients_email ON patients(practice_id, email);
CREATE INDEX idx_patients_deleted_at ON patients(deleted_at) WHERE deleted_at IS NOT NULL;

-- ============================================================
-- APPOINTMENTS
-- ============================================================
CREATE TABLE appointments (
  id TEXT PRIMARY KEY,
  booking_code TEXT UNIQUE NOT NULL, -- 'PRX-XXXXXX' — globally unique
  magic_token TEXT UNIQUE NOT NULL,  -- for patient self-cancel
  practice_id TEXT NOT NULL REFERENCES practices(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  doctor_id TEXT NOT NULL REFERENCES doctors(id),
  appointment_type_id TEXT NOT NULL REFERENCES appointment_types(id),

  start_datetime TEXT NOT NULL,      -- 'YYYY-MM-DDTHH:MM:SS'
  end_datetime TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,

  status TEXT DEFAULT 'confirmed',   -- 'confirmed', 'cancelled', 'completed', 'noshow'
  source TEXT DEFAULT 'online',      -- 'online', 'phone', 'staff', 'walkin'

  patient_note TEXT,                 -- patient's note at booking
  staff_note TEXT,                   -- internal note

  confirmed_at TEXT,
  reminder_sent_at TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,                 -- 'patient', 'owner', 'doctor', 'staff'
  cancel_reason TEXT,

  last_modified_by_user_id TEXT,
  last_modified_at TEXT,

  created_at TEXT DEFAULT (datetime('now')),
  created_from_ip TEXT,
  deleted_at TEXT                    -- soft-delete
);

CREATE INDEX idx_appt_practice_date ON appointments(practice_id, start_datetime);
CREATE INDEX idx_appt_doctor_date ON appointments(doctor_id, start_datetime);
CREATE INDEX idx_appt_patient ON appointments(patient_id);
CREATE INDEX idx_appt_status ON appointments(practice_id, status);
CREATE INDEX idx_appointments_deleted_at ON appointments(deleted_at) WHERE deleted_at IS NOT NULL;
-- Race-condition-proof double-booking prevention at the DB level.
-- The app's pre-check (SELECT before INSERT) is no longer the only line of defense.
CREATE UNIQUE INDEX idx_appt_no_double
  ON appointments(doctor_id, start_datetime)
  WHERE status NOT IN ('cancelled','noshow') AND deleted_at IS NULL;

-- ============================================================
-- SESSIONS (admin login)
-- ============================================================
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  practice_id TEXT NOT NULL REFERENCES practices(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  ip_address TEXT,
  user_agent TEXT,
  trusted_device_id TEXT,
  revoked_at TEXT
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Trusted devices (30-day remember)
CREATE TABLE trusted_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  practice_id TEXT NOT NULL REFERENCES practices(id),
  fingerprint TEXT NOT NULL,
  name TEXT,
  last_used_at TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_trusted_user ON trusted_devices(user_id);

-- ============================================================
-- AUDIT LOG
-- ============================================================
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  practice_id TEXT REFERENCES practices(id),
  actor_type TEXT NOT NULL,          -- 'user', 'patient', 'system'
  actor_id TEXT,
  action TEXT NOT NULL,              -- 'user.login', 'appointment.created', etc.
  target_type TEXT,
  target_id TEXT,
  meta TEXT,                         -- JSON blob
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_practice_time ON audit_log(practice_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_type, actor_id);

-- ============================================================
-- LOGIN ATTEMPTS (rate limiting)
-- ============================================================
CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  practice_id TEXT,
  ip_address TEXT NOT NULL,
  success INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_login_attempts_email_time ON login_attempts(email, created_at DESC);
CREATE INDEX idx_login_attempts_ip_time ON login_attempts(ip_address, created_at DESC);

-- ============================================================
-- SIGNUP RATE LIMIT (self-service signup anti-abuse)
-- Hold one row per successful signup per IP, pruned every call.
-- 3/IP/24h is enough to deter botnets without blocking legitimate staff
-- (e.g. same office opening practices for 2 clinics on the same IP).
-- ============================================================
CREATE TABLE IF NOT EXISTS signup_rate_limit (
  ip         TEXT NOT NULL,
  created_at INTEGER NOT NULL,           -- unix seconds
  PRIMARY KEY (ip, created_at)
);
CREATE INDEX IF NOT EXISTS idx_signup_rl_time ON signup_rate_limit(created_at);

-- ============================================================
-- DOMAINS (custom domains per practice)
-- ============================================================
CREATE TABLE practice_domains (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL REFERENCES practices(id),
  hostname TEXT UNIQUE NOT NULL,     -- 'hild.praxmate.de' or 'termin.zahnarzthild.de'
  type TEXT NOT NULL,                -- 'subdomain', 'custom'
  verified INTEGER DEFAULT 0,
  ssl_status TEXT,
  is_primary INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_domains_hostname ON practice_domains(hostname);
CREATE INDEX idx_domains_practice ON practice_domains(practice_id);
