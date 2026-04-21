// ============================================================
// CLOSURES (Abwesenheiten / Urlaub / Praxis geschlossen)
// ============================================================
import { requireAuth } from '../lib/auth.js';
import { jsonResponse, jsonError } from '../lib/http.js';

function newId(prefix = 'cls') {
  return prefix + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function dateRange(startISO, endISO) {
  const out = [];
  const start = new Date(startISO + 'T00:00:00Z');
  const end = new Date(endISO + 'T00:00:00Z');
  if (end < start) return out;
  const cur = new Date(start);
  while (cur <= end) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  if (out.length > 366) return out.slice(0, 366);
  return out;
}

// ---------- LIST ----------
// GET /api/admin/closures?from=YYYY-MM-DD&to=YYYY-MM-DD&doctor_id=...
export async function handleClosuresList(env, request) {
  const user = await requireAuth(env, request);
  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const doctorId = url.searchParams.get('doctor_id');

  const conditions = ['c.practice_id = ?'];
  const args = [user.practice_id];

  if (from) { conditions.push('c.date >= ?'); args.push(from); }
  if (to) { conditions.push('c.date <= ?'); args.push(to); }
  if (doctorId === 'all') {
    conditions.push('c.doctor_id IS NULL');
  } else if (doctorId) {
    conditions.push('(c.doctor_id IS NULL OR c.doctor_id = ?)');
    args.push(doctorId);
  }

  const stmt = env.DB.prepare(`
    SELECT
      c.id, c.doctor_id, c.date, c.start_time, c.end_time, c.reason, c.created_at,
      d.name AS doctor_name
    FROM closures c
    LEFT JOIN doctors d ON d.id = c.doctor_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY c.date ASC, c.start_time ASC
  `).bind(...args);

  const result = await stmt.all();
  return jsonResponse({ closures: result.results || [] }, request);
}

// ---------- CREATE ----------
// POST /api/admin/closures
// Body: { date_from, date_to, doctor_id|null, start_time|null, end_time|null, reason|null }
export async function handleClosuresCreate(env, request) {
  const user = await requireAuth(env, request);
  if (user.role !== 'owner') {
    return jsonError('Nur der Inhaber kann Abwesenheiten verwalten.', request, 403);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonError('Ungültiger Body', request, 400); }

  const dateFrom = (body.date_from || '').trim();
  const dateTo = (body.date_to || dateFrom).trim();
  const doctorId = body.doctor_id || null;
  const startTime = (body.start_time || '').trim() || null;
  const endTime = (body.end_time || '').trim() || null;
  const reason = (body.reason || '').trim() || null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    return jsonError('Datum muss im Format YYYY-MM-DD sein.', request, 400);
  }
  if (dateTo < dateFrom) {
    return jsonError('Bis-Datum muss nach Von-Datum liegen.', request, 400);
  }
  if ((startTime && !endTime) || (!startTime && endTime)) {
    return jsonError('Start- und End-Zeit müssen zusammen angegeben werden.', request, 400);
  }
  if (startTime && endTime && startTime >= endTime) {
    return jsonError('Start-Zeit muss vor End-Zeit liegen.', request, 400);
  }

  if (doctorId) {
    const doc = await env.DB.prepare(
      'SELECT id FROM doctors WHERE id = ? AND practice_id = ?'
    ).bind(doctorId, user.practice_id).first();
    if (!doc) return jsonError('Behandler nicht gefunden.', request, 400);
  }

  const dates = dateRange(dateFrom, dateTo);
  if (dates.length === 0) {
    return jsonError('Ungültiger Datumsbereich.', request, 400);
  }

  const inserted = [];
  for (const date of dates) {
    const id = newId();
    await env.DB.prepare(`
      INSERT INTO closures (id, practice_id, doctor_id, date, start_time, end_time, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(id, user.practice_id, doctorId, date, startTime, endTime, reason).run();
    inserted.push(id);
  }

  return jsonResponse({
    ok: true,
    count: inserted.length,
    ids: inserted,
  }, request);
}

// ---------- DELETE ----------
// DELETE /api/admin/closures/:id
export async function handleClosuresDelete(env, request, id) {
  const user = await requireAuth(env, request);
  if (user.role !== 'owner') {
    return jsonError('Nur der Inhaber kann Abwesenheiten löschen.', request, 403);
  }

  const result = await env.DB.prepare(
    'DELETE FROM closures WHERE id = ? AND practice_id = ?'
  ).bind(id, user.practice_id).run();

  if (!result.meta.changes) {
    return jsonError('Abwesenheit nicht gefunden.', request, 404);
  }
  return jsonResponse({ ok: true }, request);
}

// ---------- HELPER for booking validation ----------
export async function isTimeBlocked(env, practiceId, doctorId, dateISO, timeHHMM) {
  const result = await env.DB.prepare(`
    SELECT id, start_time, end_time, reason
    FROM closures
    WHERE practice_id = ?
      AND date = ?
      AND (doctor_id IS NULL OR doctor_id = ?)
  `).bind(practiceId, dateISO, doctorId).all();

  for (const row of (result.results || [])) {
    if (!row.start_time && !row.end_time) return { blocked: true, reason: row.reason };
    if (row.start_time && row.end_time && timeHHMM >= row.start_time && timeHHMM < row.end_time) {
      return { blocked: true, reason: row.reason };
    }
  }
  return { blocked: false };
}
