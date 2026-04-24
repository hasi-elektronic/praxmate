// ============================================================
// Trial expiry reminders
// ============================================================
// Runs on the hourly cron alongside appointment reminders.
// Sends an email on these days-before-trial-ends thresholds: 7, 3, 1, 0.
//   * 7 days  → "Your trial ends in a week"
//   * 3 days  → "3 days left — pick a plan"
//   * 1 day   → "Trial ends tomorrow"
//   * 0 days  → "Trial ended — subscribe to keep your data active"
//
// Idempotency: practices.trial_reminder_sent_at stores the last threshold
// (as an integer: 7, 3, 1, 0) that we've already emailed. A row is only
// re-emailed when a new, lower threshold becomes current.
// ============================================================

import { sendEmail, tenantLocale } from '../lib/email.js';

const TEMPLATES = {
  de: {
    7: {
      subject: 'Ihre Praxmate-Testphase endet in 7 Tagen',
      body: (p, days) => `
        <p>Hallo ${escapeHtml(p.owner_name)},</p>
        <p>Ihre kostenlose Praxmate-Testphase für <strong>${escapeHtml(p.practice_name)}</strong> endet in <strong>${days} Tagen</strong>.</p>
        <p>Wählen Sie jetzt einen Plan, damit Patienten weiterhin Termine buchen können:<br>
        <a href="${billingUrl(p)}">Plan auswählen →</a></p>
        <p>Keine Kündigung nötig: Wenn Sie nichts tun, endet der Testzugang automatisch. Ihre Daten bleiben 30 Tage erhalten.</p>
        <p>Fragen? Antworten Sie auf diese Mail.</p>
        <p>Hamdi · Praxmate</p>`,
    },
    3: {
      subject: '3 Tage bis zum Ende Ihrer Praxmate-Testphase',
      body: (p, days) => `
        <p>Hallo ${escapeHtml(p.owner_name)},</p>
        <p>Nur noch <strong>${days} Tage</strong> für Ihre Testphase von <strong>${escapeHtml(p.practice_name)}</strong>.</p>
        <p>Die meisten Kunden behalten Praxmate, weil Patienten online buchen — oft abends zwischen 20:00 und 23:00 Uhr, wenn die Praxis zu ist.</p>
        <p><a href="${billingUrl(p)}">Plan sichern →</a></p>
        <p>Hamdi · Praxmate</p>`,
    },
    1: {
      subject: 'Morgen endet Ihre Praxmate-Testphase',
      body: (p, days) => `
        <p>Hallo ${escapeHtml(p.owner_name)},</p>
        <p>Ihre Praxmate-Testphase für <strong>${escapeHtml(p.practice_name)}</strong> endet <strong>morgen</strong>.</p>
        <p>Wenn Sie weiternutzen möchten, wählen Sie bitte einen Plan:<br>
        <a href="${billingUrl(p)}">Plan auswählen →</a></p>
        <p>Falls Sie Praxmate nicht weiterführen, müssen Sie nichts tun — der Zugang wird morgen automatisch gesperrt.</p>
        <p>Hamdi · Praxmate</p>`,
    },
    0: {
      subject: 'Ihre Praxmate-Testphase ist beendet',
      body: (p, days) => `
        <p>Hallo ${escapeHtml(p.owner_name)},</p>
        <p>Ihre kostenlose Testphase für <strong>${escapeHtml(p.practice_name)}</strong> ist beendet.</p>
        <p><strong>Was passiert jetzt?</strong><br>
        Ihre Daten bleiben noch 30 Tage erhalten. Online-Buchung durch Patienten ist vorübergehend pausiert.</p>
        <p><a href="${billingUrl(p)}">Jetzt einen Plan wählen →</a> und alles läuft sofort weiter.</p>
        <p>Wenn Sie Ihre Daten exportieren oder das Konto löschen möchten, antworten Sie einfach auf diese Mail.</p>
        <p>Hamdi · Praxmate</p>`,
    },
  },
  en: {
    7: {
      subject: 'Your Praxmate trial ends in 7 days',
      body: (p, days) => `
        <p>Hi ${escapeHtml(p.owner_name)},</p>
        <p>Your free Praxmate trial for <strong>${escapeHtml(p.practice_name)}</strong> ends in <strong>${days} days</strong>.</p>
        <p>Pick a plan now so patients can keep booking online:<br>
        <a href="${billingUrl(p)}">Choose plan →</a></p>
        <p>No action required if you don't want to continue: the trial ends automatically. Your data is kept for 30 days.</p>
        <p>Questions? Just reply to this email.</p>
        <p>Hamdi · Praxmate</p>`,
    },
    3: {
      subject: '3 days left on your Praxmate trial',
      body: (p, days) => `
        <p>Hi ${escapeHtml(p.owner_name)},</p>
        <p>Just <strong>${days} days</strong> left on your trial for <strong>${escapeHtml(p.practice_name)}</strong>.</p>
        <p>Most customers keep Praxmate because patients book online — often between 8pm and 11pm, when the practice is closed.</p>
        <p><a href="${billingUrl(p)}">Pick your plan →</a></p>
        <p>Hamdi · Praxmate</p>`,
    },
    1: {
      subject: 'Your Praxmate trial ends tomorrow',
      body: (p, days) => `
        <p>Hi ${escapeHtml(p.owner_name)},</p>
        <p>Your trial for <strong>${escapeHtml(p.practice_name)}</strong> ends <strong>tomorrow</strong>.</p>
        <p>To keep using Praxmate, pick a plan:<br>
        <a href="${billingUrl(p)}">Choose plan →</a></p>
        <p>If you don't want to continue, just ignore this — access closes automatically tomorrow.</p>
        <p>Hamdi · Praxmate</p>`,
    },
    0: {
      subject: 'Your Praxmate trial has ended',
      body: (p, days) => `
        <p>Hi ${escapeHtml(p.owner_name)},</p>
        <p>Your free trial for <strong>${escapeHtml(p.practice_name)}</strong> has ended.</p>
        <p><strong>What happens next?</strong><br>
        Your data is kept for 30 days. Patient online booking is paused.</p>
        <p><a href="${billingUrl(p)}">Pick a plan →</a> to resume everything instantly.</p>
        <p>To export data or delete the account, just reply to this email.</p>
        <p>Hamdi · Praxmate</p>`,
    },
  },
  tr: {
    7: {
      subject: 'Praxmate deneme süreniz 7 gün içinde bitiyor',
      body: (p, days) => `
        <p>Merhaba ${escapeHtml(p.owner_name)},</p>
        <p><strong>${escapeHtml(p.practice_name)}</strong> kliniğinizin ücretsiz Praxmate deneme süresi <strong>${days} gün</strong> sonra bitiyor.</p>
        <p>Hastalarınız online randevu almaya devam etsin diye şimdi bir plan seçin:<br>
        <a href="${billingUrl(p)}">Plan seç →</a></p>
        <p>Devam etmek istemiyorsanız bir şey yapmanıza gerek yok; deneme otomatik olarak biter, verileriniz 30 gün saklanır.</p>
        <p>Sorularınız için bu maile cevap verebilirsiniz.</p>
        <p>Hamdi · Praxmate</p>`,
    },
    3: {
      subject: 'Praxmate deneme sürenizin bitmesine 3 gün kaldı',
      body: (p, days) => `
        <p>Merhaba ${escapeHtml(p.owner_name)},</p>
        <p><strong>${escapeHtml(p.practice_name)}</strong> için deneme sürenizin bitmesine sadece <strong>${days} gün</strong> kaldı.</p>
        <p>Müşterilerimizin çoğu Praxmate'i tutar, çünkü hastalar klinik kapalıyken de — genelde 20:00–23:00 arası — online randevu alır.</p>
        <p><a href="${billingUrl(p)}">Planı seç →</a></p>
        <p>Hamdi · Praxmate</p>`,
    },
    1: {
      subject: 'Praxmate deneme süreniz yarın bitiyor',
      body: (p, days) => `
        <p>Merhaba ${escapeHtml(p.owner_name)},</p>
        <p><strong>${escapeHtml(p.practice_name)}</strong> için deneme süreniz <strong>yarın</strong> bitiyor.</p>
        <p>Kullanmaya devam etmek için bir plan seçin:<br>
        <a href="${billingUrl(p)}">Plan seç →</a></p>
        <p>Devam etmeyecekseniz hiçbir şey yapmanıza gerek yok; erişim yarın otomatik kapanır.</p>
        <p>Hamdi · Praxmate</p>`,
    },
    0: {
      subject: 'Praxmate deneme süreniz sona erdi',
      body: (p, days) => `
        <p>Merhaba ${escapeHtml(p.owner_name)},</p>
        <p><strong>${escapeHtml(p.practice_name)}</strong> için ücretsiz deneme süreniz bitti.</p>
        <p><strong>Şimdi ne olacak?</strong><br>
        Verileriniz 30 gün saklanır. Hastaların online randevu alması geçici olarak durduruldu.</p>
        <p><a href="${billingUrl(p)}">Plan seçin →</a> ve her şey anında devam etsin.</p>
        <p>Verilerinizi dışa aktarmak veya hesabı silmek için bu maile cevap verin.</p>
        <p>Hamdi · Praxmate</p>`,
    },
  },
};

const THRESHOLDS = [7, 3, 1, 0]; // descending

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function billingUrl(p) {
  // Path-based URL (works with current DNS)
  return `https://praxmate.de/praxis/billing.html?practice=${encodeURIComponent(p.slug)}`;
}

function renderEmail(locale, threshold, practice) {
  const loc = TEMPLATES[locale] ? locale : 'de';
  const tmpl = TEMPLATES[loc][threshold];
  if (!tmpl) return null;
  const html = `<!DOCTYPE html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;line-height:1.6;max-width:560px;margin:0 auto;padding:20px;">
    <div style="background:linear-gradient(135deg,#0ea5e9,#14b8a6);color:white;padding:20px;border-radius:12px 12px 0 0;">
      <h1 style="margin:0;font-size:20px;">Praxmate</h1>
    </div>
    <div style="background:white;padding:24px;border-radius:0 0 12px 12px;border:1px solid #e2e8f0;border-top:none;">
      ${tmpl.body(practice, threshold)}
    </div>
  </body></html>`;
  return { subject: tmpl.subject, html };
}

/**
 * Called from the hourly cron handler.
 * Finds tenants whose trial crosses a new threshold and hasn't been notified for it yet.
 */
export async function runTrialReminders(env) {
  const started = Date.now();

  // Only trial-status practices with a future-ish trial end and a contactable owner.
  // We compute days-left in SQL to keep the query selective.
  const rows = await env.DB.prepare(`
    SELECT
      pr.id             AS practice_id,
      pr.slug,
      pr.name           AS practice_name,
      pr.locale,
      pr.trial_ends_at,
      pr.trial_reminder_sent_at,
      u.email           AS owner_email,
      u.name            AS owner_name,
      CAST(julianday(pr.trial_ends_at) - julianday('now') AS INTEGER) AS days_left
    FROM practices pr
    JOIN users u ON u.practice_id = pr.id AND u.role = 'owner' AND u.status = 'active'
    WHERE pr.plan_status = 'trial'
      AND pr.trial_ends_at IS NOT NULL
      AND pr.trial_ends_at >= date('now', '-1 day')
      AND pr.trial_ends_at <= date('now', '+8 day')
  `).all();

  const sent = [];
  const skipped = [];

  for (const r of (rows.results || [])) {
    const daysLeft = Math.max(0, r.days_left ?? 0);

    // Find the highest threshold <= daysLeft that hasn't been sent yet.
    const lastSent = r.trial_reminder_sent_at ?? 99;
    const nextThreshold = THRESHOLDS.find(t => daysLeft <= t && t < lastSent);
    if (nextThreshold === undefined) {
      skipped.push({ slug: r.slug, reason: 'already_sent_this_threshold', days_left: daysLeft, last_sent: lastSent });
      continue;
    }

    const locale = tenantLocale({ locale: r.locale });
    const rendered = renderEmail(locale, nextThreshold, {
      slug: r.slug,
      practice_name: r.practice_name,
      owner_name: r.owner_name,
    });
    if (!rendered) {
      skipped.push({ slug: r.slug, reason: 'no_template', threshold: nextThreshold });
      continue;
    }

    try {
      await sendEmail(env, {
        to: r.owner_email,
        subject: rendered.subject,
        html: rendered.html,
      });
      await env.DB.prepare(
        `UPDATE practices SET trial_reminder_sent_at = ? WHERE id = ?`
      ).bind(nextThreshold, r.practice_id).run();
      sent.push({ slug: r.slug, threshold: nextThreshold, locale, email: r.owner_email });
    } catch (e) {
      console.error('[trial-reminder] send failed', r.slug, e?.message);
      skipped.push({ slug: r.slug, reason: 'send_failed', error: e?.message });
    }
  }

  const result = {
    sent: sent.length,
    skipped: skipped.length,
    sent_detail: sent,
    skipped_detail: skipped,
    duration_ms: Date.now() - started,
  };
  console.log('[trial-reminders]', JSON.stringify(result));
  return result;
}
