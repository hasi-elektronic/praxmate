/**
 * Admin dashboard & appointments routes
 * /api/admin/dashboard
 * /api/admin/appointments/*
 * /api/admin/patients/*
 */

import { requireAuth, requireRole } from '../lib/auth.js';
import { logAuditFromRequest } from '../lib/audit.js';
import { generateId } from '../lib/crypto.js';

// ============================================================
// GET /api/admin/dashboard
// Returns today's overview for the admin landing page
// ============================================================
export async function handleDashboard(env, request) {
  const user = await requireAuth(env, request);
  const practiceId = user.practice_id;
  const today = new Date().toISOString().slice(0, 10);
  const todayStart = today + 'T00:00:00';
  const todayEnd = today + 'T23:59:59';

  // Today's appointments count
  const todayCount = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM appointments
    WHERE practice_id = ? AND status != 'cancelled'
      AND start_datetime >= ? AND start_datetime <= ?
  `).bind(practiceId, todayStart, todayEnd).first();

  // This week (Monday to Sunday)
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ...
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  const weekCount = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM appointments
    WHERE practice_id = ? AND status != 'cancelled'
      AND start_datetime >= ? AND start_datetime <= ?
  `).bind(
    practiceId,
    monday.toISOString().slice(0, 19),
    sunday.toISOString().slice(0, 19)
  ).first();

  // No-shows this week
  const noshowCount = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM appointments
    WHERE practice_id = ? AND status = 'noshow'
      AND start_datetime >= ? AND start_datetime <= ?
  `).bind(
    practiceId,
    monday.toISOString().slice(0, 19),
    sunday.toISOString().slice(0, 19)
  ).first();

  // New patients this month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const newPatients = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM patients
    WHERE practice_id = ? AND created_at >= ?
  `).bind(practiceId, monthStart).first();

  // Today's appointment list (detailed)
  const { results: todayList } = await env.DB.prepare(`
    SELECT a.id, a.booking_code, a.start_datetime, a.end_datetime, a.duration_minutes,
           a.status, a.patient_note, a.source,
           t.name as type_name, t.icon as type_icon, t.color as type_color,
           d.name as doctor_name, d.avatar_initials as doctor_initials,
           p.first_name, p.last_name, p.birth_date, p.insurance_type, p.is_new_patient, p.phone
    FROM appointments a
    JOIN appointment_types t ON t.id = a.appointment_type_id
    LEFT JOIN doctors d ON d.id = a.doctor_id
    JOIN patients p ON p.id = a.patient_id
    WHERE a.practice_id = ? AND a.status != 'cancelled'
      AND a.start_datetime >= ? AND a.start_datetime <= ?
    ORDER BY a.start_datetime
  `).bind(practiceId, todayStart, todayEnd).all();

  // Recent activity (last 10 audit events for this practice)
  const { results: activity } = await env.DB.prepare(`
    SELECT action, target_type, target_id, actor_type, created_at
    FROM audit_log
    WHERE practice_id = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).bind(practiceId).all();

  return jsonResponse({
    stats: {
      today: todayCount.n,
      this_week: weekCount.n,
      noshows_week: noshowCount.n,
      new_patients_month: newPatients.n,
    },
    today_appointments: todayList,
    recent_activity: activity,
    user: {
      name: user.name,
      role: user.role,
    }
  });
}

// ============================================================
// GET /api/admin/appointments
// Query: ?from=YYYY-MM-DD&to=YYYY-MM-DD&doctor_id=X&status=confirmed
// ============================================================
export async function handleAppointmentsList(env, request, url) {
  const user = await requireAuth(env, request);
  const practiceId = user.practice_id;

  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const doctorId = url.searchParams.get('doctor_id');
  const status = url.searchParams.get('status') || 'all';

  const conditions = ['a.practice_id = ?'];
  const params = [practiceId];

  if (from) {
    conditions.push('a.start_datetime >= ?');
    params.push(from + 'T00:00:00');
  }
  if (to) {
    conditions.push('a.start_datetime <= ?');
    params.push(to + 'T23:59:59');
  }
  if (doctorId) {
    conditions.push('a.doctor_id = ?');
    params.push(doctorId);
  }
  if (status !== 'all') {
    conditions.push('a.status = ?');
    params.push(status);
  }

  const { results } = await env.DB.prepare(`
    SELECT a.id, a.booking_code, a.start_datetime, a.end_datetime, a.duration_minutes,
           a.status, a.patient_note, a.source,
           t.id as type_id, t.name as type_name, t.icon as type_icon, t.color as type_color,
           d.id as doctor_id, d.name as doctor_name, d.avatar_initials as doctor_initials,
           p.id as patient_id, p.first_name, p.last_name, p.birth_date, p.email, p.phone,
           p.insurance_type, p.is_new_patient
    FROM appointments a
    JOIN appointment_types t ON t.id = a.appointment_type_id
    LEFT JOIN doctors d ON d.id = a.doctor_id
    JOIN patients p ON p.id = a.patient_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY a.start_datetime
    LIMIT 500
  `).bind(...params).all();

  return jsonResponse({ appointments: results });
}

// ============================================================
// POST /api/admin/appointments
// Staff/Doctor creates appointment (telephone booking)
// ============================================================
export async function handleAppointmentCreate(env, request) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Invalid JSON', 400); }

  const {
    appointment_type_id,
    doctor_id,
    start_datetime,
    patient_id,           // EXISTING patient
    patient,              // OR NEW patient data
    patient_note,
    send_confirmation,    // bool: send email to patient
  } = body;

  if (!appointment_type_id || !start_datetime) {
    return jsonError('appointment_type_id und start_datetime erforderlich', 400);
  }
  if (!patient_id && !patient) {
    return jsonError('Patient erforderlich (patient_id oder patient)', 400);
  }

  // Fetch type
  const type = await env.DB.prepare(`
    SELECT id, name, duration_minutes FROM appointment_types
    WHERE id = ? AND practice_id = ? AND active = 1
  `).bind(appointment_type_id, user.practice_id).first();
  if (!type) return jsonError('Behandlungstyp nicht gefunden', 404);

  // Pick doctor (if 'any', pick first available)
  let finalDoctorId = doctor_id;
  if (!finalDoctorId || finalDoctorId === 'any') {
    const r = await env.DB.prepare(`
      SELECT d.id FROM doctors d
      JOIN doctor_appointment_types dat ON dat.doctor_id = d.id
      WHERE d.practice_id = ? AND d.active = 1 AND dat.appointment_type_id = ?
      ORDER BY d.sort_order LIMIT 1
    `).bind(user.practice_id, appointment_type_id).first();
    if (!r) return jsonError('Kein verfügbarer Behandler', 400);
    finalDoctorId = r.id;
  }

  // Handle patient
  let finalPatientId = patient_id;
  if (!finalPatientId && patient) {
    // Check if patient already exists (by email + birth_date)
    const existing = await env.DB.prepare(`
      SELECT id FROM patients WHERE practice_id = ? AND email = ? AND birth_date = ?
    `).bind(user.practice_id, patient.email.toLowerCase(), patient.birth_date).first();

    if (existing) {
      finalPatientId = existing.id;
      // Update phone if given
      if (patient.phone) {
        await env.DB.prepare(`
          UPDATE patients SET first_name=?, last_name=?, phone=?, insurance_type=?
          WHERE id=?
        `).bind(
          patient.first_name, patient.last_name, patient.phone, patient.insurance_type,
          finalPatientId
        ).run();
      }
    } else {
      finalPatientId = generateId('pat');
      await env.DB.prepare(`
        INSERT INTO patients (id, practice_id, first_name, last_name, birth_date, email, phone,
                              insurance_type, is_new_patient, consent_at, consent_ip, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?)
      `).bind(
        finalPatientId, user.practice_id,
        patient.first_name, patient.last_name, patient.birth_date,
        patient.email.toLowerCase(), patient.phone,
        patient.insurance_type || 'gkv',
        patient.is_new_patient ? 1 : 0,
        request.headers.get('CF-Connecting-IP') || '',
        `Angelegt von ${user.name} (${user.role})`
      ).run();
    }
  }

  // Calculate end time
  const startMs = new Date(start_datetime).getTime();
  if (isNaN(startMs)) return jsonError('Ungültiges Datum', 400);
  const endMs = startMs + type.duration_minutes * 60000;
  const endDateTime = new Date(endMs).toISOString().slice(0, 19);

  // Conflict check
  const conflict = await env.DB.prepare(`
    SELECT id FROM appointments
    WHERE doctor_id = ? AND status != 'cancelled'
      AND start_datetime < ? AND end_datetime > ?
    LIMIT 1
  `).bind(finalDoctorId, endDateTime, start_datetime).first();
  if (conflict) {
    return jsonError('Zeitraum bereits belegt', 409);
  }

  // Create
  const apptId = generateId('apt');
  const bookingCode = 'PRX-' + Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32])
    .join('') + Array.from(crypto.getRandomValues(new Uint8Array(3)))
    .map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32])
    .join('');
  const magicToken = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  await env.DB.prepare(`
    INSERT INTO appointments (
      id, booking_code, magic_token, practice_id, doctor_id, appointment_type_id, patient_id,
      start_datetime, end_datetime, duration_minutes, status, patient_note, source,
      created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
  `).bind(
    apptId, bookingCode, magicToken,
    user.practice_id, finalDoctorId, appointment_type_id, finalPatientId,
    start_datetime, endDateTime, type.duration_minutes,
    patient_note || null,
    user.role === 'staff' ? 'staff' : 'phone',
    user.user_id
  ).run();

  await logAuditFromRequest(env, request, user, 'appointment.created', {
    target_type: 'appointment', target_id: apptId,
    meta: { booking_code: bookingCode, type: type.name }
  });

  // Fetch enriched result
  const result = await env.DB.prepare(`
    SELECT a.id, a.booking_code, a.start_datetime, a.end_datetime, a.duration_minutes, a.status,
           t.name as type_name, t.icon as type_icon,
           d.name as doctor_name,
           p.id as patient_id, p.first_name, p.last_name, p.email, p.phone
    FROM appointments a
    JOIN appointment_types t ON t.id = a.appointment_type_id
    LEFT JOIN doctors d ON d.id = a.doctor_id
    JOIN patients p ON p.id = a.patient_id
    WHERE a.id = ?
  `).bind(apptId).first();

  return jsonResponse(result, 201);
}

// ============================================================
// DELETE /api/admin/appointments/:id  (cancel)
// ============================================================
export async function handleAppointmentCancel(env, request, apptId) {
  const user = await requireAuth(env, request);
  let body = {};
  try { body = await request.json(); } catch {}

  const appt = await env.DB.prepare(`
    SELECT id, status, practice_id, booking_code
    FROM appointments WHERE id = ? AND practice_id = ?
  `).bind(apptId, user.practice_id).first();
  if (!appt) return jsonError('Termin nicht gefunden', 404);
  if (appt.status === 'cancelled') return jsonError('Bereits abgesagt', 410);

  await env.DB.prepare(`
    UPDATE appointments
    SET status='cancelled', cancelled_at=datetime('now'), cancelled_by=?, cancel_reason=?,
        last_modified_by_user_id=?, last_modified_at=datetime('now')
    WHERE id=?
  `).bind(user.role, body.reason || null, user.user_id, apptId).run();

  await logAuditFromRequest(env, request, user, 'appointment.cancelled', {
    target_type: 'appointment', target_id: apptId,
    meta: { booking_code: appt.booking_code, reason: body.reason || null }
  });

  return jsonResponse({ ok: true });
}

// ============================================================
// PUT /api/admin/appointments/:id  (reschedule via drag&drop or edit)
// ============================================================
export async function handleAppointmentUpdate(env, request, apptId) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Invalid JSON', 400); }

  // Load existing
  const appt = await env.DB.prepare(`
    SELECT a.id, a.status, a.practice_id, a.doctor_id, a.appointment_type_id,
           a.start_datetime, a.end_datetime, a.duration_minutes, a.booking_code,
           t.duration_minutes as type_duration
    FROM appointments a
    JOIN appointment_types t ON t.id = a.appointment_type_id
    WHERE a.id = ? AND a.practice_id = ?
  `).bind(apptId, user.practice_id).first();
  if (!appt) return jsonError('Termin nicht gefunden', 404);
  if (appt.status === 'cancelled') return jsonError('Abgesagte Termine können nicht verschoben werden', 400);

  // Determine new values (fallback to existing)
  const newStart = body.start_datetime || appt.start_datetime;
  const newDoctorId = body.doctor_id || appt.doctor_id;
  const duration = appt.duration_minutes || appt.type_duration;

  // Calculate new end
  const startMs = new Date(newStart).getTime();
  if (isNaN(startMs)) return jsonError('Ungültiges Datum', 400);
  const endMs = startMs + duration * 60000;
  const newEnd = new Date(endMs).toISOString().slice(0, 19);

  // Conflict check (exclude self)
  const conflict = await env.DB.prepare(`
    SELECT id FROM appointments
    WHERE doctor_id = ? AND status != 'cancelled'
      AND id != ?
      AND start_datetime < ? AND end_datetime > ?
    LIMIT 1
  `).bind(newDoctorId, apptId, newEnd, newStart).first();
  if (conflict) {
    return jsonError('Zeitraum bereits belegt', 409);
  }

  // Apply update
  await env.DB.prepare(`
    UPDATE appointments
    SET start_datetime = ?, end_datetime = ?, doctor_id = ?,
        last_modified_by_user_id = ?, last_modified_at = datetime('now')
    WHERE id = ?
  `).bind(newStart, newEnd, newDoctorId, user.user_id, apptId).run();

  await logAuditFromRequest(env, request, user, 'appointment.rescheduled', {
    target_type: 'appointment', target_id: apptId,
    meta: {
      booking_code: appt.booking_code,
      from: { start: appt.start_datetime, doctor_id: appt.doctor_id },
      to:   { start: newStart, doctor_id: newDoctorId }
    }
  });

  // Return enriched updated record
  const updated = await env.DB.prepare(`
    SELECT a.id, a.booking_code, a.start_datetime, a.end_datetime, a.duration_minutes,
           a.status, a.doctor_id,
           t.name as type_name, t.icon as type_icon,
           d.name as doctor_name,
           p.first_name, p.last_name
    FROM appointments a
    JOIN appointment_types t ON t.id = a.appointment_type_id
    LEFT JOIN doctors d ON d.id = a.doctor_id
    JOIN patients p ON p.id = a.patient_id
    WHERE a.id = ?
  `).bind(apptId).first();

  return jsonResponse(updated);
}

// ============================================================
// GET /api/admin/patients/search?q=...
// Fast search for phone booking workflow
// ============================================================
export async function handlePatientSearch(env, request, url) {
  const user = await requireAuth(env, request);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return jsonResponse({ patients: [] });

  const pattern = '%' + q.toLowerCase().replace(/[^\w\s@.-]/g, '') + '%';

  const { results } = await env.DB.prepare(`
    SELECT id, first_name, last_name, birth_date, email, phone, insurance_type, is_new_patient
    FROM patients
    WHERE practice_id = ?
      AND (LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ? OR email LIKE ? OR phone LIKE ?)
    ORDER BY last_name, first_name
    LIMIT 20
  `).bind(user.practice_id, pattern, pattern, pattern, pattern).all();

  return jsonResponse({ patients: results });
}

// ============================================================
// GET /api/admin/patients/:id
// ============================================================
export async function handlePatientDetail(env, request, patientId) {
  const user = await requireAuth(env, request);

  const patient = await env.DB.prepare(`
    SELECT id, first_name, last_name, birth_date, email, phone,
           insurance_type, is_new_patient, consent_at, created_at, notes
    FROM patients
    WHERE id = ? AND practice_id = ?
  `).bind(patientId, user.practice_id).first();
  if (!patient) return jsonError('Patient nicht gefunden', 404);

  const { results: appointments } = await env.DB.prepare(`
    SELECT a.id, a.booking_code, a.start_datetime, a.duration_minutes, a.status,
           t.name as type_name, t.icon as type_icon,
           d.name as doctor_name
    FROM appointments a
    JOIN appointment_types t ON t.id = a.appointment_type_id
    LEFT JOIN doctors d ON d.id = a.doctor_id
    WHERE a.patient_id = ?
    ORDER BY a.start_datetime DESC
    LIMIT 50
  `).bind(patientId).all();

  return jsonResponse({ patient, appointments });
}

// ============================================================
// Helpers
// ============================================================
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function jsonError(message, status = 400) {
  return jsonResponse({ error: message }, status);
}
