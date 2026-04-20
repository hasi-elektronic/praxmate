-- =========================================
-- PRAXMATE MIGRATION 002
-- Add admin authentication & user management
-- =========================================

-- Users (team members: owner/doctor/staff)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  practice_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'doctor', 'staff')),
  doctor_id TEXT,                    -- NULL for owner/staff; required for 'doctor' role
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  twofa_secret TEXT,
  twofa_enabled INTEGER DEFAULT 0,
  email_verified_at TEXT,
  invited_by_user_id TEXT,
  invitation_token TEXT,
  invitation_expires_at TEXT,
  last_login_at TEXT,
  last_login_ip TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (practice_id, email),
  FOREIGN KEY (practice_id) REFERENCES practices(id),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id)
);

-- Sessions (active login sessions)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,               -- session token (64-char hex)
  user_id TEXT NOT NULL,
  practice_id TEXT NOT NULL,
  device_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_active_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Trusted devices (30-day remember)
CREATE TABLE IF NOT EXISTS trusted_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL,
  device_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Login attempts (rate limiting + audit)
CREATE TABLE IF NOT EXISTS login_attempts (
  id TEXT PRIMARY KEY,
  email TEXT,
  ip_address TEXT,
  success INTEGER,
  attempted_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Password reset tokens
CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- 2FA recovery codes
CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Patient clinical notes (only doctors can write)
CREATE TABLE IF NOT EXISTS patient_notes (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  practice_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,
  author_user_id TEXT NOT NULL,
  appointment_id TEXT,
  note_type TEXT NOT NULL DEFAULT 'clinical',
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  FOREIGN KEY (author_user_id) REFERENCES users(id),
  FOREIGN KEY (appointment_id) REFERENCES appointments(id)
);

-- Extend appointments: track who created/modified
ALTER TABLE appointments ADD COLUMN created_by_user_id TEXT;
ALTER TABLE appointments ADD COLUMN last_modified_by_user_id TEXT;
ALTER TABLE appointments ADD COLUMN last_modified_at TEXT;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(practice_id, email);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_trusted_user ON trusted_devices(user_id);
CREATE INDEX IF NOT EXISTS idx_login_email_time ON login_attempts(email, attempted_at);
CREATE INDEX IF NOT EXISTS idx_login_ip_time ON login_attempts(ip_address, attempted_at);
CREATE INDEX IF NOT EXISTS idx_pw_reset_user ON password_resets(user_id);
CREATE INDEX IF NOT EXISTS idx_recovery_user ON recovery_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_notes_patient ON patient_notes(patient_id);
CREATE INDEX IF NOT EXISTS idx_appts_creator ON appointments(created_by_user_id);
