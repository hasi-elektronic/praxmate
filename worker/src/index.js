/**
 * Praxmate API Worker
 * Single-tenant backend per practice
 *
 * Public Endpoints:
 *   GET  /api/practice              → practice info
 *   GET  /api/doctors               → list active doctors
 *   GET  /api/appointment-types     → list active types
 *   GET  /api/slots?doctor_id=X&type_id=Y&date=YYYY-MM-DD → available slots
 *   GET  /api/availability?type_id=X&month=YYYY-MM → days with availability
 *   POST /api/appointments          → create booking
 *   GET  /api/appointments/:token   → get booking (magic link)
 *   DELETE /api/appointments/:token → cancel booking
 *   GET  /api/health                → health check
 *
 * Admin Endpoints (/api/admin/*):
 *   POST /api/admin/auth/login      → login
 *   POST /api/admin/auth/logout     → logout current session
 *   POST /api/admin/auth/logout-all → logout all devices
 *   GET  /api/admin/auth/me         → current user info
 *   POST /api/admin/auth/password/change → change password
 *   GET  /api/admin/auth/sessions   → list active sessions
 *   GET  /api/admin/dashboard       → dashboard stats + today's appointments
 *   GET  /api/admin/appointments    → list with filters
 *   POST /api/admin/appointments    → create (phone/staff booking)
 *   DELETE /api/admin/appointments/:id → cancel
 *   GET  /api/admin/patients/search?q= → quick search
 *   GET  /api/admin/patients/:id    → detail + appointment history
 */

// =================== IMPORTS ===================

import {
  handleLogin,
  handleLogout,
  handleLogoutAll,
  handleMe,
  handlePasswordChange,
  handleListSessions,
} from './routes/admin-auth.js';

import {
  handleDashboard,
  handleAppointmentsList,
  handleAppointmentCreate,
  handleAppointmentCancel,
  handleAppointmentUpdate,
  handlePatientSearch,
  handlePatientDetail,
} from './routes/admin-dashboard.js';

// =================== CORS ===================

const ALLOWED_ORIGINS = [
  'https://praxmate.pages.dev',
  'https://praxmate.de',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
];

function buildCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const isAllowed = ALLOWED_ORIGINS.includes(origin) ||
                    /^https:\/\/[a-z0-9-]+\.praxmate\.pages\.dev$/.test(origin);
  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, status = 200, extraHeaders = {}, request = null) {
  const corsHeaders = request ? buildCorsHeaders(request) : {};
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

function error(message, status = 400, code = null, request = null) {
  return json({ error: message, code }, status, {}, request);
}

function uid(prefix = '') {
  // Simple unique ID (not UUID, but collision-resistant enough)
  const random = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return prefix ? `${prefix}_${random}` : random;
}

function bookingCode() {
  // Format: PRX-AB12CD (6 alphanumeric uppercase)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const code = Array.from(bytes).map(b => alphabet[b % alphabet.length]).join('');
  return `PRX-${code}`;
}

function magicToken() {
  // Long random token for cancel/reschedule links
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Time helpers (all in Europe/Berlin timezone)
function parseTime(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function formatTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// =================== ROUTES ===================

async function handleHealth(env) {
  try {
    const result = await env.DB.prepare('SELECT id, name FROM practices LIMIT 1').first();
    return json({
      ok: true,
      practice: result,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return error('Database error: ' + e.message, 500);
  }
}

async function handlePractice(env) {
  const p = await env.DB.prepare(`
    SELECT id, name, slug, address, city, postal_code, phone, email, website,
           logo_url, brand_primary, brand_accent, specialty, timezone, language
    FROM practices LIMIT 1
  `).first();
  if (!p) return error('No practice configured', 404);
  return json(p);
}

async function handleDoctors(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, name, title, role, bio, avatar_initials, avatar_url, color, sort_order
    FROM doctors
    WHERE active = 1
    ORDER BY sort_order
  `).all();
  return json(results);
}

async function handleAppointmentTypes(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, code, name, description, duration_minutes, icon, color,
           allow_gkv, allow_privat, allow_selbst, allow_new_patients, sort_order
    FROM appointment_types
    WHERE active = 1
    ORDER BY sort_order
  `).all();
  return json(results);
}

/**
 * Calculate available slots for a given doctor on a specific date.
 * Algorithm:
 *   1. Get working hours for day-of-week
 *   2. Slice into duration-sized slots (with buffer)
 *   3. Subtract existing appointments
 *   4. Subtract blocked slots
 *   5. Filter out past slots (if date = today)
 */
async function handleSlots(env, url) {
  const doctorId = url.searchParams.get('doctor_id');
  const typeId = url.searchParams.get('type_id');
  const dateStr = url.searchParams.get('date'); // YYYY-MM-DD

  if (!typeId || !dateStr) {
    return error('type_id and date required');
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return error('date must be YYYY-MM-DD');
  }

  // Get appointment type
  const type = await env.DB.prepare(`
    SELECT id, duration_minutes, buffer_minutes
    FROM appointment_types WHERE id = ? AND active = 1
  `).bind(typeId).first();
  if (!type) return error('Appointment type not found', 404);

  const duration = type.duration_minutes;
  const buffer = type.buffer_minutes || 0;
  const slotStep = duration + buffer;

  // Calculate day of week (1=Mo, 7=So) from date (UTC safe)
  const date = new Date(dateStr + 'T00:00:00Z');
  let dow = date.getUTCDay(); // 0=Su, 1=Mo, ..., 6=Sa
  dow = dow === 0 ? 7 : dow;   // convert to 1=Mo, 7=So

  // Which doctors to consider
  let doctorIds = [];
  if (doctorId && doctorId !== 'any') {
    doctorIds = [doctorId];
  } else {
    // All active doctors who perform this type
    const r = await env.DB.prepare(`
      SELECT d.id
      FROM doctors d
      JOIN doctor_appointment_types dat ON dat.doctor_id = d.id
      WHERE d.active = 1 AND dat.appointment_type_id = ?
    `).bind(typeId).all();
    doctorIds = r.results.map(x => x.id);
  }
  if (doctorIds.length === 0) return json({ date: dateStr, slots: [] });

  // Working hours for each doctor on this day
  const placeholders = doctorIds.map(() => '?').join(',');
  const whRes = await env.DB.prepare(`
    SELECT doctor_id, start_time, end_time
    FROM working_hours
    WHERE day_of_week = ? AND doctor_id IN (${placeholders})
  `).bind(dow, ...doctorIds).all();

  // Existing appointments on this date for these doctors (non-cancelled)
  const dayStart = dateStr + 'T00:00:00';
  const dayEnd = dateStr + 'T23:59:59';
  const apRes = await env.DB.prepare(`
    SELECT doctor_id, start_datetime, end_datetime
    FROM appointments
    WHERE status != 'cancelled'
      AND doctor_id IN (${placeholders})
      AND start_datetime >= ? AND start_datetime <= ?
  `).bind(...doctorIds, dayStart, dayEnd).all();

  // Blocked slots
  const blkRes = await env.DB.prepare(`
    SELECT doctor_id, start_datetime, end_datetime
    FROM blocked_slots
    WHERE (doctor_id IS NULL OR doctor_id IN (${placeholders}))
      AND start_datetime <= ? AND end_datetime >= ?
  `).bind(...doctorIds, dayEnd, dayStart).all();

  // Generate candidate slots per doctor
  const nowMs = Date.now();
  const slotSet = new Map(); // key = "HH:MM", value = { time, doctor_ids: [] }

  for (const wh of whRes.results) {
    const startMin = parseTime(wh.start_time);
    const endMin = parseTime(wh.end_time);
    for (let m = startMin; m + duration <= endMin; m += slotStep) {
      const hhmm = formatTime(m);
      const slotStart = new Date(`${dateStr}T${hhmm}:00`).getTime();

      // Skip past slots
      if (slotStart < nowMs) continue;

      // Check if this doctor is free at this slot
      const slotEnd = slotStart + duration * 60000;

      // Check appointments
      const doctorBusy = apRes.results.some(a => {
        if (a.doctor_id !== wh.doctor_id) return false;
        const aStart = new Date(a.start_datetime).getTime();
        const aEnd = new Date(a.end_datetime).getTime();
        return slotStart < aEnd && slotEnd > aStart;
      });
      if (doctorBusy) continue;

      // Check blocks
      const doctorBlocked = blkRes.results.some(b => {
        if (b.doctor_id && b.doctor_id !== wh.doctor_id) return false;
        const bStart = new Date(b.start_datetime).getTime();
        const bEnd = new Date(b.end_datetime).getTime();
        return slotStart < bEnd && slotEnd > bStart;
      });
      if (doctorBlocked) continue;

      // Add this doctor to candidates for this slot
      if (!slotSet.has(hhmm)) {
        slotSet.set(hhmm, { time: hhmm, available_doctors: [] });
      }
      slotSet.get(hhmm).available_doctors.push(wh.doctor_id);
    }
  }

  // Sort slots by time
  const slots = Array.from(slotSet.values()).sort((a, b) => a.time.localeCompare(b.time));
  return json({ date: dateStr, duration_minutes: duration, slots });
}

/**
 * Availability per day for a month.
 * Returns which days have at least one free slot.
 */
async function handleAvailability(env, url) {
  const typeId = url.searchParams.get('type_id');
  const month = url.searchParams.get('month'); // YYYY-MM
  const doctorId = url.searchParams.get('doctor_id'); // optional

  if (!typeId || !month) return error('type_id and month required');
  if (!/^\d{4}-\d{2}$/.test(month)) return error('month must be YYYY-MM');

  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();

  // For a fast approximation: return days with working hours that aren't fully booked.
  // Full per-day calculation is expensive. Here we just check existence of working hours.
  // Full check happens in /slots endpoint when user picks a day.

  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, mon - 1, d);
    if (date < today) continue; // past
    let dow = date.getDay();
    dow = dow === 0 ? 7 : dow;

    // Any doctor with working hours on this weekday?
    let sql, params;
    if (doctorId && doctorId !== 'any') {
      sql = `SELECT COUNT(*) as n FROM working_hours WHERE doctor_id = ? AND day_of_week = ?`;
      params = [doctorId, dow];
    } else {
      sql = `
        SELECT COUNT(*) as n FROM working_hours wh
        JOIN doctors d ON d.id = wh.doctor_id
        JOIN doctor_appointment_types dat ON dat.doctor_id = d.id
        WHERE d.active = 1 AND dat.appointment_type_id = ? AND wh.day_of_week = ?
      `;
      params = [typeId, dow];
    }
    const r = await env.DB.prepare(sql).bind(...params).first();
    if (r && r.n > 0) {
      const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push(dateStr);
    }
  }

  return json({ month, available_days: days });
}

/**
 * Create a new appointment.
 */
async function handleCreateAppointment(env, request) {
  let body;
  try { body = await request.json(); }
  catch { return error('Invalid JSON'); }

  const {
    appointment_type_id,
    doctor_id,        // can be null/undefined = "any"
    start_datetime,   // ISO string local Berlin time: '2026-05-14T10:30'
    patient,          // { first_name, last_name, birth_date, email, phone, insurance_type, is_new_patient, note }
    consent,          // bool
  } = body;

  // Validation
  if (!appointment_type_id || !start_datetime || !patient || !consent) {
    return error('Missing required fields');
  }
  if (!patient.first_name || !patient.last_name || !patient.birth_date || !patient.email || !patient.phone) {
    return error('Patient info incomplete');
  }
  if (!isValidEmail(patient.email)) return error('Invalid email');
  if (!['gkv', 'privat', 'selbst'].includes(patient.insurance_type)) {
    return error('Invalid insurance_type');
  }

  // Get type + practice
  const type = await env.DB.prepare(
    'SELECT id, name, duration_minutes, allow_gkv, allow_privat, allow_selbst, allow_new_patients FROM appointment_types WHERE id = ? AND active = 1'
  ).bind(appointment_type_id).first();
  if (!type) return error('Appointment type not found', 404);

  // Insurance check
  if (patient.insurance_type === 'gkv' && !type.allow_gkv) return error('GKV not allowed for this type');
  if (patient.insurance_type === 'privat' && !type.allow_privat) return error('PKV not allowed');
  if (patient.insurance_type === 'selbst' && !type.allow_selbst) return error('Selbstzahler not allowed');
  if (patient.is_new_patient && !type.allow_new_patients) return error('This type not available for new patients');

  const practice = await env.DB.prepare('SELECT id FROM practices LIMIT 1').first();
  if (!practice) return error('No practice configured', 500);

  // Pick doctor if not specified
  let finalDoctorId = doctor_id;
  if (!finalDoctorId || finalDoctorId === 'any') {
    const r = await env.DB.prepare(`
      SELECT d.id FROM doctors d
      JOIN doctor_appointment_types dat ON dat.doctor_id = d.id
      WHERE d.active = 1 AND dat.appointment_type_id = ?
      ORDER BY d.sort_order LIMIT 1
    `).bind(appointment_type_id).first();
    if (!r) return error('No available doctor');
    finalDoctorId = r.id;
  }

  // Calculate end time
  const startMs = new Date(start_datetime).getTime();
  if (isNaN(startMs)) return error('Invalid start_datetime');
  const endMs = startMs + type.duration_minutes * 60000;
  const endDateTime = new Date(endMs).toISOString().slice(0, 19); // no Z, treat as local

  // Check slot isn't taken (race condition protection)
  const conflict = await env.DB.prepare(`
    SELECT id FROM appointments
    WHERE doctor_id = ? AND status != 'cancelled'
      AND start_datetime < ? AND end_datetime > ?
    LIMIT 1
  `).bind(finalDoctorId, endDateTime, start_datetime).first();
  if (conflict) return error('Slot no longer available', 409);

  // Upsert patient
  let patientRow = await env.DB.prepare(`
    SELECT id FROM patients WHERE practice_id = ? AND email = ? AND birth_date = ?
  `).bind(practice.id, patient.email.toLowerCase(), patient.birth_date).first();

  const clientIP = request.headers.get('CF-Connecting-IP') || '';
  const consentAt = new Date().toISOString();

  let patientId;
  if (patientRow) {
    patientId = patientRow.id;
    // Update latest info
    await env.DB.prepare(`
      UPDATE patients SET first_name=?, last_name=?, phone=?, insurance_type=?, consent_at=?, consent_ip=?
      WHERE id=?
    `).bind(
      patient.first_name.trim(),
      patient.last_name.trim(),
      patient.phone.trim(),
      patient.insurance_type,
      consentAt,
      clientIP,
      patientId
    ).run();
  } else {
    patientId = uid('pat');
    await env.DB.prepare(`
      INSERT INTO patients (
        id, practice_id, first_name, last_name, birth_date, email, phone,
        insurance_type, is_new_patient, consent_at, consent_ip
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      patientId, practice.id,
      patient.first_name.trim(), patient.last_name.trim(),
      patient.birth_date, patient.email.toLowerCase(), patient.phone.trim(),
      patient.insurance_type, patient.is_new_patient ? 1 : 0,
      consentAt, clientIP
    ).run();
  }

  // Create appointment
  const apptId = uid('apt');
  const bCode = bookingCode();
  const token = magicToken();

  await env.DB.prepare(`
    INSERT INTO appointments (
      id, booking_code, magic_token, practice_id, doctor_id, appointment_type_id, patient_id,
      start_datetime, end_datetime, duration_minutes, status, patient_note, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, 'online')
  `).bind(
    apptId, bCode, token, practice.id, finalDoctorId, appointment_type_id, patientId,
    start_datetime, endDateTime, type.duration_minutes,
    patient.note || null
  ).run();

  // Audit
  await env.DB.prepare(`
    INSERT INTO audit_log (id, practice_id, actor_type, action, target_type, target_id, ip_address, user_agent)
    VALUES (?, ?, 'patient', 'appointment.created', 'appointment', ?, ?, ?)
  `).bind(
    uid('log'), practice.id, apptId, clientIP,
    request.headers.get('User-Agent') || ''
  ).run();

  // Fetch enriched result
  const result = await env.DB.prepare(`
    SELECT
      a.id, a.booking_code, a.magic_token, a.start_datetime, a.end_datetime, a.duration_minutes,
      a.status,
      t.name as type_name, t.icon as type_icon,
      d.name as doctor_name, d.title as doctor_title,
      p.first_name, p.last_name, p.email
    FROM appointments a
    JOIN appointment_types t ON t.id = a.appointment_type_id
    LEFT JOIN doctors d ON d.id = a.doctor_id
    JOIN patients p ON p.id = a.patient_id
    WHERE a.id = ?
  `).bind(apptId).first();

  return json(result, 201);
}

/**
 * Get appointment by magic token (for cancel/view links)
 */
async function handleGetAppointment(env, token) {
  const r = await env.DB.prepare(`
    SELECT
      a.id, a.booking_code, a.start_datetime, a.end_datetime, a.duration_minutes,
      a.status, a.cancelled_at, a.patient_note,
      t.name as type_name, t.icon as type_icon,
      d.name as doctor_name, d.title as doctor_title,
      pr.name as practice_name, pr.address, pr.city, pr.phone,
      p.first_name, p.last_name
    FROM appointments a
    JOIN appointment_types t ON t.id = a.appointment_type_id
    LEFT JOIN doctors d ON d.id = a.doctor_id
    JOIN patients p ON p.id = a.patient_id
    JOIN practices pr ON pr.id = a.practice_id
    WHERE a.magic_token = ?
  `).bind(token).first();
  if (!r) return error('Appointment not found', 404);
  return json(r);
}

/**
 * Cancel an appointment via magic token
 */
async function handleCancelAppointment(env, token, request) {
  let body = {};
  try { body = await request.json(); } catch {}

  const appt = await env.DB.prepare(
    'SELECT id, status, practice_id, start_datetime FROM appointments WHERE magic_token = ?'
  ).bind(token).first();
  if (!appt) return error('Appointment not found', 404);
  if (appt.status === 'cancelled') return error('Already cancelled', 410);

  // Check if <24h before (allow or warn?)
  const startMs = new Date(appt.start_datetime).getTime();
  const hoursBefore = (startMs - Date.now()) / 3600000;
  const lateCancel = hoursBefore < 24;

  await env.DB.prepare(`
    UPDATE appointments
    SET status='cancelled', cancelled_at=?, cancelled_by='patient', cancel_reason=?
    WHERE id=?
  `).bind(
    new Date().toISOString(),
    body.reason || null,
    appt.id
  ).run();

  const clientIP = request.headers.get('CF-Connecting-IP') || '';
  await env.DB.prepare(`
    INSERT INTO audit_log (id, practice_id, actor_type, action, target_type, target_id, ip_address, meta_json)
    VALUES (?, ?, 'patient', 'appointment.cancelled', 'appointment', ?, ?, ?)
  `).bind(
    uid('log'), appt.practice_id, appt.id, clientIP,
    JSON.stringify({ late_cancel: lateCancel, reason: body.reason || null })
  ).run();

  return json({ ok: true, cancelled: true, late_cancel: lateCancel });
}

// =================== ROUTER ===================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(request)
      });
    }

    let response;
    try {
      response = await handleRequest(request, env, url, path);
    } catch (e) {
      if (e instanceof Response) {
        response = e;
      } else {
        console.error('API error', e);
        response = new Response(
          JSON.stringify({ error: 'Internal server error: ' + e.message }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }
    return wrapCORS(response || new Response(JSON.stringify({error:'Not found'}), {status:404, headers:{'Content-Type':'application/json'}}), request);
  },
};

async function handleRequest(request, env, url, path) {
      // Health check
      if (path === '/api/health') return handleHealth(env);

      // =================== ADMIN ROUTES ===================
      // Auth endpoints (public: login; others require session)
      if (path === '/api/admin/auth/login' && request.method === 'POST') {
        return await handleLogin(env, request);
      }
      if (path === '/api/admin/auth/logout' && request.method === 'POST') {
        return await handleLogout(env, request);
      }
      if (path === '/api/admin/auth/logout-all' && request.method === 'POST') {
        return await handleLogoutAll(env, request);
      }
      if (path === '/api/admin/auth/me' && request.method === 'GET') {
        return await handleMe(env, request);
      }
      if (path === '/api/admin/auth/password/change' && request.method === 'POST') {
        return await handlePasswordChange(env, request);
      }
      if (path === '/api/admin/auth/sessions' && request.method === 'GET') {
        return await handleListSessions(env, request);
      }

      // Dashboard
      if (path === '/api/admin/dashboard' && request.method === 'GET') {
        return await handleDashboard(env, request);
      }

      // Appointments (admin)
      if (path === '/api/admin/appointments' && request.method === 'GET') {
        return await handleAppointmentsList(env, request, url);
      }
      if (path === '/api/admin/appointments' && request.method === 'POST') {
        return await handleAppointmentCreate(env, request);
      }
      const adminApptMatch = path.match(/^\/api\/admin\/appointments\/(apt_[a-f0-9]+)$/);
      if (adminApptMatch && request.method === 'DELETE') {
        return await handleAppointmentCancel(env, request, adminApptMatch[1]);
      }
      if (adminApptMatch && request.method === 'PUT') {
        return await handleAppointmentUpdate(env, request, adminApptMatch[1]);
      }

      // Patients (admin)
      if (path === '/api/admin/patients/search' && request.method === 'GET') {
        return await handlePatientSearch(env, request, url);
      }
      const patientMatch = path.match(/^\/api\/admin\/patients\/(pat_[a-f0-9]+)$/);
      if (patientMatch && request.method === 'GET') {
        return await handlePatientDetail(env, request, patientMatch[1]);
      }

      // =================== PUBLIC ROUTES ===================

      if (path === '/api/practice' && request.method === 'GET') return handlePractice(env);
      if (path === '/api/doctors' && request.method === 'GET') return handleDoctors(env);
      if (path === '/api/appointment-types' && request.method === 'GET') return handleAppointmentTypes(env);
      if (path === '/api/slots' && request.method === 'GET') return handleSlots(env, url);
      if (path === '/api/availability' && request.method === 'GET') return handleAvailability(env, url);
      if (path === '/api/appointments' && request.method === 'POST') return handleCreateAppointment(env, request);

      const apptMatch = path.match(/^\/api\/appointments\/([a-f0-9]{40,})$/);
      if (apptMatch) {
        const token = apptMatch[1];
        if (request.method === 'GET') return handleGetAppointment(env, token);
        if (request.method === 'DELETE') return handleCancelAppointment(env, token, request);
      }

      // Root
      if (path === '/' || path === '/api') {
        return new Response(JSON.stringify({
          name: 'Praxmate API',
          version: '1.2',
          endpoints_public: [
            'GET  /api/health',
            'GET  /api/practice',
            'GET  /api/doctors',
            'GET  /api/appointment-types',
            'GET  /api/slots?doctor_id=X&type_id=Y&date=YYYY-MM-DD',
            'GET  /api/availability?type_id=X&month=YYYY-MM',
            'POST /api/appointments',
            'GET  /api/appointments/:token',
            'DELETE /api/appointments/:token',
          ],
          endpoints_admin: [
            'POST /api/admin/auth/login',
            'POST /api/admin/auth/logout',
            'GET  /api/admin/auth/me',
            'GET  /api/admin/dashboard',
            'GET  /api/admin/appointments',
            'POST /api/admin/appointments',
            'DELETE /api/admin/appointments/:id',
            'GET  /api/admin/patients/search?q=',
            'GET  /api/admin/patients/:id',
          ],
        }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
      }

      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
}

// Helper: ensure CORS headers on any response (admin routes don't add them by default)
function wrapCORS(response, request) {
  const headers = new Headers(response.headers);
  const corsHeaders = buildCorsHeaders(request);
  for (const [k, v] of Object.entries(corsHeaders)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
