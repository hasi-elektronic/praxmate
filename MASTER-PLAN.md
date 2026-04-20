# Praxmate Admin System — Master Plan v1.0

**Statü:** Planning phase · **Tarih:** 20.04.2026 · **Hedef:** Praksis içi kullanım + hasta self-service birleşik platform

---

## 1. VİZYON TEKRARI

Praxmate iki kullanıcı grubuna hizmet eder:

| Grup | Kim | Nerede | Ana İhtiyaç |
|---|---|---|---|
| **Hasta** | Dış dünyadan gelen | Praksis website'inde embed | "Hızlıca randevu bulmak" |
| **Praksis Ekibi** | Behandler + ZFA | `admin.praxmate.de` | "Günlük operasyon yönetmek" |

**Aynı database, iki UI, farklı güvenlik seviyeleri.**

---

## 2. ROL MATRİSİ

### Tanımlar

| Rol | Tipik kişi (Hild örneği) | Sayı |
|---|---|---|
| **Owner** | Juliane Hild (Praxisinhaberin) | 1 |
| **Doctor** | Wolfgang Hild, Angestellter Zahnarzt | 1-N |
| **Staff** | Rezeptionistin, ZMA/ZFA | 1-N |

### Yetki matrisi

| Aksiyon | Owner | Doctor | Staff |
|---|---|---|---|
| **Takvim görüntüleme** | | | |
| Kendi takvimini gör | ✅ | ✅ | — (doktor değil) |
| Başka doktorların takvimini gör | ✅ | ✅ | ✅ |
| Tüm praksisin haftalık görünümü | ✅ | ✅ | ✅ |
| **Randevu yönetimi** | | | |
| Yeni randevu oluştur (telefon için) | ✅ | ✅ | ✅ |
| Randevu değiştir | ✅ | ✅ | ✅ |
| Randevu iptal et | ✅ | ✅ | ✅ |
| Randevu sil (hard delete) | ✅ | — | — |
| **Hasta yönetimi** | | | |
| Hasta listesi görüntüle | ✅ | ✅ | ✅ |
| Hasta bilgisi düzenle | ✅ | ✅ | ✅ |
| Hasta sil (DSGVO Art. 17) | ✅ | — | — |
| Hasta tıbbi notu ekle | ✅ | ✅ | — |
| **Doktor yönetimi** | | | |
| Doktor ekle | ✅ | — | — |
| Doktor çalışma saatini değiştir | ✅ | kendi için | — |
| Doktor tatil/blok ekle | ✅ | kendi için | ✅ |
| **Randevu tipi yönetimi** | | | |
| Randevu tipi ekle/düzenle | ✅ | — | — |
| Randevu tipi etkinleştir/kapat | ✅ | — | ✅ |
| **Ekip yönetimi** | | | |
| Kullanıcı ekle | ✅ | — | — |
| Kullanıcı rolünü değiştir | ✅ | — | — |
| Kullanıcı pasifleştir | ✅ | — | — |
| **Ayarlar** | | | |
| Praksis bilgisi (logo, renk, adres) | ✅ | — | — |
| E-mail/SMS template'leri | ✅ | — | — |
| Embed kodu | ✅ | — | — |
| **Raporlar** | | | |
| Günlük/haftalık randevu raporu | ✅ | ✅ | ✅ |
| No-show istatistikleri | ✅ | ✅ | ✅ |
| Fatura ön raporu | ✅ | — | — |
| **Audit log** | | | |
| Kendi aktivitesini gör | ✅ | ✅ | ✅ |
| Herkesin aktivitesini gör | ✅ | — | — |

**Not:** Tıbbi not yazmak staff'a kapalı çünkü DSGVO Art. 9 (besondere Kategorie). ZFA yazılı hasta notunu işleyebilir ama **doktor'un medikal gözlemini** hayır.

---

## 3. AUTHENTICATION MİMARİSİ

### Flow diyagramı

```
┌─────────────────────────────────────────────────┐
│ 1. İLK KURULUM (her praksis için bir kez)       │
├─────────────────────────────────────────────────┤
│ Owner e-mail'i admin panelde yaratılır          │
│ Owner şifre belirler + e-mail doğrulama         │
│ Owner diğer kullanıcıları davet eder             │
└─────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────┐
│ 2. GÜNLÜK GİRİŞ                                  │
├─────────────────────────────────────────────────┤
│ E-mail + şifre                                   │
│ → "Dieses Gerät vertrauen? (30 Tage)"            │
│ → Cihaz cookie alır (HttpOnly, Secure, 30 gün)  │
│ → Sonraki girişlerde otomatik                    │
└─────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────┐
│ 3. 2FA (Opsiyonel, Owner zorunlu)                │
├─────────────────────────────────────────────────┤
│ TOTP (Google Authenticator, Authy)               │
│ Recovery codes (10 tanelik, print edilebilir)    │
└─────────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────────┐
│ 4. SESSION YÖNETİMİ                              │
├─────────────────────────────────────────────────┤
│ Session token: 8 saat (activity refresh)        │
│ Trusted device: 30 gün                           │
│ "Başka yerde oturum aç" → logout all             │
└─────────────────────────────────────────────────┘
```

### Güvenlik detayları

- **Şifre**: bcrypt (Cloudflare Workers'da `workers-bcrypt` yok → Web Crypto API ile PBKDF2 600k iteration SHA-256)
- **Şifre sıfırlama**: magic link, 1 saat geçerli
- **Rate limiting**: 5 başarısız giriş → 15 dakika blok (Cloudflare Workers KV)
- **Brute force**: aynı IP'den 20 deneme/saat üst sınır
- **CSRF**: SameSite=Strict cookie + double-submit token

### Şifre politikası (not: KZV/KBV önerilerine uygun)

- Min 10 karakter
- En az 1 harf + 1 rakam
- Son 5 şifre tekrar edilemez
- 90 günde bir değiştirme **zorunlu değil** (NIST 2024 rehberi — sık değiştirme güvenliği azaltır)
- Pwned password check (HIBP API, first 5 chars hash)

---

## 4. DATABASE SCHEMA GENİŞLETMELERİ

Mevcut 9 tabloya eklenecek ve değiştirilecekler:

### Yeni tablolar

```sql
-- Kullanıcılar (ekip üyeleri)
CREATE TABLE users (
  id TEXT PRIMARY KEY,              -- 'usr_juliane'
  practice_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,               -- 'owner' | 'doctor' | 'staff'
  doctor_id TEXT,                   -- NULL staff için, sadece doctor rolünde
  password_hash TEXT NOT NULL,
  password_changed_at TEXT NOT NULL,
  twofa_secret TEXT,                -- TOTP secret (encrypted)
  twofa_enabled INTEGER DEFAULT 0,
  email_verified_at TEXT,
  invited_by_user_id TEXT,
  invitation_token TEXT,
  invitation_expires_at TEXT,
  last_login_at TEXT,
  last_login_ip TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (practice_id, email),
  FOREIGN KEY (practice_id) REFERENCES practices(id),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id)
);

-- Session'lar (her aktif oturum bir satır)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- session token (random 32 byte)
  user_id TEXT NOT NULL,
  practice_id TEXT NOT NULL,
  device_id TEXT,                   -- trusted device ID (cookie)
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_active_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked INTEGER DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Trusted devices (30-day remember)
CREATE TABLE trusted_devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_fingerprint TEXT NOT NULL,  -- ip+ua hash
  device_name TEXT,                  -- "Elena's Chrome"
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Failed login attempts (rate limiting)
CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY,
  email TEXT,
  ip_address TEXT,
  success INTEGER,
  attempted_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 2FA recovery codes
CREATE TABLE recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Password reset tokens
CREATE TABLE password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Hasta tıbbi notları (ayrı tablo — DSGVO için önemli)
CREATE TABLE patient_notes (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL,
  practice_id TEXT NOT NULL,
  doctor_id TEXT NOT NULL,          -- kim yazdı (sadece doctor rolü)
  appointment_id TEXT,              -- ilgili randevu (opsiyonel)
  note_type TEXT NOT NULL,          -- 'clinical' | 'administrative' | 'followup'
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (patient_id) REFERENCES patients(id),
  FOREIGN KEY (doctor_id) REFERENCES doctors(id),
  FOREIGN KEY (appointment_id) REFERENCES appointments(id)
);
```

### Mevcut tablo güncellemeleri

```sql
-- Randevu oluşturanı takip et
ALTER TABLE appointments ADD COLUMN created_by_user_id TEXT;
ALTER TABLE appointments ADD COLUMN last_modified_by_user_id TEXT;
ALTER TABLE appointments ADD COLUMN last_modified_at TEXT;

-- Source netleştir
-- mevcut 'source' alanı: 'online' | 'staff' | 'phone' | 'walkin'

-- Audit log artık user_id de taşır (zaten actor_id var, anlamı genişler)
```

---

## 5. API ENDPOINTS (yeni admin route'ları)

Mevcut 9 endpoint'e eklenecekler. `/api/admin/*` prefix ile:

### Auth

```
POST   /api/admin/auth/login            → email+şifre, session token döner
POST   /api/admin/auth/logout           → session revoke
POST   /api/admin/auth/logout-all       → tüm cihazlardan çıkış
GET    /api/admin/auth/me               → aktif kullanıcı bilgisi
POST   /api/admin/auth/password/change  → şifre değiştir
POST   /api/admin/auth/password/forgot  → reset e-mail gönder
POST   /api/admin/auth/password/reset   → token ile şifre sıfırla
POST   /api/admin/auth/2fa/setup        → TOTP secret + QR
POST   /api/admin/auth/2fa/verify       → kod doğrula
POST   /api/admin/auth/2fa/disable      → 2FA kapat
GET    /api/admin/auth/sessions         → aktif oturumları listele
DELETE /api/admin/auth/sessions/:id     → belirli oturumu sonlandır
```

### Appointments (admin)

```
GET    /api/admin/appointments          → filtreli liste (day/week/range)
POST   /api/admin/appointments          → yeni randevu (telefon için)
GET    /api/admin/appointments/:id      → detaylı
PUT    /api/admin/appointments/:id      → değiştir
DELETE /api/admin/appointments/:id      → iptal et
POST   /api/admin/appointments/:id/reschedule → yeniden planla
GET    /api/admin/appointments/calendar → takvim grid view
```

### Patients (admin)

```
GET    /api/admin/patients              → liste + arama
POST   /api/admin/patients              → manuel hasta oluştur
GET    /api/admin/patients/:id          → detaylar + randevu geçmişi
PUT    /api/admin/patients/:id          → güncelle
DELETE /api/admin/patients/:id          → sil (DSGVO, owner-only)
GET    /api/admin/patients/:id/notes    → tıbbi notlar (doctor-only)
POST   /api/admin/patients/:id/notes    → not ekle (doctor-only)
POST   /api/admin/patients/search       → hızlı arama (telefon sırasında)
```

### Doctors (admin)

```
GET    /api/admin/doctors               → liste
POST   /api/admin/doctors               → yeni doktor (owner-only)
PUT    /api/admin/doctors/:id           → güncelle
DELETE /api/admin/doctors/:id           → pasifleştir
GET    /api/admin/doctors/:id/hours     → çalışma saatleri
PUT    /api/admin/doctors/:id/hours     → çalışma saatleri güncelle
GET    /api/admin/doctors/:id/blocks    → blok zamanlar
POST   /api/admin/doctors/:id/blocks    → blok ekle
DELETE /api/admin/doctors/:id/blocks/:bid → blok sil
```

### Appointment Types (admin)

```
GET    /api/admin/appointment-types     → liste
POST   /api/admin/appointment-types     → yeni (owner-only)
PUT    /api/admin/appointment-types/:id → güncelle (owner-only)
DELETE /api/admin/appointment-types/:id → pasifleştir
```

### Users (admin)

```
GET    /api/admin/users                 → liste (owner-only)
POST   /api/admin/users/invite          → davet gönder (owner-only)
PUT    /api/admin/users/:id             → rol değiştir (owner-only)
DELETE /api/admin/users/:id             → pasifleştir
POST   /api/admin/users/accept-invite   → davet kabul (public endpoint)
```

### Practice Settings (admin)

```
GET    /api/admin/practice              → praksis ayarları
PUT    /api/admin/practice              → güncelle (owner-only)
GET    /api/admin/practice/embed        → embed kodu
GET    /api/admin/practice/stats        → temel istatistikler
```

### Audit Log (admin)

```
GET    /api/admin/audit                 → log (owner görür hepsini, diğerleri kendi)
```

**Toplam yeni endpoint: 44**

---

## 6. UI SAYFALARI — Admin Panel

### Site haritası

```
/admin
├── /login                         (public)
├── /invite/:token                 (public, davet kabul)
├── /password-reset                (public)
│
├── /                              (dashboard — bugün özeti)
├── /calendar                      (ana takvim görünümü)
│   ├── /calendar/day              (günlük)
│   ├── /calendar/week             (haftalık)
│   └── /calendar/month            (aylık)
│
├── /appointments/new              (telefon-için-randevu ekleme)
├── /appointments/:id              (randevu detay)
│
├── /patients                      (hasta arama + liste)
├── /patients/:id                  (hasta detay + geçmiş)
├── /patients/:id/notes            (tıbbi notlar, sadece doctor)
│
├── /doctors                       (doktor yönetimi)
├── /doctors/:id/hours             (çalışma saatleri)
├── /doctors/:id/blocks            (tatil/blok)
│
├── /types                         (randevu tipleri)
│
├── /team                          (ekip + davet, owner-only)
├── /settings                      (praksis ayarları, owner-only)
│   ├── /settings/practice         (bilgi, logo, renk)
│   ├── /settings/embed            (widget kodu)
│   ├── /settings/emails           (template'ler)
│   └── /settings/billing          (fatura, gelecek)
│
├── /audit                         (audit log)
├── /profile                       (kendi profil + şifre + 2FA)
└── /help                          (yardım + kısayollar)
```

### Dashboard (ilk görünüm)

ZFA sabah bilgisayarı açtığında ne görür?

```
┌──────────────────────────────────────────────────────────┐
│ 🦷 Praxmate · Hild & Kollegen        👤 Elena Meier (ZFA) │
├──────────────────────────────────────────────────────────┤
│                                                           │
│ Guten Morgen, Elena.                                      │
│ Heute, Montag 20.04.2026                                  │
│                                                           │
│ ┌─ HEUTE ────────┬─ DIESE WOCHE ─┬─ NO-SHOWS ─┬─ NEU ──┐ │
│ │      14        │      67        │     2       │   3    │ │
│ │ Termine        │ Termine        │ diese Woche │ Patient│ │
│ └────────────────┴────────────────┴─────────────┴────────┘ │
│                                                           │
│ ┌─ HEUTIGE TERMINE ──────────────────────────────────────┐ │
│ │ 08:30 ─ Maria Weber           Kontrolle · J. Hild     │ │
│ │ 09:00 ─ Hans-Peter Schmitt    PZR · J. Hild           │ │
│ │ 09:45 ⓃⒺⓊ Julia Bergmann     Neuaufnahme · W. Hild   │ │
│ │ 10:30 ─ Tolga Özdemir         Schmerz · J. Hild       │ │
│ │ ...                                                    │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                           │
│ ┌─ SCHNELLAKTIONEN ──────────────────────────────────────┐ │
│ │ [+ Termin hinzufügen]  [🔍 Patient suchen]             │ │
│ │ [📧 Bestätigungen senden (3 ausstehend)]               │ │
│ └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Kritik UI: Telefon-için-Randevu-Ekleme (`/appointments/new`)

Bu en çok kullanılacak ekran. Hız kritik.

**İş akışı:**
1. ZFA telefonu açar
2. Hasta ismini söyler → inline arama (300ms debounce)
   - Varsa → önceki bilgileriyle gelir
   - Yoksa → "Neuer Patient" butonu
3. Hasta sorusu: "Worum geht es?" → tip seçilir (8 kart + klavye kısayolu 1-8)
4. "Wann?" → tarih picker + müsait saatler görüntülenir
5. Behandler → (tip+zaman'a göre müsait olanlar filtrelenir)
6. "Soll ich eine Bestätigung per E-Mail senden?" → checkbox
7. Enter → kaydedilir, geri dashboard'a döner

**Hız hedefleri:**
- Mevcut hastalar için: **60 saniye**
- Yeni hasta için: **90 saniye** (bilgi girişi + randevu)

**Klavye kısayolları:**
- `Ctrl+N` yeni randevu
- `Ctrl+F` hasta arama
- `Esc` iptal
- `1-8` randevu tipi seç
- `Enter` sonraki adım

### Takvim görünümü (`/calendar`)

**Günlük görünüm:**
- Saat kolonu (7:00 → 19:00, 30dk intervaller)
- Her behandler için ayrı kolon
- Randevular renkli blok (tip'in rengi)
- Drag & drop ile yeniden planla
- Sağ tık: iptal, değiştir, notlar
- Boş slot'a tık → yeni randevu yarat (pre-filled zaman)

**Haftalık görünüm:**
- 7 gün kolonu, saatler satır
- Tüm behandler'lar üst üste (overlay) veya yan yana (filter)

### Mobile PWA

Behandler telefonda hızlıca ne yapar?
- Bugünün randevuları (swipe)
- Randevu detayı → tıbbi not ekle (doctor için)
- Push notification: "Neue Buchung: Maria Weber um 10:30"

---

## 7. E-MAIL/SMS BİLDİRİM SİSTEMİ

### Ne zaman e-mail gider?

| Olay | Alıcı | Gönderen |
|---|---|---|
| Randevu oluşturuldu (online veya staff) | Hasta | noreply@praxmate.de |
| Randevu oluşturuldu | Praksis (Staff) | Opsiyonel toggle |
| 24 saat öncesi hatırlatma | Hasta | Otomatik (cron) |
| Randevu iptal edildi | Hasta | Otomatik |
| Randevu değiştirildi | Hasta | Otomatik |
| Kullanıcı davet edildi | Yeni ekip üyesi | noreply@praxmate.de |
| Şifre sıfırlama | Kullanıcı | noreply@praxmate.de |
| Yeni oturum açıldı | Kullanıcı (güvenlik) | noreply@praxmate.de |

### SMS (sonraki aşama — Twilio/Vonage)

| Olay | Alıcı |
|---|---|
| 24 saat öncesi hatırlatma | Hasta (opt-in) |
| Günlük randevu hatırlatma | Hasta |

SMS pahalı (~0.08€/SMS). Professional paket'te dahil, Starter'da değil.

---

## 8. GÜVENLİK & DSGVO

### Risk tablosu

| Risk | Etki | Mitigation |
|---|---|---|
| SQL injection | Yüksek | Prepared statements her yerde |
| XSS | Yüksek | escapeHtml() output, CSP header |
| CSRF | Orta | SameSite=Strict, double-submit token |
| Session hijack | Yüksek | HttpOnly, Secure, IP check |
| Brute force login | Orta | Rate limit 5/15min, IP block |
| Veri sızıntısı (yanlış practice_id) | Kritik | Single-tenant DB → imkansız |
| DSGVO non-compliance | Yüksek | Audit log, consent tracking, deletion API |

### DSGVO Checklist

- [ ] **Art. 5** Veri minimizasyonu → sadece gerekli alanlar topla
- [ ] **Art. 6** Yasal temel → randevu = sözleşme ifası, explicit consent
- [ ] **Art. 13** Bilgilendirme → Datenschutzerklärung her praksis için
- [ ] **Art. 15** Görüntüleme hakkı → `/api/patients/:id/data-export` endpoint
- [ ] **Art. 17** Silme hakkı → `DELETE /api/admin/patients/:id` (owner-only)
- [ ] **Art. 20** Taşıma hakkı → JSON export
- [ ] **Art. 25** Privacy by design → single-tenant DB
- [ ] **Art. 28** Auftragsverarbeiter → AV-Vertrag her müşteri ile
- [ ] **Art. 30** Verarbeitungsverzeichnis → internal document hazırla
- [ ] **Art. 32** Teknik önlemler → TLS 1.3, encryption at rest (D1 default)
- [ ] **Art. 33** Datenpanne bildirimi → 72 saat prosedürü

---

## 9. SUBSCRIPTION & BILLING (planla, ama şimdi yapma)

### Paketler

| Feature | Starter 39€ | Professional 69€ | Praxis+ 119€ |
|---|---|---|---|
| Behandler sayısı | 1 | 3 | Sınırsız |
| Randevu/ay | Sınırsız | Sınırsız | Sınırsız |
| ZFA hesapları | 1 | 3 | Sınırsız |
| Online hasta randevu | ✅ | ✅ | ✅ |
| E-mail bildirim | ✅ | ✅ | ✅ |
| SMS bildirim | — | 100/ay | Sınırsız |
| Custom domain | — | ✅ | ✅ |
| API erişimi | — | — | ✅ |
| Analytics | Basit | Orta | Detaylı |
| Support | E-mail | E-mail + Telefon | Persönlich |

### Teknik ekleme (ileride)

- Stripe entegrasyonu
- Trial tracking (3 ay pilot → otomatik bitiş)
- Payment methods: SEPA + Kreditkarte
- Rechnung otomatik generator

**Şimdi değil.** Pilot faz bitince eklenir.

---

## 10. YAPI VE KOD MİMARİSİ

### Monorepo düzeni

```
/praxmate/
├── dist/                          # deployed to Cloudflare Pages
│   ├── index.html                 # landing
│   ├── demo-patient.html          # generic patient demo
│   ├── demo-doctor.html           # static demo (pitch için)
│   ├── demo-hild.html             # mock Hild demo (pitch için)
│   ├── demo-hild-live.html        # live hasta booking ✨
│   └── admin/                     # admin PWA
│       ├── index.html             # login
│       ├── app.html               # SPA entry
│       ├── manifest.json          # PWA manifest
│       ├── service-worker.js      # offline + push
│       └── assets/
│           ├── admin.css
│           ├── admin.js           # SPA logic
│           └── icons/
│
├── worker/                        # Cloudflare Worker API
│   ├── src/
│   │   ├── index.js              # router
│   │   ├── routes/
│   │   │   ├── public.js         # hasta booking (mevcut)
│   │   │   └── admin/
│   │   │       ├── auth.js
│   │   │       ├── appointments.js
│   │   │       ├── patients.js
│   │   │       ├── doctors.js
│   │   │       ├── users.js
│   │   │       └── practice.js
│   │   ├── middleware/
│   │   │   ├── auth.js           # session check
│   │   │   ├── role.js           # permission check
│   │   │   ├── cors.js
│   │   │   └── rate-limit.js
│   │   ├── lib/
│   │   │   ├── crypto.js         # bcrypt/PBKDF2
│   │   │   ├── email.js          # Resend client
│   │   │   ├── ics.js            # calendar invite
│   │   │   └── totp.js           # 2FA
│   │   └── db.js                 # query helpers
│   └── wrangler.toml
│
├── db/
│   ├── schema.sql                 # v1 (mevcut)
│   ├── migrations/
│   │   ├── 001_initial.sql
│   │   ├── 002_add_users.sql
│   │   ├── 003_add_sessions.sql
│   │   └── ...
│   └── seeds/
│       └── hild.sql
│
├── docs/
│   ├── master-plan.md             # bu dosya
│   ├── api-reference.md
│   ├── dsgvo-compliance.md
│   └── av-vertrag-template.md
│
└── README.md
```

### Worker yazılım katmanları

```
HTTP Request
    ↓
Router (src/index.js)
    ↓
Middleware chain:
  1. CORS
  2. Rate Limit (her route için tek tek)
  3. Auth (admin route'larda)
  4. Role check (yetki matrisi)
  5. Audit log (otomatik)
    ↓
Route handler
    ↓
Service layer (business logic)
    ↓
DB layer (prepared statements)
    ↓
Response (JSON)
```

---

## 11. UYGULAMA YOL HARİTASI — Sprint Planı

### Sprint 1 (bu hafta: 20-25 Nisan) — **Hild için Minimum Viable Admin**
- [ ] Schema migration: users, sessions, trusted_devices
- [ ] Auth: login, logout, me endpoints
- [ ] Password hashing (PBKDF2)
- [ ] Admin UI: login sayfası
- [ ] Admin UI: basic dashboard (bugünün randevuları)
- [ ] Admin UI: yeni randevu ekleme (staff için, telefon)
- [ ] Hild için seed user: juliane@zahnarzthild.de (test şifre)

**Bitince:** Hild'e gösterebileceğin çalışan admin panel var. ZFA telefonla randevu alabilir.

### Sprint 2 (26 Nisan - 2 Mayıs) — **Takvim + Hasta Yönetimi**
- [ ] Calendar view (günlük, haftalık)
- [ ] Drag & drop reschedule
- [ ] Hasta arama + detay
- [ ] Hasta geçmişi
- [ ] Tıbbi not (doctor-only)

### Sprint 3 (3-9 Mayıs) — **E-mail + Bildirimler**
- [ ] Resend entegrasyonu (praxmate.de domain verify)
- [ ] Onay e-mail template (hasta)
- [ ] Hatırlatma e-mail (cron job)
- [ ] İptal e-mail
- [ ] ICS attachment

### Sprint 4 (10-16 Mayıs) — **Rol Sistemi + Ekip**
- [ ] Role check middleware
- [ ] User invitation flow
- [ ] 2FA (TOTP + QR)
- [ ] Password reset
- [ ] Trusted devices

### Sprint 5 (17-23 Mayıs) — **Polish + PWA**
- [ ] PWA manifest + service worker
- [ ] Push notifications
- [ ] Mobile responsive admin
- [ ] Keyboard shortcuts
- [ ] Settings sayfaları

### Sprint 6 (24-30 Mayıs) — **Gerçek launch**
- [ ] Custom domain (praxmate.de)
- [ ] DSGVO belgeleri (AV-Vertrag template, Datenschutz)
- [ ] Admin audit log UI
- [ ] Error tracking (Sentry or Cloudflare Worker Logs)
- [ ] Backup strategy

---

## 12. KARAR NOKTALARI (YAPI BAŞLAMADAN)

Bu planda 3 şey var ki bunlar hala tartışmalı, senin kararın:

1. **Frontend framework**: Vanilla HTML/CSS/JS (şu anki gibi) mi, yoksa Vue/React mı?
   - Admin panel complexity yüksek olacak. Vanilla JS ile mümkün ama 1000+ satırlık tek SPA oluşur.
   - **Benim önerim:** Admin için **Vue 3 + Vite** (SPA). Basit, Machbar24'tekine benzer.
   - Worker API değişmez, sadece frontend framework değişir.

2. **Auth implementation**: Cloudflare Access (enterprise) mi, kendimiz mi yazarız?
   - Cloudflare Access: 3€/kullanıcı/ay, SSO hazır ama lock-in
   - Kendi yazarsak: kontrolümüzde, ama 3-4 günlük iş
   - **Benim önerim:** Kendi yazarız. DSGVO argümanı güçlenir ("Authentication bei uns, nicht bei Drittanbieter").

3. **Hangi işlere ne kadar zaman ayırsak?**
   - Sprint 1'i hızlı bitirip Hild'i kapatmak mı?
   - Yoksa 6 sprint tamamlayıp "ready product" mı?
   - **Benim önerim:** Sprint 1 bittiği an (Cuma veya Cumartesi), Hild'e git. Gerisi o evet derse paralel devam.

---

## 13. RAKİP ANALİZİ

Her rakibin ne yaptığına bakalım ki Praxmate'i pozisyonlayalım:

| Rakip | Fiyat | Güçlü yanı | Zayıf yanı | Praxmate farkı |
|---|---|---|---|---|
| **Doctolib Pro** | 129€+ | Büyük hasta ağı | FR firma, pahalı | Regional, ucuz, kendi marka |
| **Samedi** | 89€+ | Uzun yıllardır pazarda | Karmaşık, yaşlı UI | Modern, basit |
| **timify** | 49€+ | Multi-industry | Tıp için özelleşmedi | Tıp odaklı |
| **TomMed** | 79€+ | Almanya odaklı | Limited features | Hem randevu hem ekip mgmt |
| **Jameda** | 100€+ | Sadece doktor dizini | Randevu ek özellik | Gerçek Praxmate System |

**Praxmate'in pozisyonu:**
*"Deutsches, modernes Praxis-System. Online-Termine + Team-Kalender + ein System. Keine Plattform-Gebühr wie Doctolib, keine veraltete UI wie Samedi."*

---

## 14. "NE DEĞİLİZ" TANIMI

Praxmate **SHU ŞEY DEĞİLDİR** (focus için önemli):

- ❌ Elektronik hasta dosyası (PVS gibi CGM, TurboMed değil)
- ❌ Abrechnungssoftware (KZBV/KV fatura sistemi değil)
- ❌ Röntgen yönetimi
- ❌ Labor sonucları
- ❌ e-Rezept sistemi (TI entegrasyonu gerekir, çok büyük)
- ❌ Videosprechstunde (opsiyonel, sonraki aşama)
- ❌ HL7/FHIR messaging

Praxmate = **sadece randevu + ekip kalender + hasta iletişimi**. Daha fazlası değil.

---

## 15. SON KARAR MATRİSİ

Aşağıdaki soruları soracağım bir sonraki turunda. Bu plan içinden hangi kısımları şimdi yaparız, hangilerini bekleteriz:

1. Frontend framework: Vanilla mı, Vue mı?
2. Sprint 1'i bugün mü bitirelim yoksa daha detaylı mı planlayalım?
3. Hangi pilot müşteri(ler)e admin panel vadediyoruz — Hild + Vayhinger mi yoksa sadece Hild mi?
4. Praxmate **kendi markası** (hasi-elektronic altında değil, ayrı SaaS şirketi) mi oluyor?

---

*Doküman bitti. Gözden geçir, sorularını sor, değişiklik istersen söyle. Sonra kod yazmaya başlarız.*
