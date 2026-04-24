// ============================================================
// 24-hour reminder job
// ============================================================
// Called by Cron Trigger (hourly) from index.js::scheduled().
// Scans appointments starting 23–25 hours from now (wide window to
// catch late schedulers), status='confirmed', reminder_sent_at IS NULL.
// Sends reminder email per tenant locale, stamps reminder_sent_at.
// Idempotent: the stamp prevents double-sends.
// ============================================================

import { sendEmail, isDemoTenant, tenantLocale } from '../lib/email.js';
import { reminderEmail } from '../lib/email-templates.js';
import { logAudit } from '../lib/audit.js';

export async function runReminders(env) {
  const started = Date.now();

  // Find appointments whose start is 23–25 hours from now
  // and we haven't sent a reminder for yet.
  const due = await env.DB.prepare(`
    SELECT a.id AS appt_id, a.booking_code, a.magic_token, a.start_datetime, a.duration_minutes,
           p.id AS patient_id, p.first_name, p.last_name, p.email AS patient_email,
           d.name AS doctor_name,
           t.name AS type_name, t.icon AS type_icon,
           pr.id AS practice_id, pr.slug, pr.name AS practice_name, pr.locale,
           pr.street, pr.postal_code, pr.city, pr.phone, pr.email AS practice_email
      FROM appointments a
      JOIN patients        p  ON p.id  = a.patient_id
      JOIN doctors         d  ON d.id  = a.doctor_id
      JOIN appointment_types t ON t.id = a.appointment_type_id
      JOIN practices       pr ON pr.id = a.practice_id
     WHERE a.status = 'confirmed'
       AND a.reminder_sent_at IS NULL
       AND a.start_datetime > datetime('now', '+23 hours')
       AND a.start_datetime < datetime('now', '+25 hours')
     LIMIT 200
  `).all();

  const rows = due.results || [];
  const results = { found: rows.length, sent: 0, skipped_demo: 0, skipped_no_email: 0, errors: 0 };

  for (const r of rows) {
    try {
      if (isDemoTenant(r.slug))     { results.skipped_demo++; continue; }
      if (!r.patient_email)         { results.skipped_no_email++; continue; }

      const locale = tenantLocale({ locale: r.locale });
      const mail = reminderEmail({
        practice: {
          name: r.practice_name, slug: r.slug,
          street: r.street, postal_code: r.postal_code, city: r.city,
          phone: r.phone, email: r.practice_email,
        },
        patient: { first_name: r.first_name, last_name: r.last_name, email: r.patient_email },
        appointment: {
          start_datetime: r.start_datetime,
          duration_minutes: r.duration_minutes,
          booking_code: r.booking_code,
          magic_token: r.magic_token,
        },
        doctor: { name: r.doctor_name },
        type: { name: r.type_name, icon: r.type_icon || '' },
      }, locale);

      const sendResult = await sendEmail(env, {
        to: r.patient_email,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        replyTo: r.practice_email || undefined,
        tags: [{ name: 'kind', value: 'reminder_24h' }, { name: 'tenant', value: r.slug }],
      });

      if (sendResult.ok) {
        await env.DB.prepare(`
          UPDATE appointments SET reminder_sent_at = datetime('now')
          WHERE id = ? AND practice_id = ?
        `).bind(r.appt_id, r.practice_id).run();

        await logAudit(env, {
          practice_id: r.practice_id, actor_type: 'system',
          action: 'email.reminder_sent', target_type: 'appointment', target_id: r.appt_id,
          meta: { resend_id: sendResult.id, to: r.patient_email },
        });
        results.sent++;
      } else {
        results.errors++;
      }
    } catch (e) {
      console.error('[reminders] row failed:', e.message);
      results.errors++;
    }
  }

  results.duration_ms = Date.now() - started;
  console.log('[reminders]', JSON.stringify(results));
  return results;
}
