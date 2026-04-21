import { jsonResponse, jsonError } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { generateId, hashPassword } from '../lib/crypto.js';
import { logAudit } from '../lib/audit.js';

// ============================================================
// DOCTORS
// ============================================================

// GET /api/admin/doctors — list
export async function handleDoctorsListAdmin(env, request) {
  const user = await requireAuth(env, request);
  const res = await env.DB.prepare(`
    SELECT d.id, d.name, d.title, d.role, d.specialty, d.avatar_initials,
           d.is_active, d.accepts_new_patients, d.sort_order,
           (SELECT COUNT(*) FROM doctor_appointment_types dat WHERE dat.doctor_id = d.id) as type_count,
           (SELECT COUNT(*) FROM working_hours wh WHERE wh.doctor_id = d.id) as hours_count
    FROM doctors d
    WHERE d.practice_id = ?
    ORDER BY d.sort_order, d.name
  `).bind(user.practice_id).all();
  return jsonResponse({ doctors: res.results }, request);
}

// POST /api/admin/doctors — create (owner)
export async function handleDoctorCreate(env, request) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  if (!body.name) return jsonError('Name erforderlich', request, 400);

  // Count current doctors vs plan limit
  const practice = await env.DB.prepare(`SELECT max_doctors, plan FROM practices WHERE id = ?`).bind(user.practice_id).first();
  const currentCount = await env.DB.prepare(`SELECT COUNT(*) as n FROM doctors WHERE practice_id = ? AND is_active = 1`).bind(user.practice_id).first();
  if (practice.max_doctors > 0 && currentCount.n >= practice.max_doctors) {
    return jsonError(`Plan-Limit erreicht (${practice.max_doctors} Behandler im ${practice.plan}-Plan)`, request, 403);
  }

  const id = generateId('doc');
  const initials = body.avatar_initials || body.name.replace(/(Dr\.|Prof\.|Frau|Herr)\s*/gi, '').trim().split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase();

  await env.DB.prepare(`
    INSERT INTO doctors (id, practice_id, name, title, role, specialty, avatar_initials,
                         sort_order, is_active, accepts_new_patients)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).bind(
    id, user.practice_id, body.name, body.title || null, body.role || null,
    body.specialty || null, initials, body.sort_order || 99,
    body.accepts_new_patients !== false ? 1 : 0
  ).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'doctor.created', target_type: 'doctor', target_id: id,
    meta: { name: body.name }, request,
  });

  return jsonResponse({ id, ...body, avatar_initials: initials }, request, 201);
}

// PUT /api/admin/doctors/:id
export async function handleDoctorUpdate(env, request, doctorId) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const doctor = await env.DB.prepare(`SELECT id FROM doctors WHERE id = ? AND practice_id = ?`).bind(doctorId, user.practice_id).first();
  if (!doctor) return jsonError('Behandler nicht gefunden', request, 404);

  const allowed = ['name', 'title', 'role', 'specialty', 'avatar_initials', 'sort_order', 'is_active', 'accepts_new_patients'];
  const updates = {};
  for (const k of allowed) if (k in body) updates[k] = body[k];

  if (Object.keys(updates).length === 0) return jsonError('Keine Änderungen', request, 400);

  const fields = Object.keys(updates);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => {
    const v = updates[f];
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });

  await env.DB.prepare(`UPDATE doctors SET ${setClause} WHERE id = ?`).bind(...values, doctorId).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'doctor.updated', target_type: 'doctor', target_id: doctorId,
    meta: { fields }, request,
  });

  return jsonResponse({ id: doctorId, ...updates }, request);
}

// DELETE /api/admin/doctors/:id — soft delete (is_active=0)
export async function handleDoctorDelete(env, request, doctorId) {
  const user = await requireRole(env, request, ['owner']);

  const doctor = await env.DB.prepare(`SELECT name FROM doctors WHERE id = ? AND practice_id = ?`).bind(doctorId, user.practice_id).first();
  if (!doctor) return jsonError('Behandler nicht gefunden', request, 404);

  // Check future appointments
  const future = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM appointments
    WHERE doctor_id = ? AND status = 'confirmed' AND start_datetime > datetime('now')
  `).bind(doctorId).first();
  if (future.n > 0) {
    return jsonError(`Behandler hat noch ${future.n} zukünftige Termine. Bitte zuerst umbuchen oder stornieren.`, request, 409);
  }

  await env.DB.prepare(`UPDATE doctors SET is_active = 0 WHERE id = ?`).bind(doctorId).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'doctor.deactivated', target_type: 'doctor', target_id: doctorId,
    meta: { name: doctor.name }, request,
  });

  return jsonResponse({ ok: true }, request);
}

// ============================================================
// APPOINTMENT TYPES
// ============================================================

// GET /api/admin/types
export async function handleTypesListAdmin(env, request) {
  const user = await requireAuth(env, request);
  const res = await env.DB.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM doctor_appointment_types dat WHERE dat.appointment_type_id = t.id) as doctor_count
    FROM appointment_types t
    WHERE t.practice_id = ?
    ORDER BY t.sort_order, t.name
  `).bind(user.practice_id).all();

  // For each type, also fetch doctor IDs assigned
  const typesWithDoctors = [];
  for (const t of res.results) {
    const docs = await env.DB.prepare(`
      SELECT doctor_id FROM doctor_appointment_types WHERE appointment_type_id = ?
    `).bind(t.id).all();
    typesWithDoctors.push({ ...t, doctor_ids: docs.results.map(d => d.doctor_id) });
  }

  return jsonResponse({ types: typesWithDoctors }, request);
}

// POST /api/admin/types
export async function handleTypeCreate(env, request) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  if (!body.code || !body.name || !body.duration_minutes) {
    return jsonError('code, name, duration_minutes erforderlich', request, 400);
  }
  if (!/^[a-z0-9_-]+$/.test(body.code)) {
    return jsonError('Code nur Kleinbuchstaben, Zahlen, - und _', request, 400);
  }

  // Check code uniqueness
  const existing = await env.DB.prepare(`SELECT id FROM appointment_types WHERE practice_id = ? AND code = ?`).bind(user.practice_id, body.code).first();
  if (existing) return jsonError(`Code "${body.code}" bereits vergeben`, request, 409);

  const id = generateId('apt');
  await env.DB.prepare(`
    INSERT INTO appointment_types (id, practice_id, code, name, description, duration_minutes,
                                   icon, color, online_bookable, requires_approval, new_patient_only,
                                   sort_order, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    id, user.practice_id, body.code, body.name,
    body.description || null, body.duration_minutes,
    body.icon || '🏥', body.color || null,
    body.online_bookable !== false ? 1 : 0,
    body.requires_approval ? 1 : 0,
    body.new_patient_only ? 1 : 0,
    body.sort_order || 99,
  ).run();

  // Assign to doctors
  const doctorIds = Array.isArray(body.doctor_ids) ? body.doctor_ids : [];
  for (const docId of doctorIds) {
    // Verify doctor belongs to this practice
    const d = await env.DB.prepare(`SELECT id FROM doctors WHERE id = ? AND practice_id = ?`).bind(docId, user.practice_id).first();
    if (d) {
      await env.DB.prepare(`
        INSERT INTO doctor_appointment_types (doctor_id, appointment_type_id, practice_id)
        VALUES (?, ?, ?)
      `).bind(docId, id, user.practice_id).run();
    }
  }

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'type.created', target_type: 'appointment_type', target_id: id,
    meta: { code: body.code, name: body.name }, request,
  });

  return jsonResponse({ id, ...body }, request, 201);
}

// PUT /api/admin/types/:id
export async function handleTypeUpdate(env, request, typeId) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const type = await env.DB.prepare(`SELECT id FROM appointment_types WHERE id = ? AND practice_id = ?`).bind(typeId, user.practice_id).first();
  if (!type) return jsonError('Behandlungsart nicht gefunden', request, 404);

  const allowed = ['name', 'description', 'duration_minutes', 'icon', 'color',
                   'online_bookable', 'requires_approval', 'new_patient_only', 'sort_order', 'is_active'];
  const updates = {};
  for (const k of allowed) if (k in body) updates[k] = body[k];

  if (Object.keys(updates).length > 0) {
    const fields = Object.keys(updates);
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => {
      const v = updates[f];
      if (typeof v === 'boolean') return v ? 1 : 0;
      return v;
    });
    await env.DB.prepare(`UPDATE appointment_types SET ${setClause} WHERE id = ?`).bind(...values, typeId).run();
  }

  // Update doctor assignments if provided
  if (Array.isArray(body.doctor_ids)) {
    await env.DB.prepare(`DELETE FROM doctor_appointment_types WHERE appointment_type_id = ?`).bind(typeId).run();
    for (const docId of body.doctor_ids) {
      const d = await env.DB.prepare(`SELECT id FROM doctors WHERE id = ? AND practice_id = ?`).bind(docId, user.practice_id).first();
      if (d) {
        await env.DB.prepare(`
          INSERT INTO doctor_appointment_types (doctor_id, appointment_type_id, practice_id) VALUES (?, ?, ?)
        `).bind(docId, typeId, user.practice_id).run();
      }
    }
  }

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'type.updated', target_type: 'appointment_type', target_id: typeId, request,
  });

  return jsonResponse({ id: typeId, ...updates }, request);
}

// DELETE /api/admin/types/:id
export async function handleTypeDelete(env, request, typeId) {
  const user = await requireRole(env, request, ['owner']);

  const type = await env.DB.prepare(`SELECT name FROM appointment_types WHERE id = ? AND practice_id = ?`).bind(typeId, user.practice_id).first();
  if (!type) return jsonError('Behandlungsart nicht gefunden', request, 404);

  const future = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM appointments
    WHERE appointment_type_id = ? AND status = 'confirmed' AND start_datetime > datetime('now')
  `).bind(typeId).first();
  if (future.n > 0) {
    return jsonError(`${future.n} zukünftige Termine nutzen diese Behandlungsart. Bitte zuerst umbuchen.`, request, 409);
  }

  await env.DB.prepare(`UPDATE appointment_types SET is_active = 0 WHERE id = ?`).bind(typeId).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'type.deactivated', target_type: 'appointment_type', target_id: typeId,
    meta: { name: type.name }, request,
  });

  return jsonResponse({ ok: true }, request);
}

// ============================================================
// WORKING HOURS
// ============================================================

// GET /api/admin/hours — all working hours grouped by doctor + day
export async function handleHoursList(env, request) {
  const user = await requireAuth(env, request);
  const res = await env.DB.prepare(`
    SELECT id, doctor_id, day_of_week, start_time, end_time
    FROM working_hours
    WHERE practice_id = ?
    ORDER BY doctor_id, day_of_week, start_time
  `).bind(user.practice_id).all();
  return jsonResponse({ hours: res.results }, request);
}

// PUT /api/admin/hours/:doctor_id — replace all hours for a doctor
// Body: { shifts: [ { day_of_week: 1, start_time: '08:00', end_time: '12:00' }, ... ] }
export async function handleHoursUpdate(env, request, doctorId) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const doctor = await env.DB.prepare(`SELECT id FROM doctors WHERE id = ? AND practice_id = ?`).bind(doctorId, user.practice_id).first();
  if (!doctor) return jsonError('Behandler nicht gefunden', request, 404);

  const shifts = Array.isArray(body.shifts) ? body.shifts : [];
  // Validate all
  for (const s of shifts) {
    if (!Number.isInteger(s.day_of_week) || s.day_of_week < 1 || s.day_of_week > 7) {
      return jsonError('day_of_week muss 1-7 sein', request, 400);
    }
    if (!/^\d{2}:\d{2}$/.test(s.start_time) || !/^\d{2}:\d{2}$/.test(s.end_time)) {
      return jsonError('Zeiten im Format HH:MM', request, 400);
    }
    if (s.start_time >= s.end_time) return jsonError('Ende muss nach Start liegen', request, 400);
  }

  // Replace atomically
  await env.DB.prepare(`DELETE FROM working_hours WHERE doctor_id = ?`).bind(doctorId).run();
  for (const s of shifts) {
    await env.DB.prepare(`
      INSERT INTO working_hours (id, practice_id, doctor_id, day_of_week, start_time, end_time)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(generateId('wh'), user.practice_id, doctorId, s.day_of_week, s.start_time, s.end_time).run();
  }

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'hours.updated', target_type: 'doctor', target_id: doctorId,
    meta: { shift_count: shifts.length }, request,
  });

  return jsonResponse({ ok: true, shifts }, request);
}

// ============================================================
// USERS (team members)
// ============================================================

// GET /api/admin/users
export async function handleUsersList(env, request) {
  const user = await requireAuth(env, request);
  const res = await env.DB.prepare(`
    SELECT id, email, name, role, doctor_id, avatar_initials, status,
           last_login_at, created_at
    FROM users
    WHERE practice_id = ?
    ORDER BY role DESC, name
  `).bind(user.practice_id).all();
  return jsonResponse({ users: res.results }, request);
}

// POST /api/admin/users — create (owner)
export async function handleUserCreate(env, request) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const { email, name, role, password, doctor_id } = body;
  if (!email || !name || !role || !password) {
    return jsonError('email, name, role, password erforderlich', request, 400);
  }
  if (!['owner', 'doctor', 'staff'].includes(role)) {
    return jsonError('Rolle: owner, doctor oder staff', request, 400);
  }
  if (password.length < 8) return jsonError('Passwort min. 8 Zeichen', request, 400);

  // Check uniqueness per practice
  const existing = await env.DB.prepare(`SELECT id FROM users WHERE practice_id = ? AND email = ?`).bind(user.practice_id, email).first();
  if (existing) return jsonError(`E-Mail "${email}" bereits vorhanden`, request, 409);

  // Verify doctor_id belongs to practice if provided
  if (doctor_id) {
    const d = await env.DB.prepare(`SELECT id FROM doctors WHERE id = ? AND practice_id = ?`).bind(doctor_id, user.practice_id).first();
    if (!d) return jsonError('Behandler nicht gefunden', request, 404);
  }

  const { hash, salt } = await hashPassword(password);
  const id = generateId('usr');
  const initials = name.split(/\s+/).slice(0,2).map(w => w[0]).join('').toUpperCase();

  await env.DB.prepare(`
    INSERT INTO users (id, practice_id, email, name, role, doctor_id, avatar_initials,
                       password_hash, password_salt, password_updated_at, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'active', ?)
  `).bind(id, user.practice_id, email, name, role, doctor_id || null, initials, hash, salt, user.user_id).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'user.created', target_type: 'user', target_id: id,
    meta: { email, role }, request,
  });

  return jsonResponse({ id, email, name, role, avatar_initials: initials }, request, 201);
}

// PUT /api/admin/users/:id
export async function handleUserUpdate(env, request, userId) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const target = await env.DB.prepare(`SELECT id, role FROM users WHERE id = ? AND practice_id = ?`).bind(userId, user.practice_id).first();
  if (!target) return jsonError('Nutzer nicht gefunden', request, 404);

  // Prevent demoting self from owner
  if (userId === user.user_id && body.role && body.role !== 'owner') {
    return jsonError('Kann die eigene Owner-Rolle nicht entfernen', request, 400);
  }

  const allowed = ['name', 'role', 'doctor_id', 'status'];
  const updates = {};
  for (const k of allowed) if (k in body) updates[k] = body[k];

  // Password change?
  if (body.password) {
    if (body.password.length < 8) return jsonError('Passwort min. 8 Zeichen', request, 400);
    const { hash, salt } = await hashPassword(body.password);
    updates.password_hash = hash;
    updates.password_salt = salt;
    updates.password_updated_at = "datetime('now')";
  }

  if (Object.keys(updates).length === 0) return jsonError('Keine Änderungen', request, 400);

  // Handle raw SQL for datetime
  const sqlFields = [];
  const bindValues = [];
  for (const [k, v] of Object.entries(updates)) {
    if (k === 'password_updated_at') {
      sqlFields.push(`${k} = datetime('now')`);
    } else {
      sqlFields.push(`${k} = ?`);
      bindValues.push(v);
    }
  }

  await env.DB.prepare(`UPDATE users SET ${sqlFields.join(', ')} WHERE id = ?`).bind(...bindValues, userId).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'user.updated', target_type: 'user', target_id: userId,
    meta: { fields: Object.keys(updates), password_changed: !!body.password }, request,
  });

  return jsonResponse({ id: userId, ...updates, password_hash: undefined, password_salt: undefined }, request);
}

// DELETE /api/admin/users/:id
export async function handleUserDelete(env, request, userId) {
  const user = await requireRole(env, request, ['owner']);
  if (userId === user.user_id) {
    return jsonError('Kann sich selbst nicht löschen', request, 400);
  }

  const target = await env.DB.prepare(`SELECT email, role FROM users WHERE id = ? AND practice_id = ?`).bind(userId, user.practice_id).first();
  if (!target) return jsonError('Nutzer nicht gefunden', request, 404);

  await env.DB.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).bind(userId).run();
  await env.DB.prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`).bind(userId).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'user.suspended', target_type: 'user', target_id: userId,
    meta: { email: target.email }, request,
  });

  return jsonResponse({ ok: true }, request);
}
