// ============================================================
// Praxmate Admin i18n — DE / EN / TR
// ============================================================
// Exposes:
//   window.i18n.t('key')           → translated string
//   window.i18n.setLang('tr')      → switch + persist + dispatch event
//   window.i18n.getLang()          → current lang code
//   window.i18n.onChange(fn)       → subscribe to lang changes
//
// Language resolution order:
//   1. localStorage('praxmate_lang') if set  (user/demo-tile preference)
//   2. practice.locale from /api/admin/auth/me (set later by _shell.js)
//   3. navigator.language (browser)
//   4. 'de' (fallback — most pilot customers are German)
// ============================================================
(function () {
  const DICT = {
    de: {
      // ===== Login =====
      'login.header': 'Praxis-Login',
      'login.title': 'Anmelden',
      'login.subtitle_for': 'Für',
      'login.subtitle_default': 'Bitte geben Sie Ihre Zugangsdaten ein.',
      'login.email': 'E-Mail',
      'login.email_placeholder': 'name@praxis.de',
      'login.password': 'Passwort',
      'login.trust_device': 'Dieses Gerät für 7 Tage vertrauen',
      'login.submit': 'Anmelden',
      'login.submit_loading': 'Anmelden...',
      'login.security_badge': 'DSGVO-konform · Server in Frankfurt',
      'login.no_practice_title': 'Keine Praxis erkannt.',
      'login.no_practice_body': 'Bitte über Ihre Praxis-URL zugreifen oder mit',
      'login.no_practice_body2': 'in der URL.',
      'login.back_home': 'Zurück zur Startseite',
      'login.err_required': 'E-Mail und Passwort erforderlich',
      'login.err_credentials': 'E-Mail oder Passwort falsch',
      'login.err_rate_limit': 'Zu viele Versuche. Bitte später erneut.',
      'login.err_2fa_needed': '2FA erforderlich (noch nicht implementiert).',
      'login.err_generic': 'Fehler bei der Anmeldung.',

      // ===== Sidebar =====
      'sb.dashboard': 'Dashboard',
      'sb.new_appt':  'Neuer Termin',
      'sb.calendar':  'Kalender',
      'sb.patients':  'Patienten',
      'sb.settings':  'Einstellungen',
      'sb.logout':    'Abmelden',
      'sb.confirm_logout': 'Abmelden?',
      'sb.menu':      'Menü',
      'role.owner':   'Inhaber',
      'role.doctor':  'Behandler',
      'role.staff':   'Team',

      // ===== Dashboard =====
      'dash.greet_morning':   'Guten Morgen',
      'dash.greet_day':       'Guten Tag',
      'dash.greet_evening':   'Guten Abend',
      'dash.stat_today':           'Heute',
      'dash.stat_today_sub':       'Termine geplant',
      'dash.stat_week':            'Diese Woche',
      'dash.stat_week_sub':        'Termine gesamt',
      'dash.stat_noshows':         'No-Shows',
      'dash.stat_noshows_sub':     'diese Woche',
      'dash.stat_new_patients':    'Neupatienten',
      'dash.stat_new_patients_sub':'diesen Monat',
      'dash.stat_hint':            'Tippen für Details',
      'dash.panel_today':          'Heutige Termine',
      'dash.panel_week':           'Termine diese Woche',
      'dash.panel_noshows':        'No-Shows diese Woche',
      'dash.panel_new_patients':   'Neupatienten diesen Monat',
      'dash.appt_count_one':       'Termin',
      'dash.appt_count_many':      'Termine',
      'dash.empty_today':          'Heute keine Termine geplant.',
      'dash.empty_week':           'Diese Woche keine Termine.',
      'dash.empty_noshows':        '🎉 Keine No-Shows diese Woche!',
      'dash.empty_new_patients':   'Keine Neupatienten diesen Monat.',
      'dash.quick_title':          'Schnellaktionen',
      'dash.quick_new_appt':       'Termin für Anrufer erstellen',
      'dash.quick_search':         'Patient suchen',
      'dash.quick_widget':         'Online-Widget öffnen',
      'dash.quick_refresh':        'Aktualisieren',
      'dash.quick_add_appt':       '+ Termin hinzufügen',
      'dash.activity_title':       'Letzte Aktivität',
      'dash.refreshed':            'Aktualisiert',

      // ===== Appointment detail modal =====
      'appt.status':          'Status',
      'appt.treatment':       'Behandlung',
      'appt.doctor':          'Behandler',
      'appt.birth_date':      'Geburtsdatum',
      'appt.phone':           'Telefon',
      'appt.email':           'E-Mail',
      'appt.insurance':       'Versicherung',
      'appt.source':          'Quelle',
      'appt.patient_note':    'Notiz des Patienten',
      'appt.close':           'Schließen',
      'appt.cancel':          'Termin absagen',
      'appt.cancelling':      'Wird abgesagt...',
      'appt.confirm_cancel':  'Wirklich absagen?',
      'appt.cancelled':       'Termin abgesagt',
      'appt.status_confirmed':'Bestätigt',
      'appt.status_cancelled':'Abgesagt',
      'appt.status_completed':'Erledigt',
      'appt.status_noshow':   'Nicht erschienen',
      'appt.source_online':   '🌐 Online vom Patienten',
      'appt.source_staff':    '👤 Durch Team erfasst',
      'appt.source_phone':    '☎ Telefonisch',
      'appt.source_walkin':   '🚶 Walk-in',
      'appt.new_patient':     'Neupatient',
      'appt.ins_gkv':         'GKV',
      'appt.ins_privat':      'Privat',
      'appt.ins_selbst':      'Selbstzahler',

      // ===== Generic =====
      'g.loading': 'Lädt...',
      'g.error_load': 'Fehler beim Laden',
      'g.yes': 'Ja',
      'g.no':  'Nein',
      'g.save': 'Speichern',
      'g.cancel': 'Abbrechen',
      'g.search': 'Suchen',
      'g.back': 'Zurück',
      'g.new': 'Neu',
      // Page titles
      'page.dashboard':      'Dashboard',
      'page.new_appointment':'Neuer Termin',
      'page.calendar':       'Kalender',
      'page.patients':       'Patienten',
      'page.settings':       'Einstellungen',
      'page.patient':        'Patient',
      // Calendar
      'cal.view_day':        'Tag',
      'cal.view_week':       'Woche',
      'cal.view_month':      'Monat',
      'cal.today':           'Heute',
      'cal.no_events':       'Keine Termine.',
      // Patients
      'pat.search_placeholder': 'Name, E-Mail, Telefon suchen...',
      'pat.count_one':       'Patient',
      'pat.count_many':      'Patienten',
      'pat.empty':           'Keine Patienten gefunden.',
      'pat.sort_recent':     'Letzter Besuch',
      'pat.sort_name':       'Name (A–Z)',
      'pat.sort_appts':      'Meiste Termine',
      'pat.add':             '+ Patient anlegen',
      // Settings sections
      'set.section_practice':   'Praxis',
      'set.section_doctors':    'Behandler',
      'set.section_types':      'Behandlungen',
      'set.section_hours':      'Öffnungszeiten',
      'set.section_users':      'Team',
      'set.section_closures':   'Urlaub / Schließungen',
      'set.section_branding':   'Logo & Farben',
      'set.save_changes':       'Änderungen speichern',
    },

    en: {
      'login.header': 'Practice Login',
      'login.title': 'Sign in',
      'login.subtitle_for': 'For',
      'login.subtitle_default': 'Enter your credentials.',
      'login.email': 'Email',
      'login.email_placeholder': 'name@practice.com',
      'login.password': 'Password',
      'login.trust_device': 'Trust this device for 7 days',
      'login.submit': 'Sign in',
      'login.submit_loading': 'Signing in...',
      'login.security_badge': 'GDPR-compliant · EU servers',
      'login.no_practice_title': 'No practice detected.',
      'login.no_practice_body': 'Please access via your practice URL or with',
      'login.no_practice_body2': 'in the URL.',
      'login.back_home': 'Back to home',
      'login.err_required': 'Email and password required',
      'login.err_credentials': 'Email or password incorrect',
      'login.err_rate_limit': 'Too many attempts. Please try again later.',
      'login.err_2fa_needed': '2FA required (not yet implemented).',
      'login.err_generic': 'Sign-in failed.',

      'sb.dashboard': 'Dashboard',
      'sb.new_appt':  'New appointment',
      'sb.calendar':  'Calendar',
      'sb.patients':  'Patients',
      'sb.settings':  'Settings',
      'sb.logout':    'Sign out',
      'sb.confirm_logout': 'Sign out?',
      'sb.menu':      'Menu',
      'role.owner':   'Owner',
      'role.doctor':  'Practitioner',
      'role.staff':   'Team',

      'dash.greet_morning':   'Good morning',
      'dash.greet_day':       'Hello',
      'dash.greet_evening':   'Good evening',
      'dash.stat_today':           'Today',
      'dash.stat_today_sub':       'appointments scheduled',
      'dash.stat_week':            'This week',
      'dash.stat_week_sub':        'appointments total',
      'dash.stat_noshows':         'No-shows',
      'dash.stat_noshows_sub':     'this week',
      'dash.stat_new_patients':    'New patients',
      'dash.stat_new_patients_sub':'this month',
      'dash.stat_hint':            'Tap for details',
      'dash.panel_today':          'Today\u2019s appointments',
      'dash.panel_week':           'Appointments this week',
      'dash.panel_noshows':        'No-shows this week',
      'dash.panel_new_patients':   'New patients this month',
      'dash.appt_count_one':       'appointment',
      'dash.appt_count_many':      'appointments',
      'dash.empty_today':          'No appointments today.',
      'dash.empty_week':           'No appointments this week.',
      'dash.empty_noshows':        '🎉 No no-shows this week!',
      'dash.empty_new_patients':   'No new patients this month.',
      'dash.quick_title':          'Quick actions',
      'dash.quick_new_appt':       'Create appointment for caller',
      'dash.quick_search':         'Search patient',
      'dash.quick_widget':         'Open online widget',
      'dash.quick_refresh':        'Refresh',
      'dash.quick_add_appt':       '+ Add appointment',
      'dash.activity_title':       'Recent activity',
      'dash.refreshed':            'Refreshed',

      'appt.status':          'Status',
      'appt.treatment':       'Treatment',
      'appt.doctor':          'Practitioner',
      'appt.birth_date':      'Date of birth',
      'appt.phone':           'Phone',
      'appt.email':           'Email',
      'appt.insurance':       'Insurance',
      'appt.source':          'Source',
      'appt.patient_note':    'Patient note',
      'appt.close':           'Close',
      'appt.cancel':          'Cancel appointment',
      'appt.cancelling':      'Cancelling...',
      'appt.confirm_cancel':  'Cancel for real?',
      'appt.cancelled':       'Appointment cancelled',
      'appt.status_confirmed':'Confirmed',
      'appt.status_cancelled':'Cancelled',
      'appt.status_completed':'Completed',
      'appt.status_noshow':   'No-show',
      'appt.source_online':   '🌐 Online by patient',
      'appt.source_staff':    '👤 Added by team',
      'appt.source_phone':    '☎ By phone',
      'appt.source_walkin':   '🚶 Walk-in',
      'appt.new_patient':     'New patient',
      'appt.ins_gkv':         'Public',
      'appt.ins_privat':      'Private',
      'appt.ins_selbst':      'Self-pay',

      'g.loading': 'Loading...',
      'g.error_load': 'Error loading',
      'g.yes': 'Yes',
      'g.no':  'No',
      'g.save': 'Save',
      'g.cancel': 'Cancel',
      'g.search': 'Search',
      'g.back': 'Back',
      'g.new': 'New',
      'page.dashboard':      'Dashboard',
      'page.new_appointment':'New appointment',
      'page.calendar':       'Calendar',
      'page.patients':       'Patients',
      'page.settings':       'Settings',
      'page.patient':        'Patient',
      'cal.view_day':        'Day',
      'cal.view_week':       'Week',
      'cal.view_month':      'Month',
      'cal.today':           'Today',
      'cal.no_events':       'No appointments.',
      'pat.search_placeholder': 'Search name, email, phone...',
      'pat.count_one':       'patient',
      'pat.count_many':      'patients',
      'pat.empty':           'No patients found.',
      'pat.sort_recent':     'Last visit',
      'pat.sort_name':       'Name (A–Z)',
      'pat.sort_appts':      'Most appointments',
      'pat.add':             '+ Add patient',
      'set.section_practice':   'Practice',
      'set.section_doctors':    'Practitioners',
      'set.section_types':      'Treatments',
      'set.section_hours':      'Office hours',
      'set.section_users':      'Team',
      'set.section_closures':   'Time off / closures',
      'set.section_branding':   'Logo & colors',
      'set.save_changes':       'Save changes',
    },

    tr: {
      'login.header': 'Klinik Girişi',
      'login.title': 'Giriş yap',
      'login.subtitle_for': 'için',
      'login.subtitle_default': 'Giriş bilgilerinizi girin.',
      'login.email': 'E-posta',
      'login.email_placeholder': 'ad@klinik.com',
      'login.password': 'Şifre',
      'login.trust_device': 'Bu cihaza 7 gün güven',
      'login.submit': 'Giriş yap',
      'login.submit_loading': 'Giriş yapılıyor...',
      'login.security_badge': 'KVKK & GDPR uyumlu · AB sunucuları',
      'login.no_practice_title': 'Klinik tespit edilemedi.',
      'login.no_practice_body': 'Lütfen kliniğinizin URL\'si üzerinden girin veya URL\'ye',
      'login.no_practice_body2': 'ekleyin.',
      'login.back_home': 'Ana sayfaya dön',
      'login.err_required': 'E-posta ve şifre zorunlu',
      'login.err_credentials': 'E-posta veya şifre hatalı',
      'login.err_rate_limit': 'Çok fazla deneme. Biraz sonra tekrar deneyin.',
      'login.err_2fa_needed': '2FA gerekli (henüz implemente edilmedi).',
      'login.err_generic': 'Giriş başarısız.',

      'sb.dashboard': 'Panel',
      'sb.new_appt':  'Yeni Randevu',
      'sb.calendar':  'Takvim',
      'sb.patients':  'Hastalar',
      'sb.settings':  'Ayarlar',
      'sb.logout':    'Çıkış yap',
      'sb.confirm_logout': 'Çıkış yapılsın mı?',
      'sb.menu':      'Menü',
      'role.owner':   'Sahip',
      'role.doctor':  'Hekim',
      'role.staff':   'Ekip',

      'dash.greet_morning':   'Günaydın',
      'dash.greet_day':       'İyi günler',
      'dash.greet_evening':   'İyi akşamlar',
      'dash.stat_today':           'Bugün',
      'dash.stat_today_sub':       'planlanmış randevu',
      'dash.stat_week':            'Bu hafta',
      'dash.stat_week_sub':        'toplam randevu',
      'dash.stat_noshows':         'No-show',
      'dash.stat_noshows_sub':     'bu hafta',
      'dash.stat_new_patients':    'Yeni hastalar',
      'dash.stat_new_patients_sub':'bu ay',
      'dash.stat_hint':            'Detay için dokun',
      'dash.panel_today':          'Bugünün randevuları',
      'dash.panel_week':           'Bu haftanın randevuları',
      'dash.panel_noshows':        'Bu haftanın no-show\u2019ları',
      'dash.panel_new_patients':   'Bu ayın yeni hastaları',
      'dash.appt_count_one':       'randevu',
      'dash.appt_count_many':      'randevu',
      'dash.empty_today':          'Bugün randevu yok.',
      'dash.empty_week':           'Bu hafta randevu yok.',
      'dash.empty_noshows':        '🎉 Bu hafta no-show yok!',
      'dash.empty_new_patients':   'Bu ay yeni hasta yok.',
      'dash.quick_title':          'Hızlı işlemler',
      'dash.quick_new_appt':       'Arayan için randevu aç',
      'dash.quick_search':         'Hasta ara',
      'dash.quick_widget':         'Online widget\u2019i aç',
      'dash.quick_refresh':        'Yenile',
      'dash.quick_add_appt':       '+ Randevu ekle',
      'dash.activity_title':       'Son etkinlik',
      'dash.refreshed':            'Yenilendi',

      'appt.status':          'Durum',
      'appt.treatment':       'Tedavi',
      'appt.doctor':          'Hekim',
      'appt.birth_date':      'Doğum tarihi',
      'appt.phone':           'Telefon',
      'appt.email':           'E-posta',
      'appt.insurance':       'Sigorta',
      'appt.source':          'Kaynak',
      'appt.patient_note':    'Hasta notu',
      'appt.close':           'Kapat',
      'appt.cancel':          'Randevuyu iptal et',
      'appt.cancelling':      'İptal ediliyor...',
      'appt.confirm_cancel':  'Gerçekten iptal etmek istiyor musunuz?',
      'appt.cancelled':       'Randevu iptal edildi',
      'appt.status_confirmed':'Onaylandı',
      'appt.status_cancelled':'İptal edildi',
      'appt.status_completed':'Tamamlandı',
      'appt.status_noshow':   'Gelmedi',
      'appt.source_online':   '🌐 Hasta online',
      'appt.source_staff':    '👤 Ekip ekledi',
      'appt.source_phone':    '☎ Telefon',
      'appt.source_walkin':   '🚶 Walk-in',
      'appt.new_patient':     'Yeni hasta',
      'appt.ins_gkv':         'SGK',
      'appt.ins_privat':      'Özel',
      'appt.ins_selbst':      'Cepten ödeme',

      'g.loading': 'Yükleniyor...',
      'g.error_load': 'Yükleme hatası',
      'g.yes': 'Evet',
      'g.no':  'Hayır',
      'g.save': 'Kaydet',
      'g.cancel': 'Vazgeç',
      'g.search': 'Ara',
      'g.back': 'Geri',
      'g.new': 'Yeni',
      'page.dashboard':      'Panel',
      'page.new_appointment':'Yeni Randevu',
      'page.calendar':       'Takvim',
      'page.patients':       'Hastalar',
      'page.settings':       'Ayarlar',
      'page.patient':        'Hasta',
      'cal.view_day':        'Gün',
      'cal.view_week':       'Hafta',
      'cal.view_month':      'Ay',
      'cal.today':           'Bugün',
      'cal.no_events':       'Randevu yok.',
      'pat.search_placeholder': 'İsim, e-posta, telefon ara...',
      'pat.count_one':       'hasta',
      'pat.count_many':      'hasta',
      'pat.empty':           'Hasta bulunamadı.',
      'pat.sort_recent':     'Son ziyaret',
      'pat.sort_name':       'İsim (A–Z)',
      'pat.sort_appts':      'En çok randevu',
      'pat.add':             '+ Hasta ekle',
      'set.section_practice':   'Klinik',
      'set.section_doctors':    'Hekimler',
      'set.section_types':      'Tedaviler',
      'set.section_hours':      'Çalışma saatleri',
      'set.section_users':      'Ekip',
      'set.section_closures':   'İzin / Kapalı günler',
      'set.section_branding':   'Logo ve renkler',
      'set.save_changes':       'Değişiklikleri kaydet',
    },
  };

  const SUPPORTED = ['de', 'en', 'tr'];
  const listeners = new Set();

  function normalize(raw) {
    if (!raw) return 'de';
    const short = String(raw).toLowerCase().slice(0, 2);
    return SUPPORTED.includes(short) ? short : 'de';
  }

  function detect() {
    const stored = localStorage.getItem('praxmate_lang');
    if (stored && SUPPORTED.includes(stored)) return stored;
    const browser = navigator.language || navigator.userLanguage;
    return normalize(browser);
  }

  let current = detect();
  document.documentElement.lang = current;

  function t(key, fallback) {
    const table = DICT[current] || DICT.de;
    return table[key] ?? DICT.de[key] ?? (fallback ?? key);
  }

  function setLang(lang) {
    const next = normalize(lang);
    if (next === current) return;
    current = next;
    try { localStorage.setItem('praxmate_lang', next); } catch {}
    document.documentElement.lang = next;
    listeners.forEach(fn => { try { fn(next); } catch {} });
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // Expose globally for Vue templates and vanilla JS alike.
  window.i18n = {
    t, setLang, onChange,
    getLang: () => current,
    supported: () => SUPPORTED.slice(),
  };

  // ========================================================
  // DOM auto-translation for non-Vue pages:
  // Any element with `data-i18n="key"` has its textContent replaced.
  // Any element with `data-i18n-attr="attr:key"` gets that attribute set.
  // ========================================================
  function applyDomI18n(root = document) {
    root.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      if (key) el.textContent = t(key);
    });
    root.querySelectorAll('[data-i18n-attr]').forEach(el => {
      const spec = el.getAttribute('data-i18n-attr');
      // spec: "placeholder:pat.search_placeholder,title:g.search"
      (spec || '').split(',').forEach(pair => {
        const [attr, key] = pair.split(':').map(s => s && s.trim());
        if (attr && key) el.setAttribute(attr, t(key));
      });
    });
  }

  onChange(() => applyDomI18n());

  document.addEventListener('DOMContentLoaded', () => {
    document.documentElement.dataset.lang = current;
    applyDomI18n();
  });
})();
