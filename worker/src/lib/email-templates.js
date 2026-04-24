// ============================================================
// Email templates — DE / EN / TR
// ============================================================
// Minimal inlined HTML + plain-text fallback.
// Designed to render cleanly in Gmail, Outlook, Apple Mail.
// No external images/fonts — everything inline.
//
// Placeholder vars passed to each fn:
//   { practice, patient, appointment, doctor, type }
//
//   practice      = { name, phone, street, postal_code, city, brand_primary, email, website }
//   patient       = { first_name, last_name, email }
//   appointment   = { start_datetime, duration_minutes, booking_code, magic_token }
//   doctor        = { name }
//   type          = { name, icon }
// ============================================================

const BRAND_BLUE = '#0ea5e9';
const BRAND_TEAL = '#14b8a6';

function fmtDate(iso, locale) {
  const d = new Date(iso);
  const DAYS = {
    de: ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'],
    en: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
    tr: ['Pazar','Pazartesi','Salı','Çarşamba','Perşembe','Cuma','Cumartesi'],
  }[locale] || ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const MONTHS = {
    de: ['Januar','Februar','März','April','Mai','Juni','Juli','August','September','Oktober','November','Dezember'],
    en: ['January','February','March','April','May','June','July','August','September','October','November','December'],
    tr: ['Ocak','Şubat','Mart','Nisan','Mayıs','Haziran','Temmuz','Ağustos','Eylül','Ekim','Kasım','Aralık'],
  }[locale] || ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const day = DAYS[d.getDay()];
  const dd = d.getDate();
  const mon = MONTHS[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return {
    day, // "Dienstag" / "Tuesday" / "Salı"
    dateShort: locale === 'en' ? `${mon} ${dd}, ${yyyy}` : `${dd}. ${mon} ${yyyy}`,
    time: `${hh}:${mm}`,
    full: locale === 'en' ? `${day}, ${mon} ${dd}, ${yyyy} · ${hh}:${mm}`
                          : `${day}, ${dd}. ${mon} ${yyyy} · ${hh}:${mm}${locale === 'de' ? ' Uhr' : ''}`,
  };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

/**
 * Shared wrapper — same shell, different inner content per language/kind.
 */
function wrapHtml({ title, preheader, body, cta, practice, footerNote }) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
  <div style="display:none;max-height:0;overflow:hidden;color:transparent;">${escapeHtml(preheader || '')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6f8;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(10,14,26,0.06);">
        <tr><td style="background:linear-gradient(135deg,${BRAND_BLUE},${BRAND_TEAL});padding:28px 32px;color:#fff;">
          <div style="font-family:Georgia,serif;font-size:28px;font-weight:700;letter-spacing:-0.01em;">Praxmate</div>
          <div style="font-size:13px;opacity:0.9;margin-top:2px;">${escapeHtml(practice.name)}</div>
        </td></tr>
        <tr><td style="padding:32px;">
          ${body}
          ${cta ? `<div style="margin-top:28px;text-align:center;"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:13px 28px;background:${BRAND_BLUE};color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:15px;">${escapeHtml(cta.label)}</a></div>` : ''}
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #eef2f7;font-size:12px;color:#64748b;line-height:1.5;">
          ${footerNote ? `<div style="margin-bottom:8px;">${footerNote}</div>` : ''}
          <strong style="color:#334155;">${escapeHtml(practice.name)}</strong><br>
          ${practice.street ? escapeHtml(practice.street) + '<br>' : ''}
          ${practice.postal_code ? escapeHtml(practice.postal_code) + ' ' : ''}${practice.city ? escapeHtml(practice.city) : ''}<br>
          ${practice.phone ? '📞 ' + escapeHtml(practice.phone) : ''}
        </td></tr>
      </table>
      <div style="max-width:560px;margin-top:16px;text-align:center;font-size:11px;color:#94a3b8;">
        Powered by <a href="https://praxmate.de" style="color:#94a3b8;text-decoration:underline;">Praxmate</a>
      </div>
    </td></tr>
  </table>
</body>
</html>`;
}

// ============================================================
// Templates
// ============================================================

export function confirmationEmail({ practice, patient, appointment, doctor, type }, locale = 'de') {
  const t = fmtDate(appointment.start_datetime, locale);
  const fullName = `${patient.first_name} ${patient.last_name}`;
  const cancelUrl = `https://praxmate.de/termin/${appointment.magic_token}`;

  const strings = {
    de: {
      subject: `Ihr Termin bei ${practice.name} ist bestätigt`,
      preheader: `${t.full} — Buchungs-Nr. ${appointment.booking_code}`,
      greet: `Hallo ${fullName},`,
      body: `Ihr Termin ist <strong>bestätigt</strong>. Hier sind die Details:`,
      labels: { when: 'Wann', doctor: 'Bei', treatment: 'Behandlung', duration: 'Dauer', booking: 'Buchungs-Nr.' },
      minutesUnit: 'Min',
      remind: 'Wir schicken Ihnen 24 Stunden vor dem Termin eine Erinnerung.',
      cancelCta: 'Termin verwalten oder absagen',
      footer: 'Wenn Sie nicht kommen können, sagen Sie bitte mindestens 24 Stunden vorher ab — so kann jemand anderes den Termin bekommen.',
    },
    en: {
      subject: `Your appointment at ${practice.name} is confirmed`,
      preheader: `${t.full} — Booking #${appointment.booking_code}`,
      greet: `Hi ${fullName},`,
      body: `Your appointment is <strong>confirmed</strong>. Here are the details:`,
      labels: { when: 'When', doctor: 'With', treatment: 'Treatment', duration: 'Duration', booking: 'Booking #' },
      minutesUnit: 'min',
      remind: "We'll send you a reminder 24 hours before the appointment.",
      cancelCta: 'Manage or cancel appointment',
      footer: "If you can't make it, please cancel at least 24 hours in advance so someone else can take the slot.",
    },
    tr: {
      subject: `${practice.name} randevunuz onaylandı`,
      preheader: `${t.full} — Randevu No ${appointment.booking_code}`,
      greet: `Merhaba ${fullName},`,
      body: `Randevunuz <strong>onaylandı</strong>. Detaylar:`,
      labels: { when: 'Zaman', doctor: 'Hekim', treatment: 'Tedavi', duration: 'Süre', booking: 'Randevu No' },
      minutesUnit: 'dk',
      remind: 'Randevudan 24 saat önce size hatırlatma göndereceğiz.',
      cancelCta: 'Randevuyu yönet veya iptal et',
      footer: 'Gelemeyecekseniz lütfen en az 24 saat önceden iptal edin — başka biri randevuyu kullanabilir.',
    },
  }[locale] || strings.de;
  const s = strings;

  const detailsHtml = `
    <p style="margin:0 0 8px;font-size:16px;color:#0f172a;">${escapeHtml(s.greet)}</p>
    <p style="margin:0 0 20px;font-size:15px;color:#334155;line-height:1.5;">${s.body}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border-radius:12px;padding:20px;margin-bottom:20px;">
      <tr><td style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:0.06em;text-transform:uppercase;padding-bottom:4px;">${escapeHtml(s.labels.when)}</td></tr>
      <tr><td style="font-size:18px;font-weight:700;color:#0f172a;padding-bottom:16px;">${escapeHtml(t.full)}</td></tr>
      <tr><td style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:0.06em;text-transform:uppercase;padding-bottom:4px;">${escapeHtml(s.labels.doctor)}</td></tr>
      <tr><td style="font-size:15px;color:#0f172a;padding-bottom:16px;">${escapeHtml(doctor.name)}</td></tr>
      <tr><td style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:0.06em;text-transform:uppercase;padding-bottom:4px;">${escapeHtml(s.labels.treatment)}</td></tr>
      <tr><td style="font-size:15px;color:#0f172a;padding-bottom:16px;">${type.icon || ''} ${escapeHtml(type.name)} · ${appointment.duration_minutes} ${escapeHtml(s.labels.duration === 'Dauer' ? s.minutesUnit : s.minutesUnit)}</td></tr>
      <tr><td style="font-size:12px;font-weight:700;color:#64748b;letter-spacing:0.06em;text-transform:uppercase;padding-bottom:4px;">${escapeHtml(s.labels.booking)}</td></tr>
      <tr><td style="font-size:14px;color:#0f172a;font-family:Menlo,Consolas,monospace;">${escapeHtml(appointment.booking_code)}</td></tr>
    </table>
    <p style="margin:0;font-size:14px;color:#64748b;line-height:1.5;">${escapeHtml(s.remind)}</p>
  `;

  return {
    subject: s.subject,
    html: wrapHtml({ title: s.subject, preheader: s.preheader, body: detailsHtml, cta: { url: cancelUrl, label: s.cancelCta }, practice, footerNote: s.footer }),
    text: `${s.greet}\n\n${s.body.replace(/<[^>]+>/g,'')}\n\n${s.labels.when}: ${t.full}\n${s.labels.doctor}: ${doctor.name}\n${s.labels.treatment}: ${type.name} (${appointment.duration_minutes} ${s.minutesUnit})\n${s.labels.booking}: ${appointment.booking_code}\n\n${s.remind}\n${s.cancelCta}: ${cancelUrl}\n\n--\n${practice.name}\n${practice.street || ''}\n${practice.postal_code || ''} ${practice.city || ''}\n${practice.phone || ''}`,
  };
}

export function reminderEmail({ practice, patient, appointment, doctor, type }, locale = 'de') {
  const t = fmtDate(appointment.start_datetime, locale);
  const fullName = `${patient.first_name} ${patient.last_name}`;
  const cancelUrl = `https://praxmate.de/termin/${appointment.magic_token}`;

  const strings = {
    de: {
      subject: `Erinnerung: Morgen um ${t.time} Uhr bei ${practice.name}`,
      preheader: `Ihr ${type.name}-Termin ist morgen.`,
      greet: `Hallo ${fullName},`,
      body: `kurze Erinnerung — Ihr Termin ist <strong>morgen</strong>:`,
      cancelCta: 'Ich kann nicht kommen — Termin absagen',
      footer: 'Falls Sie nicht kommen können, sagen Sie bitte jetzt ab, damit wir den Platz weitergeben können.',
    },
    en: {
      subject: `Reminder: Tomorrow at ${t.time} at ${practice.name}`,
      preheader: `Your ${type.name} appointment is tomorrow.`,
      greet: `Hi ${fullName},`,
      body: `just a friendly reminder — your appointment is <strong>tomorrow</strong>:`,
      cancelCta: `I can't make it — cancel appointment`,
      footer: "If you can't make it, please cancel now so we can give the slot to someone else.",
    },
    tr: {
      subject: `Hatırlatma: Yarın ${t.time}'de ${practice.name}`,
      preheader: `${type.name} randevunuz yarın.`,
      greet: `Merhaba ${fullName},`,
      body: `küçük bir hatırlatma — randevunuz <strong>yarın</strong>:`,
      cancelCta: 'Gelemem — randevuyu iptal et',
      footer: 'Gelemeyecekseniz lütfen şimdi iptal edin, böylece randevuyu başka birine verebiliriz.',
    },
  }[locale] || strings.de;
  const s = strings;

  const bodyHtml = `
    <p style="margin:0 0 8px;font-size:16px;color:#0f172a;">${escapeHtml(s.greet)}</p>
    <p style="margin:0 0 20px;font-size:15px;color:#334155;line-height:1.5;">${s.body}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:linear-gradient(135deg,rgba(14,165,233,0.08),rgba(20,184,166,0.08));border:1px solid rgba(14,165,233,0.2);border-radius:14px;padding:22px;margin-bottom:20px;">
      <tr><td style="text-align:center;">
        <div style="font-size:36px;font-weight:800;color:#0369a1;font-family:Georgia,serif;letter-spacing:-0.02em;line-height:1;">${escapeHtml(t.time)}</div>
        <div style="font-size:15px;color:#0f172a;margin-top:6px;">${escapeHtml(t.day)}, ${escapeHtml(t.dateShort)}</div>
        <div style="font-size:13px;color:#64748b;margin-top:10px;">${type.icon || ''} ${escapeHtml(type.name)} · ${escapeHtml(doctor.name)}</div>
      </td></tr>
    </table>
  `;

  return {
    subject: s.subject,
    html: wrapHtml({ title: s.subject, preheader: s.preheader, body: bodyHtml, cta: { url: cancelUrl, label: s.cancelCta }, practice, footerNote: s.footer }),
    text: `${s.greet}\n\n${s.body.replace(/<[^>]+>/g,'')}\n\n${t.full}\n${type.name} — ${doctor.name}\n\n${s.cancelCta}: ${cancelUrl}`,
  };
}
