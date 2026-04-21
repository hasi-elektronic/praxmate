import { jsonResponse, jsonError } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { generateId } from '../lib/crypto.js';
import { logAudit } from '../lib/audit.js';

// ============================================================
// GET /api/admin/patients?q=...&sort=name&page=1&limit=50
// Paginated list with search + sort
// ============================================================
export async function handlePatientsList(env, request) {
  const user = await requireAuth(env, request);
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const sort = url.searchParams.get('sort') || 'recent'; // recent | name | appointments
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(10, parseInt(url.searchParams.get('limit') || '50')));
  const offset = (page - 1) * limit;

  let where = 'p.practice_id = ?';
  const binds = [user.practice_id];

  if (q.length >= 2) {
    where += ' AND (p.last_name LIKE ? OR p.first_name LIKE ? OR p.email LIKE ? OR p.phone LIKE ?)';
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }

  const orderBy = {
    recent:       'p.last_visit_at DESC NULLS LAST, p.created_at DESC',
    name:         'p.last_name ASC, p.first_name ASC',
    appointments: 'appt_count DESC, p.last_name ASC',
    created:      'p.created_at DESC',
  }[sort] || 'p.created_at DESC';

  // Count total
  const total = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM patients p WHERE ${where}
  `).bind(...binds).first();

  // Get page
  const res = await env.DB.prepare(`
    SELECT p.id, p.first_name, p.last_name, p.birth_date, p.email, p.phone,
           p.insurance_type, p.is_new_patient, p.last_visit_at, p.created_at,
           (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id AND a.status != 'cancelled') as appt_count,
           (SELECT MAX(a.start_datetime) FROM appointments a WHERE a.patient_id = p.id AND a.status != 'cancelled') as last_appt,
           (SELECT MIN(a.start_datetime) FROM appointments a WHERE a.patient_id = p.id AND a.status = 'confirmed' AND a.start_datetime > datetime('now')) as next_appt
    FROM patients p
    WHERE ${where}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).bind(...binds, limit, offset).all();

  return jsonResponse({
    patients: res.results,
    pagination: {
      page, limit, total: total.n, total_pages: Math.ceil(total.n / limit),
    },
  }, request);
}

// ============================================================
// GET /api/admin/patients/:id — detail with full history
// ============================================================
export async function handlePatientDetailFull(env, request, patientId) {
  const user = await requireAuth(env, request);

  const patient = await env.DB.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id AND a.status = 'confirmed') as confirmed_count,
      (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id AND a.status = 'cancelled') as cancelled_count,
      (SELECT COUNT(*) FROM appointments a WHERE a.patient_id = p.id AND a.status = 'noshow') as noshow_count
    FROM patients p
    WHERE p.id = ? AND p.practice_id = ?
  `).bind(patientId, user.practice_id).first();
  if (!patient) return jsonError('Patient nicht gefunden', request, 404);

  // Appointments (past + future)
  const appointments = await env.DB.prepare(`
    SELECT a.id, a.booking_code, a.start_datetime, a.end_datetime, a.status,
           a.source, a.patient_note, a.staff_note,
           d.name as doctor_name, d.avatar_initials as doctor_initials,
           t.name as type_name, t.icon as type_icon, t.code as type_code
    FROM appointments a
    JOIN doctors d ON d.id = a.doctor_id
    JOIN appointment_types t ON t.id = a.appointment_type_id
    WHERE a.patient_id = ? AND a.practice_id = ?
    ORDER BY a.start_datetime DESC
    LIMIT 100
  `).bind(patientId, user.practice_id).all();

  return jsonResponse({
    patient,
    appointments: appointments.results,
  }, request);
}

// ============================================================
// POST /api/admin/patients — create
// ============================================================
export async function handlePatientCreate(env, request) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  if (!body.first_name || !body.last_name) {
    return jsonError('Vor- und Nachname erforderlich', request, 400);
  }

  // Optional duplicate check by email
  if (body.email) {
    const dup = await env.DB.prepare(`SELECT id FROM patients WHERE practice_id = ? AND email = ?`)
      .bind(user.practice_id, body.email).first();
    if (dup) {
      return jsonError('Patient mit dieser E-Mail existiert bereits', request, 409, { existing_id: dup.id });
    }
  }

  const id = generateId('pat');
  await env.DB.prepare(`
    INSERT INTO patients (
      id, practice_id, first_name, last_name, birth_date, email, phone,
      insurance_type, insurance_number, is_new_patient, notes,
      consent_at, marketing_consent, created_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, user.practice_id,
    body.first_name.trim(), body.last_name.trim(),
    body.birth_date || null,
    body.email?.trim() || null, body.phone?.trim() || null,
    body.insurance_type || 'gkv',
    body.insurance_number?.trim() || null,
    body.is_new_patient ? 1 : 0,
    body.notes?.trim() || null,
    body.consent_at || null,
    body.marketing_consent ? 1 : 0,
    user.user_id,
  ).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'patient.created', target_type: 'patient', target_id: id,
    meta: { name: `${body.first_name} ${body.last_name}` }, request,
  });

  return jsonResponse({ id, ...body }, request, 201);
}

// ============================================================
// PUT /api/admin/patients/:id
// ============================================================
export async function handlePatientUpdate(env, request, patientId) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const existing = await env.DB.prepare(`SELECT id FROM patients WHERE id = ? AND practice_id = ?`)
    .bind(patientId, user.practice_id).first();
  if (!existing) return jsonError('Patient nicht gefunden', request, 404);

  const allowed = [
    'first_name', 'last_name', 'birth_date',
    'email', 'phone',
    'insurance_type', 'insurance_number',
    'is_new_patient', 'notes', 'marketing_consent',
  ];
  const updates = {};
  for (const k of allowed) {
    if (k in body) {
      if (k === 'is_new_patient' || k === 'marketing_consent') {
        updates[k] = body[k] ? 1 : 0;
      } else {
        updates[k] = body[k] === '' ? null : body[k];
      }
    }
  }
  if (Object.keys(updates).length === 0) return jsonError('Keine Änderungen', request, 400);

  // If email is being changed, check for duplicates
  if (updates.email) {
    const dup = await env.DB.prepare(`
      SELECT id FROM patients WHERE practice_id = ? AND email = ? AND id != ?
    `).bind(user.practice_id, updates.email, patientId).first();
    if (dup) return jsonError('Anderer Patient nutzt diese E-Mail bereits', request, 409);
  }

  const fields = Object.keys(updates);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => updates[f]);

  await env.DB.prepare(`UPDATE patients SET ${setClause} WHERE id = ?`)
    .bind(...values, patientId).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'patient.updated', target_type: 'patient', target_id: patientId,
    meta: { fields }, request,
  });

  const updated = await env.DB.prepare(`SELECT * FROM patients WHERE id = ?`).bind(patientId).first();
  return jsonResponse(updated, request);
}

// ============================================================
// DELETE /api/admin/patients/:id (owner only)
// Only if no appointments exist — otherwise soft-hide
// ============================================================
export async function handlePatientDelete(env, request, patientId) {
  const user = await requireRole(env, request, ['owner']);

  const patient = await env.DB.prepare(`
    SELECT first_name, last_name,
      (SELECT COUNT(*) FROM appointments WHERE patient_id = ?) as appt_count
    FROM patients WHERE id = ? AND practice_id = ?
  `).bind(patientId, patientId, user.practice_id).first();
  if (!patient) return jsonError('Patient nicht gefunden', request, 404);

  if (patient.appt_count > 0) {
    return jsonError(
      `Patient hat ${patient.appt_count} Termin(e). Löschen nicht möglich. Bitte nur Daten anonymisieren.`,
      request, 409
    );
  }

  await env.DB.prepare(`DELETE FROM patients WHERE id = ?`).bind(patientId).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'patient.deleted', target_type: 'patient', target_id: patientId,
    meta: { name: `${patient.first_name} ${patient.last_name}` }, request,
  });

  return jsonResponse({ ok: true }, request);
}

// ============================================================
// PUT /api/admin/patients/:id/notes — update internal notes only
// Shortcut endpoint so staff can add notes without touching PII
// ============================================================
export async function handlePatientNotes(env, request, patientId) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const existing = await env.DB.prepare(`SELECT id FROM patients WHERE id = ? AND practice_id = ?`)
    .bind(patientId, user.practice_id).first();
  if (!existing) return jsonError('Patient nicht gefunden', request, 404);

  await env.DB.prepare(`UPDATE patients SET notes = ? WHERE id = ?`)
    .bind(body.notes || null, patientId).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'patient.notes_updated', target_type: 'patient', target_id: patientId, request,
  });

  return jsonResponse({ ok: true, notes: body.notes }, request);
}
