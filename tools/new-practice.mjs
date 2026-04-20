#!/usr/bin/env node
// ============================================================
// PRAXMATE — Onboarding Tool
// ============================================================
// Adds a new practice to the central database.
// Usage: node tools/new-practice.mjs [config.json]
//
// The config file describes the practice, its doctors, types,
// working hours, and initial admin users.
// ============================================================

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Config
const CF_TOKEN = process.env.CF_TOKEN;
if (!CF_TOKEN) { console.error('CF_TOKEN environment variable is required'); process.exit(1); }
const CF_ACCOUNT = 'ac6ab4ce1149a3591d014841856490af';
const DB_ID = 'd9548a59-aead-4d13-b082-ad82f602cfe4';

// ============================================================
// HELPERS
// ============================================================

function generateId(prefix) {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}_${hex}`;
}

async function d1(sql, binds = []) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${DB_ID}/query`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CF_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params: binds }),
    }
  );
  const data = await res.json();
  if (!data.success) {
    throw new Error(`D1 error: ${JSON.stringify(data.errors)}`);
  }
  return data.result[0];
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const buf2hex = (b) => Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2,'0')).join('');
  return { hash: buf2hex(hashBuffer), salt: buf2hex(salt) };
}

// ============================================================
// MAIN
// ============================================================

async function onboard(config) {
  console.log(`\n=== Onboarding: ${config.practice.name} (${config.practice.slug}) ===\n`);

  // Check if slug already exists
  const existing = await d1(`SELECT id FROM practices WHERE slug = ?`, [config.practice.slug]);
  if (existing.results.length > 0) {
    throw new Error(`Slug '${config.practice.slug}' already exists!`);
  }

  // 1. Create practice
  const practiceId = config.practice.id || generateId('prc');
  const p = config.practice;
  await d1(`
    INSERT INTO practices (
      id, slug, name, specialty,
      street, postal_code, city, country, phone, email, website,
      brand_primary, brand_accent, brand_ink, logo_url,
      legal_name, tax_id, responsible_person, professional_chamber,
      timezone, locale, plan, plan_status, trial_ends_at, max_doctors
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    practiceId, p.slug, p.name, p.specialty || 'dentist',
    p.street || null, p.postal_code || null, p.city || null, p.country || 'DE',
    p.phone || null, p.email || null, p.website || null,
    p.brand_primary || '#2d6a8e', p.brand_accent || '#e9b949', p.brand_ink || '#1a2a3a',
    p.logo_url || null,
    p.legal_name || null, p.tax_id || null, p.responsible_person || null,
    p.professional_chamber || null,
    p.timezone || 'Europe/Berlin', p.locale || 'de-DE',
    p.plan || 'team', p.plan_status || 'trial',
    p.trial_ends_at || new Date(Date.now() + 90*24*60*60*1000).toISOString().slice(0,10),
    p.max_doctors || 3,
  ]);
  console.log(`✓ Practice created: ${practiceId}`);

  // 2. Subdomain
  await d1(`
    INSERT INTO practice_domains (id, practice_id, hostname, type, verified, is_primary)
    VALUES (?, ?, ?, 'subdomain', 1, 1)
  `, [generateId('dom'), practiceId, `${p.slug}.praxmate.de`]);
  console.log(`✓ Domain registered: ${p.slug}.praxmate.de`);

  // 3. Doctors
  const doctorIdMap = {}; // local_key → generated_id
  for (const [i, d] of (config.doctors || []).entries()) {
    const docId = d.id || generateId('doc');
    doctorIdMap[d.key || d.id || `doc${i}`] = docId;
    await d1(`
      INSERT INTO doctors (
        id, practice_id, name, title, role, specialty,
        avatar_initials, sort_order, is_active, accepts_new_patients
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `, [
      docId, practiceId, d.name, d.title || null, d.role || null, d.specialty || null,
      d.avatar_initials || initialsFromName(d.name), d.sort_order || i,
      d.accepts_new_patients !== false ? 1 : 0,
    ]);
    console.log(`✓ Doctor: ${d.name} → ${docId}`);
  }

  // 4. Appointment types
  const typeIdMap = {};
  for (const [i, t] of (config.appointment_types || []).entries()) {
    const typeId = t.id || generateId('apt');
    typeIdMap[t.code] = typeId;
    await d1(`
      INSERT INTO appointment_types (
        id, practice_id, code, name, description, duration_minutes,
        icon, color, online_bookable, requires_approval, new_patient_only,
        sort_order, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `, [
      typeId, practiceId, t.code, t.name, t.description || null,
      t.duration_minutes, t.icon || '🦷', t.color || null,
      t.online_bookable !== false ? 1 : 0,
      t.requires_approval ? 1 : 0,
      t.new_patient_only ? 1 : 0,
      t.sort_order || i,
    ]);
    console.log(`✓ Type: ${t.name} (${t.duration_minutes} min) → ${typeId}`);
  }

  // 5. Doctor ↔ type mappings
  // If type has `doctor_keys: ['juliane', 'wolfgang']` assign to those
  // Otherwise: assign to all doctors
  for (const t of (config.appointment_types || [])) {
    const typeId = typeIdMap[t.code];
    const targetDoctors = t.doctor_keys
      ? t.doctor_keys.map(k => doctorIdMap[k]).filter(Boolean)
      : Object.values(doctorIdMap);
    for (const docId of targetDoctors) {
      await d1(`
        INSERT INTO doctor_appointment_types (doctor_id, appointment_type_id, practice_id)
        VALUES (?, ?, ?)
      `, [docId, typeId, practiceId]);
    }
  }
  console.log(`✓ Doctor-type mappings created`);

  // 6. Working hours
  let whCount = 0;
  for (const wh of (config.working_hours || [])) {
    // wh.doctor_keys: ['juliane'] or null (all doctors)
    const docIds = wh.doctor_keys
      ? wh.doctor_keys.map(k => doctorIdMap[k]).filter(Boolean)
      : Object.values(doctorIdMap);
    for (const docId of docIds) {
      for (const shift of wh.shifts) {
        await d1(`
          INSERT INTO working_hours (id, practice_id, doctor_id, day_of_week, start_time, end_time)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [generateId('wh'), practiceId, docId, wh.day_of_week, shift.start, shift.end]);
        whCount++;
      }
    }
  }
  console.log(`✓ Working hours: ${whCount} entries`);

  // 7. Users
  for (const u of (config.users || [])) {
    const { hash, salt } = await hashPassword(u.password);
    const userId = u.id || generateId('usr');
    const docId = u.doctor_key ? doctorIdMap[u.doctor_key] : null;
    await d1(`
      INSERT INTO users (
        id, practice_id, email, name, role, doctor_id,
        avatar_initials, password_hash, password_salt,
        password_updated_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'active')
    `, [
      userId, practiceId, u.email, u.name, u.role, docId,
      u.avatar_initials || initialsFromName(u.name),
      hash, salt,
    ]);
    console.log(`✓ User: ${u.email} (${u.role}) password=${u.password}`);
  }

  console.log(`\n🎉 Onboarding complete for ${config.practice.name}`);
  console.log(`   URL:   https://${config.practice.slug}.praxmate.de`);
  console.log(`   Admin: https://${config.practice.slug}.praxmate.de/admin/`);
  console.log(`   ID:    ${practiceId}`);
}

function initialsFromName(name) {
  if (!name) return '?';
  return name.replace(/Frau |Herr |Dr\. |Dipl\.-\w+\. /g, '')
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase();
}

// ============================================================
// ENTRY
// ============================================================
const configPath = process.argv[2];
if (!configPath) {
  console.error('Usage: node new-practice.mjs <config.json>');
  process.exit(1);
}

const config = JSON.parse(readFileSync(resolve(configPath), 'utf8'));
onboard(config).catch(e => {
  console.error('\n❌ Error:', e.message);
  process.exit(1);
});
