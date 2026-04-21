#!/usr/bin/env node
// ============================================================
// HILD MIGRATION — v1 DB → v2 DB
// ============================================================
// Moves patients + appointments from praxmate-hild to praxmate.
// Idempotent: re-run safe. Skips records already migrated (by booking_code).
// ============================================================

const CF_TOKEN = process.env.CF_TOKEN;
if (!CF_TOKEN) { console.error('CF_TOKEN required'); process.exit(1); }

const CF_ACCOUNT = 'ac6ab4ce1149a3591d014841856490af';
const OLD_DB = '613be9c6-b8c1-4972-a024-4d5723f03db8'; // praxmate-hild
const NEW_DB = 'd9548a59-aead-4d13-b082-ad82f602cfe4'; // praxmate
const HILD_PRACTICE_SLUG = 'hild';

async function d1(dbId, sql, params = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${dbId}/query`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CF_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    }
  );
  const data = await res.json();
  if (!data.success) {
    console.error('D1 error:', JSON.stringify(data.errors));
    throw new Error('D1 query failed');
  }
  return data.result[0];
}

async function main() {
  console.log('=== HILD MIGRATION v1 → v2 ===\n');

  // 1. Get new Hild practice_id
  const pRes = await d1(NEW_DB, `SELECT id FROM practices WHERE slug = ?`, [HILD_PRACTICE_SLUG]);
  if (pRes.results.length === 0) throw new Error(`Practice "${HILD_PRACTICE_SLUG}" not found in new DB`);
  const practiceId = pRes.results[0].id;
  console.log(`Hild practice in new DB: ${practiceId}\n`);

  // 2. Build ID mappings
  // Doctors: old.id → new.id (by name)
  const oldDocs = (await d1(OLD_DB, `SELECT id, name FROM doctors`)).results;
  const newDocs = (await d1(NEW_DB, `SELECT id, name FROM doctors WHERE practice_id = ?`, [practiceId])).results;
  const docMap = {};
  for (const od of oldDocs) {
    const nd = newDocs.find(n => n.name === od.name);
    if (!nd) { console.error(`✗ No doctor match for: ${od.name}`); process.exit(1); }
    docMap[od.id] = nd.id;
  }
  console.log('Doctor mapping:');
  Object.entries(docMap).forEach(([k,v]) => console.log(`  ${k} → ${v}`));

  // Appointment types: old.code → new.id
  const oldTypes = (await d1(OLD_DB, `SELECT id, code FROM appointment_types`)).results;
  const newTypes = (await d1(NEW_DB, `SELECT id, code FROM appointment_types WHERE practice_id = ?`, [practiceId])).results;
  const typeMap = {};
  for (const ot of oldTypes) {
    const nt = newTypes.find(n => n.code === ot.code);
    if (!nt) { console.error(`✗ No type match for code: ${ot.code}`); process.exit(1); }
    typeMap[ot.id] = nt.id;
  }
  console.log('\nType mapping:');
  Object.entries(typeMap).forEach(([k,v]) => console.log(`  ${k} → ${v}`));

  // 3. Migrate patients
  console.log('\n--- MIGRATING PATIENTS ---');
  const oldPatients = (await d1(OLD_DB, `SELECT * FROM patients ORDER BY created_at`)).results;
  console.log(`Found ${oldPatients.length} patients in old DB`);

  const patientMap = {}; // old.id → new.id
  let patientsCreated = 0, patientsSkipped = 0;

  for (const op of oldPatients) {
    // Check if already migrated (by email within this practice, OR by name + birth_date)
    let existing = null;
    if (op.email) {
      const r = await d1(NEW_DB, `SELECT id FROM patients WHERE practice_id = ? AND email = ?`, [practiceId, op.email]);
      existing = r.results[0];
    }
    if (!existing && op.first_name && op.last_name && op.birth_date) {
      const r = await d1(NEW_DB, `
        SELECT id FROM patients
        WHERE practice_id = ? AND first_name = ? AND last_name = ? AND birth_date = ?
      `, [practiceId, op.first_name, op.last_name, op.birth_date]);
      existing = r.results[0];
    }

    if (existing) {
      patientMap[op.id] = existing.id;
      patientsSkipped++;
    } else {
      // Create new
      const newId = 'pat_' + crypto.randomUUID().replace(/-/g,'').slice(0, 24);
      await d1(NEW_DB, `
        INSERT INTO patients (
          id, practice_id, first_name, last_name, birth_date, email, phone,
          insurance_type, insurance_number, is_new_patient, notes,
          consent_at, marketing_consent, created_at, created_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        newId, practiceId,
        op.first_name, op.last_name, op.birth_date || null,
        op.email || null, op.phone || null,
        op.insurance_type || 'gkv', op.insurance_number || null,
        op.is_new_patient ? 1 : 0,
        op.notes || null,
        op.consent_at || null,
        (op.marketing_consent != null) ? (op.marketing_consent ? 1 : 0) : 0,
        op.created_at || null,
        null,
      ]);
      patientMap[op.id] = newId;
      patientsCreated++;
    }
  }
  console.log(`✓ Patients: ${patientsCreated} created, ${patientsSkipped} already existed`);

  // 4. Migrate appointments
  console.log('\n--- MIGRATING APPOINTMENTS ---');
  const oldAppts = (await d1(OLD_DB, `SELECT * FROM appointments ORDER BY start_datetime`)).results;
  console.log(`Found ${oldAppts.length} appointments in old DB`);

  let apptsCreated = 0, apptsSkipped = 0, apptsErrored = 0;

  for (const oa of oldAppts) {
    // Check by booking_code (globally unique)
    const existing = await d1(NEW_DB, `SELECT id FROM appointments WHERE booking_code = ?`, [oa.booking_code]);
    if (existing.results.length > 0) {
      apptsSkipped++;
      continue;
    }

    const newDoctorId = docMap[oa.doctor_id];
    const newTypeId = typeMap[oa.appointment_type_id];
    const newPatientId = patientMap[oa.patient_id];
    if (!newDoctorId || !newTypeId || !newPatientId) {
      console.error(`  ✗ [${oa.booking_code}] Mapping failed (doc=${!!newDoctorId}, type=${!!newTypeId}, pat=${!!newPatientId})`);
      apptsErrored++;
      continue;
    }

    const newId = 'apt_' + crypto.randomUUID().replace(/-/g,'').slice(0, 24);
    // magic_token may or may not exist in v1 — generate if missing
    const magicToken = oa.magic_token || [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2,'0')).join('');

    try {
      await d1(NEW_DB, `
        INSERT INTO appointments (
          id, booking_code, magic_token, practice_id, patient_id, doctor_id, appointment_type_id,
          start_datetime, end_datetime, duration_minutes,
          status, source,
          patient_note, staff_note,
          confirmed_at, reminder_sent_at,
          cancelled_at, cancelled_by, cancel_reason,
          created_at, created_from_ip
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        newId, oa.booking_code, magicToken,
        practiceId, newPatientId, newDoctorId, newTypeId,
        oa.start_datetime, oa.end_datetime, oa.duration_minutes || 30,
        oa.status || 'confirmed', oa.source || 'online',
        oa.patient_note || null,
        // v1 used doctor_note, v2 uses staff_note (semantically same: internal note)
        oa.staff_note || oa.doctor_note || null,
        // v1 confirmation_sent_at → v2 confirmed_at
        oa.confirmed_at || oa.confirmation_sent_at || null,
        oa.reminder_sent_at || null,
        oa.cancelled_at || null, oa.cancelled_by || null, oa.cancel_reason || null,
        oa.created_at || null, oa.created_from_ip || null,
      ]);
      apptsCreated++;
    } catch (e) {
      console.error(`  ✗ [${oa.booking_code}] ${e.message}`);
      apptsErrored++;
    }
  }
  console.log(`✓ Appointments: ${apptsCreated} created, ${apptsSkipped} already existed, ${apptsErrored} errors`);

  // 5. Update patient last_visit_at from latest appointment
  console.log('\n--- UPDATING PATIENT last_visit_at ---');
  await d1(NEW_DB, `
    UPDATE patients
    SET last_visit_at = (
      SELECT MAX(start_datetime) FROM appointments
      WHERE patient_id = patients.id AND status IN ('confirmed','completed')
    )
    WHERE practice_id = ?
  `, [practiceId]);
  console.log('✓ Done');

  // 6. Verify
  console.log('\n--- VERIFICATION ---');
  const verify = await d1(NEW_DB, `
    SELECT
      (SELECT COUNT(*) FROM patients WHERE practice_id = ?) as patients,
      (SELECT COUNT(*) FROM appointments WHERE practice_id = ?) as appointments,
      (SELECT COUNT(*) FROM appointments WHERE practice_id = ? AND status = 'confirmed') as confirmed,
      (SELECT COUNT(*) FROM appointments WHERE practice_id = ? AND status = 'cancelled') as cancelled
  `, [practiceId, practiceId, practiceId, practiceId]);
  const v = verify.results[0];
  console.log(`  Patients in new DB:      ${v.patients}`);
  console.log(`  Appointments in new DB:  ${v.appointments}`);
  console.log(`  Confirmed:               ${v.confirmed}`);
  console.log(`  Cancelled:               ${v.cancelled}`);

  console.log('\n🎉 MIGRATION COMPLETE');
}

main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
