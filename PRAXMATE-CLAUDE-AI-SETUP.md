# Praxmate → Claude.ai'ye Taşıma Kılavuzu

Hedef: Praxmate kodunu Cowork dışına, **her cihazdan ulaşabileceğin** Claude.ai Projects'e aktar.

```
[Mac'inin praxmate/] → [GitHub repo] → [Claude.ai Project] → [iPhone/iPad/Web]
```

---

## Adım 1 — Mac'inden GitHub'a push (~2 dk)

Terminal aç:

```bash
cd ~/Documents/praxmate         # senin praxmate klasörü neredeyse
git status                       # değişiklikleri gör (yasal sayfalar dahil 9 yeni dosya)
git add .                        # hepsini stage'le
git commit -m "feat: legal pages DE/EN/TR (Impressum/Datenschutz/AGB)"
git push -u origin warteliste-tier
```

**Beklenen çıktı**: `To github.com:hasi-elektronic/praxmate.git ... new branch warteliste-tier`

Doğrulama: <https://github.com/hasi-elektronic/praxmate/tree/warteliste-tier> aç, `dist/impressum.html` görünmeli.

---

## Adım 2 — Claude.ai'de Project yarat (~3 dk)

1. <https://claude.ai> tarayıcıdan aç (Pro hesabınla giriş yap)
2. Sol kenar çubuğunda **Projects** → **+ Create Project**
3. Doldur:
   - **Name**: `Praxmate`
   - **Description**:
     ```
     Multi-tenant SaaS for medical/dental appointment scheduling.
     Stack: Cloudflare Workers + D1 + R2 + Stripe + Resend.
     Backend: github.com/hasi-elektronic/praxmate
     Plans: Warteliste €9, Solo €39, Team €69, Klinik €119.
     ```
   - **Custom instructions** (en önemli bölüm — Claude'a context ver):
     ```
     Praxmate is a multi-tenant SaaS by Hasi Elektronic (Hamdi Güncavdı,
     Vaihingen/Enz). When I ask code questions, refer to the repo
     github.com/hasi-elektronic/praxmate (warteliste-tier branch).

     Stack:
     - Frontend: vanilla HTML/CSS/JS + Vue 3 (CDN), 3-lang (DE/EN/TR)
     - Backend: Cloudflare Workers, D1 (SQLite), R2 (storage), KV
     - Payments: Stripe (LIVE + TEST dual mode), via lib/stripe.js
     - Email: Resend (DKIM-verified noreply@praxmate.de)
     - Multi-tenant by subdomain (<slug>.praxmate.de) or custom domain

     Reply in Turkish (the user's language). Code comments in English.
     Direct "Du" tone. No long preambles — go straight to action.
     ```

---

## Adım 3 — Kod dosyalarını Project Knowledge'a ekle (~5 dk)

Claude.ai'nin GitHub connector'ı henüz yaygın değil (Enterprise plan'da var). Manuel upload yapacaksın — Project sayfasında **+ Add Content** → **Upload from computer**:

### Mutlaka yükle (~12 dosya):
```
CLAUDE.md                        ← repo root
worker/src/index.js              ← main router
worker/src/lib/stripe.js         ← dual-mode + warteliste tier
worker/src/lib/tenant.js         ← tenant resolution
worker/src/lib/auth.js           ← session + rate limit
worker/src/routes/signup.js      ← self-service signup
worker/src/routes/billing.js     ← Stripe + webhook
worker/src/routes/super-tools.js ← super-admin v2
worker/src/routes/public.js      ← booking API
worker/src/routes/admin-auth.js  ← login flow
dist/index.html                  ← landing (DE)
dist/admin/dashboard.html        ← super-admin dashboard
```

### İsteğe bağlı (workflow'a bağlı):
```
dist/praxis/dashboard.html       ← owner backend
dist/book.html                   ← patient booking
dist/signup.html                 ← signup form
worker/src/routes/patients.js    ← patient CRUD
worker/src/routes/resources.js   ← doctors/types/hours CRUD
PRAXMATE-DEPLOY-RUNBOOK.md       ← deploy steps
```

**Boyut limiti**: Claude.ai Pro plan'ında Project başına ~30MB. Yukarıdaki 12 dosya ~500KB toplam — sığar.

### Pratik shortcut — bir ZIP yarat (alternatif):
```bash
cd ~/Documents/praxmate
zip -r praxmate-context.zip CLAUDE.md worker/src dist/index.html \
  dist/admin/dashboard.html dist/praxis/dashboard.html dist/book.html \
  dist/signup.html PRAXMATE-DEPLOY-RUNBOOK.md
```
Sonra `praxmate-context.zip`'i Project'e yükle — Claude.ai ZIP'i otomatik açar.

---

## Adım 4 — Test et (~1 dk)

Claude.ai → Project Praxmate → **Start conversation in this project** → yaz:

> Praxmate dashboard'a iki yeni KPI tile ekleyebilir miyiz: "Cuma randevuları" + "İptal oranı"? Mevcut KPI row pattern'ini takip et.

Eğer Claude kodu (worker/src/index.js + dashboard.html) doğru referansla cevap verirse, knowledge yüklemesi başarılı.

---

## Adım 5 — Mobil erişim (~2 dk)

1. iPhone'a/iPad'e/Android'e **Claude** app store'dan indir
2. Aynı Anthropic hesabıyla giriş yap
3. Alt menü → **Projects** → **Praxmate**
4. Yeni conversation başlat → her şey aynen orada

Telefonundan trende, yolda, kahvede yazıp devam edebilirsin.

---

## Devam edecek iş

Sprint 1 (yasal sayfalar) bitti. Geri kalan paketler:

| # | Paket | Süre |
|---|---|---|
| Sprint 2 | book.html multi-tenant (`/api/practice` opening_hours) | ~1.5h |
| Sprint 3 | EN/TR Almanca sızıntı temizliği (book + demo) | ~1h |
| Sprint 4 | 3 Monate → 7 Tage tutarlılık + plan adı + Kreditkarte | ~30dk |
| Sprint 5 | Demo doğruluk (demo-doctor stats + Sersheim→Vaihingen) | ~30dk |
| Sprint 6 | Polish (Baden-Württemberg→Germany, ROI plan picker, vb.) | ~45dk |
| Super-admin v3 | Audit viewer + manual billing actions | ~1.5h |
| Super-admin v4 | Bulk actions | ~1h |
| 2FA | TOTP login + backup codes | ~1.5h |
| Webhooks | Slack/email notifications | ~1h |
| Super-admin v5+v6 | Polish + business KPI row | ~1h |

**Toplam**: ~10 saat iş. Claude.ai Project'inde küçük batch'lerle devam.

---

## Önemli: Workflow

Bundan sonra:
1. **Code yazma**: Cowork (Mac) — direkt dosyaya edit
2. **Soru/cevap, brainstorm, kod review**: Claude.ai (her cihazdan)
3. **Push/deploy**: hep Mac terminal'inden
4. **Senkronizasyon**: GitHub repo single source of truth

Cowork tutorial dosyaları üretirken, Claude.ai chat'te dosyaları okur. İkisi GitHub üzerinden senkron kalır.

---

## Sorun çıkarsa

**Push reddedildi**: 
```bash
git pull --rebase origin warteliste-tier
git push
```

**Claude.ai dosyayı görmüyor**: Project Settings → Knowledge → Refresh / Re-upload.

**Branch karışıklığı**: 
```bash
git branch -a   # tüm branch'lar
git checkout warteliste-tier
```

**Yardım**: Hep h.guencavdi@hasi-elektronic.de'ye kendine not yaz.
