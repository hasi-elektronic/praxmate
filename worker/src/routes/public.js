import { jsonResponse, jsonError, getClientIp } from '../lib/http.js';
import { requirePractice } from '../lib/tenant.js';
import { generateId, generateToken, generateBookingCode } from '../lib/crypto.js';
import { logAudit } from '../lib/audit.js';

// ============================================================
// GET /api/practice — info for the resolved practice
// ============================================================
export async function handlePracticeInfo(env, request) {
  const practice = await requirePractice(env, request);
  return jsonResponse(practice, request);
}

// ============================================================
// GET /api/doctors — bookable doctors for this practice
// ============================================================
export async function handleDoctorsList(env, request) {
  const practice = await requirePractice(env, request);
  const res = await env.DB.prepare(`
    SELECT id, name, title, role, specialty, avatar_initials, accepts_new_patients
    FROM doctors
    WHERE practice_id = ? AND is_active = 1
    ORDER BY sort_order, name
  `).bind(practice.id).all();
  return jsonResponse(res.results, request);
}

// ============================================================
// GET /api/appointment-types — bookable types for this practice
// ============================================================
export async function handleAppointmentTypes(env, request) {
  const practice = await requirePractice(env, request);
  const res = await env.DB.prepare(`
    SELECT id, code, name, description, duration_minutes, icon, color,
           requires_approval, new_patient_only
    FROM appointment_types
    WHERE practice_id = ? AND is_active = 1 AND online_bookable = 1
    ORDER BY sort_order, name
  `).bind(practice.id).all();
  return jsonResponse(res.results, request);
}

// ============================================================
// GET /api/availability?type_id=X&month=YYYY-MM
// Returns: { available_days: ['2026-04-21', '2026-04-22', ...] }
// ============================================================
export async function handleAvailability(env, request) {
  const practice = await requirePractice(env, request);
  const url = new URL(request.url);
  const typeId = url.searchParams.get('type_id');
  const doctorId = url.searchParams.get('doctor_id');
  const month = url.searchParams.get('month'); // YYYY-MM
  if (!typeId || !month || !/^\d{4}-\d{2}$/.test(month)) {
    return jsonError('type_id und month erforderlich', request, 400);
  }

  const type = await env.DB.prepare(`
    SELECT id, duration_minutes FROM appointment_types WHERE id=? AND practice_id=?
  `).bind(typeId, practice.id).first();
  if (!type) return jsonError('Behandlung nicht gefunden', request, 404);

  // Determine days of the month, check if doctor(s) have ANY slot
  const [year, mon] = month.split('-').map(Number);
  const lastDay = new Date(year, mon, 0).getDate();
  const today = new Date().toISOString().slice(0, 10);
  const availableDays = [];

  for (let d = 1; d <= lastDay; d++) {
    const dateStr = `${year}-${String(mon).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (dateStr < today) continue;
    const slots = await getSlots(env, practice.id, type, dateStr, doctorId);
    if (slots.length > 0) availableDays.push(dateStr);
  }

  return jsonResponse({ available_days: availableDays }, request);
}

// ============================================================
// GET /api/slots?type_id=X&date=YYYY-MM-DD&doctor_id=Y
// Returns: [{ time: '09:00', available_doctors: ['doc_1', 'doc_2'] }, ...]
// ============================================================
export async function handleSlots(env, request) {
  const practice = await requirePractice(env, request);
  const url = new URL(request.url);
  const typeId = url.searchParams.get('type_id');
  const doctorId = url.searchParams.get('doctor_id');
  const date = url.searchParams.get('date');
  if (!typeId || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return jsonError('type_id und date erforderlich', request, 400);
  }

  const type = await env.DB.prepare(`
    SELECT id, duration_minutes FROM appointment_types WHERE id=? AND practice_id=?
  `).bind(typeId, practice.id).first();
  if (!type) return jsonError('Behandlung nicht gefunden', request, 404);

  const slots = await getSlots(env, practice.id, type, date, doctorId);
  return jsonResponse(slots, request);
}

/**
 * Core slot calculation — shared by /availability and /slots.
 * Returns sorted array of { time: 'HH:MM', available_doctors: [...] }.
 */
async function getSlots(env, practiceId, type, dateStr, doctorFilter) {
  // 1. Day of week (1=Mo..7=So)
  const dt = new Date(dateStr + 'T00:00:00');
  const dayOfWeek = dt.getDay() === 0 ? 7 : dt.getDay();

  // 2. Fetch eligible doctors and their working hours for this day
  let doctorQuery = `
    SELECT DISTINCT d.id, d.name
    FROM doctors d
    JOIN doctor_appointment_types dat ON dat.doctor_id = d.id
    WHERE d.practice_id = ? AND d.is_active = 1 AND dat.appointment_type_id = ?
  `;
  const doctorBinds = [practiceId, type.id];
  if (doctorFilter && doctorFilter !== 'any') {
    doctorQuery += ' AND d.id = ?';
    doctorBinds.push(doctorFilter);
  }
  const doctorsRes = await env.DB.prepare(doctorQuery).bind(...doctorBinds).all();
  const doctors = doctorsRes.results;
  if (doctors.length === 0) return [];

  // 3. Load their working hours for this day
  const whRes = await env.DB.prepare(`
    SELECT doctor_id, start_time, end_time
    FROM working_hours
    WHERE practice_id = ? AND day_of_week = ?
      AND doctor_id IN (${doctors.map(() => '?').join(',')})
  `).bind(practiceId, dayOfWeek, ...doctors.map(d => d.id)).all();
  const whByDoctor = {};
  for (const row of whRes.results) {
    if (!whByDoctor[row.doctor_id]) whByDoctor[row.doctor_id] = [];
    whByDoctor[row.doctor_id].push({ start: row.start_time, end: row.end_time });
  }

  // 4. Load closures for this date
  const closuresRes = await env.DB.prepare(`
    SELECT doctor_id, start_time, end_time
    FROM closures
    WHERE practice_id = ? AND date = ?
  `).bind(practiceId, dateStr).all();

  // 5. Load existing appointments for this date (for conflict check)
  const apptsRes = await env.DB.prepare(`
    SELECT doctor_id, start_datetime, end_datetime
    FROM appointments
    WHERE practice_id = ? AND date(start_datetime) = ? AND status != 'cancelled'
  `).bind(practiceId, dateStr).all();

  // 6. Generate slots for each doctor
  const SLOT_INTERVAL = 15; // 15-minute grid
  const slotsByTime = {}; // { '09:00': [doc_id1, doc_id2], ... }

  for (const doc of doctors) {
    const hours = whByDoctor[doc.id] || [];
    for (const h of hours) {
      const [sh, sm] = h.start.split(':').map(Number);
      const [eh, em] = h.end.split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;

      for (let m = startMin; m + type.duration_minutes <= endMin; m += SLOT_INTERVAL) {
        const slotStart = `${dateStr}T${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}:00`;
        const slotEnd = `${dateStr}T${String(Math.floor((m+type.duration_minutes)/60)).padStart(2,'0')}:${String((m+type.duration_minutes)%60).padStart(2,'0')}:00`;

        // Skip past slots (today only)
        if (dateStr === new Date().toISOString().slice(0, 10)) {
          const now = new Date();
          const slotDate = new Date(slotStart);
          if (slotDate <= now) continue;
        }

        // Check closures
        const blocked = closuresRes.results.some(c => {
          if (c.doctor_id && c.doctor_id !== doc.id) return false;
          if (!c.start_time) return true; // full day
          return c.start_time < `${String(Math.floor((m+type.duration_minutes)/60)).padStart(2,'0')}:${String((m+type.duration_minutes)%60).padStart(2,'0')}`
              && c.end_time > `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
        });
        if (blocked) continue;

        // Check existing appointments
        const hasConflict = apptsRes.results.some(a => {
          if (a.doctor_id !== doc.id) return false;
          return a.start_datetime < slotEnd && a.end_datetime > slotStart;
        });
        if (hasConflict) continue;

        const timeStr = `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
        if (!slotsByTime[timeStr]) slotsByTime[timeStr] = [];
        slotsByTime[timeStr].push(doc.id);
      }
    }
  }

  return Object.keys(slotsByTime)
    .sort()
    .map(time => ({ time, available_doctors: slotsByTime[time] }));
}

// ============================================================
// POST /api/appointments — book (public)
// ============================================================
export async function handleAppointmentCreate(env, request) {
  const practice = await requirePractice(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const {
    first_name, last_name, birth_date, email, phone, insurance_type,
    doctor_id, appointment_type_id, start_datetime, patient_note,
  } = body;

  if (!first_name || !last_name || !email || !phone || !doctor_id || !appointment_type_id || !start_datetime) {
    return jsonError('Alle Pflichtfelder müssen ausgefüllt werden', request, 400);
  }

  // Verify type and doctor belong to this practice
  const type = await env.DB.prepare(`
    SELECT id, name, duration_minutes FROM appointment_types WHERE id=? AND practice_id=?
  `).bind(appointment_type_id, practice.id).first();
  if (!type) return jsonError('Behandlung nicht gefunden', request, 404);

  const doctor = await env.DB.prepare(`
    SELECT id, name FROM doctors WHERE id=? AND practice_id=?
  `).bind(doctor_id, practice.id).first();
  if (!doctor) return jsonError('Behandler nicht gefunden', request, 404);

  // Calculate end
  const startMs = new Date(start_datetime).getTime();
  if (isNaN(startMs)) return jsonError('Ungültiges Datum', request, 400);
  const endMs = startMs + type.duration_minutes * 60000;
  const end_datetime = new Date(endMs).toISOString().slice(0, 19);

  // Conflict check
  const conflict = await env.DB.prepare(`
    SELECT id FROM appointments
    WHERE doctor_id=? AND status != 'cancelled'
      AND start_datetime < ? AND end_datetime > ?
    LIMIT 1
  `).bind(doctor_id, end_datetime, start_datetime).first();
  if (conflict) return jsonError('Zeitraum inzwischen belegt', request, 409);

  // Closure check (vacation / Praxis geschlossen)
  const dateStr = start_datetime.slice(0, 10);
  const startTimeStr = start_datetime.slice(11, 16);
  const endTimeStr = end_datetime.slice(11, 16);
  const closureCheck = await env.DB.prepare(`
    SELECT id, start_time, end_time, reason
    FROM closures
    WHERE practice_id = ? AND date = ?
      AND (doctor_id IS NULL OR doctor_id = ?)
  `).bind(practice.id, dateStr, doctor_id).all();
  for (const c of (closureCheck.results || [])) {
    // Full-day closure
    if (!c.start_time && !c.end_time) {
      return jsonError(c.reason ? `Praxis geschlossen: ${c.reason}` : 'An diesem Tag ist die Praxis geschlossen', request, 409);
    }
    // Time range overlap
    if (c.start_time && c.end_time && c.start_time < endTimeStr && c.end_time > startTimeStr) {
      return jsonError(c.reason ? `Behandler nicht verfügbar: ${c.reason}` : 'Zu dieser Uhrzeit nicht verfügbar', request, 409);
    }
  }

  // Find or create patient
  let patient = await env.DB.prepare(`
    SELECT id FROM patients WHERE practice_id=? AND email=? LIMIT 1
  `).bind(practice.id, email).first();

  let patientId;
  const isNewPatient = !patient;
  if (patient) {
    patientId = patient.id;
    await env.DB.prepare(`
      UPDATE patients SET first_name=?, last_name=?, birth_date=?, phone=?, insurance_type=?
      WHERE id=?
    `).bind(first_name, last_name, birth_date || null, phone, insurance_type || 'gkv', patientId).run();
  } else {
    patientId = generateId('pat');
    await env.DB.prepare(`
      INSERT INTO patients (id, practice_id, first_name, last_name, birth_date, email, phone,
                            insurance_type, is_new_patient, consent_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    `).bind(patientId, practice.id, first_name, last_name, birth_date || null, email, phone, insurance_type || 'gkv').run();
  }

  // Create appointment
  const apptId = generateId('apt');
  const bookingCode = generateBookingCode();
  const magicToken = generateToken(24);

  await env.DB.prepare(`
    INSERT INTO appointments
      (id, booking_code, magic_token, practice_id, patient_id, doctor_id, appointment_type_id,
       start_datetime, end_datetime, duration_minutes, status, source,
       patient_note, confirmed_at, created_from_ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'online', ?, datetime('now'), ?)
  `).bind(
    apptId, bookingCode, magicToken, practice.id, patientId, doctor_id, appointment_type_id,
    start_datetime, end_datetime, type.duration_minutes,
    patient_note || null,
    getClientIp(request)
  ).run();

  await logAudit(env, {
    practice_id: practice.id,
    actor_type: 'patient',
    actor_id: patientId,
    action: 'appointment.created',
    target_type: 'appointment',
    target_id: apptId,
    meta: { booking_code: bookingCode, is_new_patient: isNewPatient },
    request,
  });

  return jsonResponse({
    booking_code: bookingCode,
    magic_token: magicToken,
    id: apptId,
    start_datetime,
    end_datetime,
    doctor_name: doctor.name,
    type_name: type.name,
  }, request, 201);
}

// ============================================================
// GET /api/appointments/:token — patient self-service lookup
// DELETE /api/appointments/:token — patient self-cancel
// ============================================================
export async function handleAppointmentLookup(env, request, magicToken) {
  const appt = await env.DB.prepare(`
    SELECT a.id, a.booking_code, a.start_datetime, a.end_datetime, a.status,
           a.patient_note, a.practice_id,
           p.first_name, p.last_name, p.email, p.phone,
           d.name as doctor_name,
           t.name as type_name, t.icon as type_icon,
           pr.name as practice_name, pr.phone as practice_phone, pr.city,
           pr.street, pr.postal_code, pr.logo_url, pr.brand_primary
    FROM appointments a
    JOIN patients p ON p.id = a.patient_id
    JOIN doctors d ON d.id = a.doctor_id
    JOIN appointment_types t ON t.id = a.appointment_type_id
    JOIN practices pr ON pr.id = a.practice_id
    WHERE a.magic_token = ?
  `).bind(magicToken).first();
  if (!appt) return jsonError('Termin nicht gefunden', request, 404);
  return jsonResponse(appt, request);
}

export async function handleAppointmentPatientCancel(env, request, magicToken) {
  const appt = await env.DB.prepare(`
    SELECT id, practice_id, status, booking_code FROM appointments WHERE magic_token=?
  `).bind(magicToken).first();
  if (!appt) return jsonError('Termin nicht gefunden', request, 404);
  if (appt.status === 'cancelled') return jsonError('Bereits abgesagt', request, 410);

  await env.DB.prepare(`
    UPDATE appointments
    SET status='cancelled', cancelled_at=datetime('now'), cancelled_by='patient'
    WHERE id=?
  `).bind(appt.id).run();

  await logAudit(env, {
    practice_id: appt.practice_id,
    actor_type: 'patient',
    action: 'appointment.cancelled',
    target_type: 'appointment',
    target_id: appt.id,
    meta: { booking_code: appt.booking_code, by: 'patient' },
    request,
  });

  return jsonResponse({ ok: true }, request);
}
