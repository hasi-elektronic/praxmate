import { jsonResponse, jsonError, getClientIp } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { generateId, generateToken, generateBookingCode } from '../lib/crypto.js';
import { logAudit } from '../lib/audit.js';

// ============================================================
// GET /api/admin/dashboard
// Returns today stats + today's appointments + recent activity
// ALL scoped to user.practice_id
// ============================================================
export async function handleDashboard(env, request) {
  const user = await requireAuth(env, request);
  const practice_id = user.practice_id;
  const today = new Date().toISOString().slice(0, 10);

  // Stats
  const todayCount = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM appointments
    WHERE practice_id=? AND date(start_datetime)=? AND status='confirmed'
  `).bind(practice_id, today).first();

  // Week range (Mo-Su)
  const now = new Date();
  const dow = now.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(now); monday.setDate(now.getDate() + mondayOffset); monday.setHours(0,0,0,0);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const weekFrom = monday.toISOString().slice(0, 10);
  const weekTo = sunday.toISOString().slice(0, 10);

  const weekCount = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM appointments
    WHERE practice_id=? AND date(start_datetime) BETWEEN ? AND ? AND status='confirmed'
  `).bind(practice_id, weekFrom, weekTo).first();

  const noshowsCount = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM appointments
    WHERE practice_id=? AND date(start_datetime) BETWEEN ? AND ? AND status='noshow'
  `).bind(practice_id, weekFrom, weekTo).first();

  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const lastOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
  const newPatientsMonth = await env.DB.prepare(`
    SELECT COUNT(DISTINCT a.patient_id) as n
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    WHERE a.practice_id=? AND date(a.start_datetime) BETWEEN ? AND ?
      AND p.is_new_patient = 1
  `).bind(practice_id, firstOfMonth, lastOfMonth).first();

  // Today's appointments
  const todayList = await env.DB.prepare(`
    SELECT a.id, a.booking_code, a.start_datetime, a.end_datetime, a.duration_minutes,
           a.status, a.source, a.patient_note, a.doctor_id,
           p.first_name, p.last_name, p.email, p.phone, p.birth_date,
           p.insurance_type, p.is_new_patient,
           d.name as doctor_name, d.avatar_initials as doctor_initials,
           t.name as type_name, t.icon as type_icon, t.code as type_code
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    JOIN appointment_types t ON t.id = a.appointment_type_id
    WHERE a.practice_id=? AND date(a.start_datetime)=? AND a.status='confirmed'
    ORDER BY a.start_datetime
  `).bind(practice_id, today).all();

  // Recent activity
  const activity = await env.DB.prepare(`
    SELECT action, target_type, target_id, actor_type, created_at
    FROM audit_log WHERE practice_id=?
    ORDER BY created_at DESC LIMIT 10
  `).bind(practice_id).all();

  return jsonResponse({
    stats: {
      today: todayCount.n,
      this_week: weekCount.n,
      noshows_week: noshowsCount.n,
      new_patients_month: newPatientsMonth.n,
    },
    today_appointments: todayList.results,
    recent_activity: activity.results,
  }, request);
}

// ============================================================
// GET /api/admin/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD&doctor_id=X&status=Y
// ============================================================
export async function handleAppointmentsList(env, request) {
  const user = await requireAuth(env, request);
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const doctorId = url.searchParams.get('doctor_id');
  const status = url.searchParams.get('status');

  let query = `
    SELECT a.id, a.booking_code, a.start_datetime, a.end_datetime, a.duration_minutes,
           a.status, a.source, a.patient_note, a.staff_note,
           a.doctor_id, a.patient_id, a.appointment_type_id,
           p.first_name, p.last_name, p.email, p.phone, p.birth_date,
           p.insurance_type, p.is_new_patient,
           d.name as doctor_name, d.avatar_initials as doctor_initials,
           t.name as type_name, t.icon as type_icon, t.code as type_code
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    JOIN appointment_types t ON t.id = a.appointment_type_id
    WHERE a.practice_id = ?
  `;
  const binds = [user.practice_id];

  if (from) { query += ' AND date(a.start_datetime) >= ?'; binds.push(from); }
  if (to) { query += ' AND date(a.start_datetime) <= ?'; binds.push(to); }
  if (doctorId && doctorId !== 'all') { query += ' AND a.doctor_id = ?'; binds.push(doctorId); }
  if (status) { query += ' AND a.status = ?'; binds.push(status); }
  query += ' ORDER BY a.start_datetime LIMIT 500';

  const res = await env.DB.prepare(query).bind(...binds).all();
  return jsonResponse({ appointments: res.results }, request);
}

// ============================================================
// POST /api/admin/appointments — staff creates (phone booking etc.)
// ============================================================
export async function handleAppointmentCreateStaff(env, request) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const {
    patient_id, first_name, last_name, birth_date, email, phone, insurance_type,
    doctor_id, appointment_type_id, start_datetime, patient_note, is_new_patient,
    source = 'staff',
  } = body;

  if (!doctor_id || !appointment_type_id || !start_datetime) {
    return jsonError('Pflichtfelder fehlen', request, 400);
  }

  // Verify resources belong to this practice
  const type = await env.DB.prepare(`SELECT id, duration_minutes FROM appointment_types WHERE id=? AND practice_id=?`)
    .bind(appointment_type_id, user.practice_id).first();
  if (!type) return jsonError('Behandlung nicht gefunden', request, 404);

  const doctor = await env.DB.prepare(`SELECT id FROM doctors WHERE id=? AND practice_id=?`)
    .bind(doctor_id, user.practice_id).first();
  if (!doctor) return jsonError('Behandler nicht gefunden', request, 404);

  // Calc end
  const startMs = new Date(start_datetime).getTime();
  if (isNaN(startMs)) return jsonError('Ungültiges Datum', request, 400);
  const endMs = startMs + type.duration_minutes * 60000;
  const end_datetime = new Date(endMs).toISOString().slice(0, 19);

  // Conflict
  const conflict = await env.DB.prepare(`
    SELECT id FROM appointments
    WHERE doctor_id=? AND status != 'cancelled'
      AND start_datetime < ? AND end_datetime > ?
    LIMIT 1
  `).bind(doctor_id, end_datetime, start_datetime).first();
  if (conflict) return jsonError('Zeitraum bereits belegt', request, 409);

  // Patient: use existing or create
  let pid = patient_id;
  if (!pid) {
    if (!first_name || !last_name) return jsonError('Patient erforderlich', request, 400);
    // Try to find by email within same practice
    if (email) {
      const existing = await env.DB.prepare(`SELECT id FROM patients WHERE practice_id=? AND email=?`)
        .bind(user.practice_id, email).first();
      if (existing) pid = existing.id;
    }
    if (!pid) {
      pid = generateId('pat');
      await env.DB.prepare(`
        INSERT INTO patients (id, practice_id, first_name, last_name, birth_date, email, phone,
                              insurance_type, is_new_patient, consent_at, created_by_user_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
      `).bind(
        pid, user.practice_id, first_name, last_name, birth_date || null,
        email || null, phone || null, insurance_type || 'gkv',
        is_new_patient ? 1 : 0, user.user_id
      ).run();
    }
  }

  const apptId = generateId('apt');
  const bookingCode = generateBookingCode();
  const magicToken = generateToken(24);

  await env.DB.prepare(`
    INSERT INTO appointments
      (id, booking_code, magic_token, practice_id, patient_id, doctor_id, appointment_type_id,
       start_datetime, end_datetime, duration_minutes, status, source,
       patient_note, staff_note, confirmed_at, last_modified_by_user_id, last_modified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, NULL, datetime('now'), ?, datetime('now'))
  `).bind(
    apptId, bookingCode, magicToken, user.practice_id, pid,
    doctor_id, appointment_type_id,
    start_datetime, end_datetime, type.duration_minutes,
    source, patient_note || null, user.user_id
  ).run();

  await logAudit(env, {
    practice_id: user.practice_id,
    actor_type: 'user',
    actor_id: user.user_id,
    action: 'appointment.created',
    target_type: 'appointment',
    target_id: apptId,
    meta: { booking_code: bookingCode, source },
    request,
  });

  return jsonResponse({
    id: apptId,
    booking_code: bookingCode,
    start_datetime,
    end_datetime,
  }, request, 201);
}

// ============================================================
// DELETE /api/admin/appointments/:id — cancel
// ============================================================
export async function handleAppointmentCancel(env, request, apptId) {
  const user = await requireAuth(env, request);
  let body = {};
  try { body = await request.json(); } catch {}

  const appt = await env.DB.prepare(`
    SELECT id, status, booking_code FROM appointments
    WHERE id=? AND practice_id=?
  `).bind(apptId, user.practice_id).first();
  if (!appt) return jsonError('Termin nicht gefunden', request, 404);
  if (appt.status === 'cancelled') return jsonError('Bereits abgesagt', request, 410);

  await env.DB.prepare(`
    UPDATE appointments
    SET status='cancelled', cancelled_at=datetime('now'), cancelled_by=?,
        cancel_reason=?, last_modified_by_user_id=?, last_modified_at=datetime('now')
    WHERE id=?
  `).bind(user.role, body.reason || null, user.user_id, apptId).run();

  await logAudit(env, {
    practice_id: user.practice_id,
    actor_type: 'user',
    actor_id: user.user_id,
    action: 'appointment.cancelled',
    target_type: 'appointment',
    target_id: apptId,
    meta: { booking_code: appt.booking_code, reason: body.reason || null },
    request,
  });

  return jsonResponse({ ok: true }, request);
}

// ============================================================
// PUT /api/admin/appointments/:id — reschedule (drag&drop or form)
// Body: { start_datetime?, doctor_id?, appointment_type_id?, staff_note? }
// ============================================================
export async function handleAppointmentUpdate(env, request, apptId) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const appt = await env.DB.prepare(`
    SELECT a.id, a.status, a.doctor_id, a.appointment_type_id,
           a.start_datetime, a.duration_minutes, a.booking_code, a.staff_note,
           t.duration_minutes as type_duration
    FROM appointments a
    JOIN appointment_types t ON t.id = a.appointment_type_id
    WHERE a.id=? AND a.practice_id=?
  `).bind(apptId, user.practice_id).first();
  if (!appt) return jsonError('Termin nicht gefunden', request, 404);
  if (appt.status === 'cancelled') return jsonError('Abgesagte Termine können nicht verschoben werden', request, 400);

  // Type change → verify it belongs to practice + derive new duration
  let newTypeId = appt.appointment_type_id;
  let newDuration = appt.duration_minutes || appt.type_duration;
  if (body.appointment_type_id && body.appointment_type_id !== appt.appointment_type_id) {
    const newType = await env.DB.prepare(`
      SELECT id, duration_minutes FROM appointment_types
      WHERE id = ? AND practice_id = ? AND is_active = 1
    `).bind(body.appointment_type_id, user.practice_id).first();
    if (!newType) return jsonError('Behandlungsart nicht gefunden', request, 404);
    newTypeId = newType.id;
    newDuration = newType.duration_minutes;
  }

  const newStart = body.start_datetime || appt.start_datetime;
  const newDoctorId = body.doctor_id || appt.doctor_id;
  const newStaffNote = body.staff_note !== undefined ? (body.staff_note || null) : appt.staff_note;

  // If doctor changed, ensure they offer this type
  if (newDoctorId !== appt.doctor_id || newTypeId !== appt.appointment_type_id) {
    const offers = await env.DB.prepare(`
      SELECT 1 FROM doctor_appointment_types WHERE doctor_id = ? AND appointment_type_id = ?
    `).bind(newDoctorId, newTypeId).first();
    if (!offers) return jsonError('Dieser Behandler bietet diese Leistung nicht an', request, 400);
  }

  const startMs = new Date(newStart).getTime();
  if (isNaN(startMs)) return jsonError('Ungültiges Datum', request, 400);
  const endMs = startMs + newDuration * 60000;
  const newEnd = new Date(endMs).toISOString().slice(0, 19);

  // Conflict check (excluding self)
  const conflict = await env.DB.prepare(`
    SELECT id FROM appointments
    WHERE practice_id=? AND doctor_id=? AND status != 'cancelled'
      AND id != ?
      AND start_datetime < ? AND end_datetime > ?
    LIMIT 1
  `).bind(user.practice_id, newDoctorId, apptId, newEnd, newStart).first();
  if (conflict) return jsonError('Zeitraum bereits belegt', request, 409);

  await env.DB.prepare(`
    UPDATE appointments
    SET start_datetime=?, end_datetime=?, doctor_id=?,
        appointment_type_id=?, duration_minutes=?, staff_note=?,
        last_modified_by_user_id=?, last_modified_at=datetime('now')
    WHERE id=?
  `).bind(newStart, newEnd, newDoctorId, newTypeId, newDuration, newStaffNote, user.user_id, apptId).run();

  await logAudit(env, {
    practice_id: user.practice_id,
    actor_type: 'user',
    actor_id: user.user_id,
    action: 'appointment.updated',
    target_type: 'appointment',
    target_id: apptId,
    meta: {
      booking_code: appt.booking_code,
      from: { start: appt.start_datetime, doctor_id: appt.doctor_id, type_id: appt.appointment_type_id },
      to: { start: newStart, doctor_id: newDoctorId, type_id: newTypeId },
    },
    request,
  });

  return jsonResponse({
    ok: true, id: apptId,
    start_datetime: newStart, end_datetime: newEnd,
    doctor_id: newDoctorId, appointment_type_id: newTypeId,
    duration_minutes: newDuration, staff_note: newStaffNote,
  }, request);
}

// ============================================================
// GET /api/admin/patients/search?q=...
// ============================================================
export async function handlePatientSearch(env, request) {
  const user = await requireAuth(env, request);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 2) return jsonResponse({ patients: [] }, request);

  const like = `%${q}%`;
  const res = await env.DB.prepare(`
    SELECT id, first_name, last_name, birth_date, email, phone,
           insurance_type, is_new_patient
    FROM patients
    WHERE practice_id=?
      AND (last_name LIKE ? OR first_name LIKE ? OR email LIKE ? OR phone LIKE ?)
    ORDER BY last_name, first_name
    LIMIT 20
  `).bind(user.practice_id, like, like, like, like).all();

  return jsonResponse({ patients: res.results }, request);
}

// ============================================================
// GET /api/admin/patients/:id — detail + appointment history
// ============================================================
export async function handlePatientDetail(env, request, patientId) {
  const user = await requireAuth(env, request);

  const patient = await env.DB.prepare(`
    SELECT * FROM patients WHERE id=? AND practice_id=?
  `).bind(patientId, user.practice_id).first();
  if (!patient) return jsonError('Patient nicht gefunden', request, 404);

  const appointments = await env.DB.prepare(`
    SELECT a.id, a.booking_code, a.start_datetime, a.status, a.source,
           d.name as doctor_name, t.name as type_name, t.icon as type_icon
    FROM appointments a
    JOIN doctors d ON d.id = a.doctor_id
    JOIN appointment_types t ON t.id = a.appointment_type_id
    WHERE a.patient_id=? AND a.practice_id=?
    ORDER BY a.start_datetime DESC
    LIMIT 50
  `).bind(patientId, user.practice_id).all();

  return jsonResponse({ patient, appointments: appointments.results }, request);
}
