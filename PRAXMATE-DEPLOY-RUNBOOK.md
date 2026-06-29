# Praxmate — Deploy Runbook (v0.8.2)

## Durum (2026-04-23)

- ✅ Git: `multitenant` @ `c219d48` — tag `v0.8.2-security-hardening` pushed
- ✅ Pages: Live Demo section (v0.8.1) artık git'te — Pages auto-deploy güvenli
- ⚠️  **Worker backend fix'leri canlıda DEĞİL** — push yetmez, wrangler lazım
- 🔴 CF Worker token hâlâ compromised — rotate bekliyor

---

## Yapılacak 2 manuel adım

### 1) Worker'ı deploy et (backend fix'leri canlıya almak için)

Local makinende (Mac):

```bash
cd ~/Documents/praxmate/worker    # veya repo'nun olduğu yer
npm i wrangler -g                  # yoksa
source ~/.zshrc                    # CF_TOKEN'ı yükle

# Deploy
wrangler deploy

# Doğrula
curl -s https://praxmate-api.hguencavdi.workers.dev/api/health | jq
# → { "ok": true, "version": "2.0" }
```

**Beklenen**: Deploy ~30 saniye. Sonra cross-tenant fix, rate limit iyileştirmesi,
GDPR export endpoint, security header'lar canlıda.

### 2) Compromised CF token'ı rotate et

1. https://dash.cloudflare.com → My Profile → API Tokens
2. Eski compromised token'ı **Revoke** bas (zaten rotate edildi, artık kullanılmıyor)
3. Yeni token oluştur: "Edit Cloudflare Workers" + "Account: D1 + R2 read/write"
4. `.secrets/project-passwords/praxmate.env` güncelle (`CF_TOKEN_COMPROMISED=` satırını sil)
5. `~/.zshrc` içindeki `export CF_TOKEN="..."` değerini yeni token ile değiştir

---

## Smoke test (Worker deploy sonrası)

```bash
# 1. Rate limit logic — yeni split counter
for i in {1..6}; do
  curl -s -X POST https://praxmate-api.hguencavdi.workers.dev/api/admin/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"fake@test.de","password":"wrong"}' | jq -r .error
done
# Son 1-2 çağrıda email için değil, IP için lock mesajı gelmeli

# 2. GDPR export (admin token lazım)
curl -H "Authorization: Bearer $TOKEN" \
  https://praxmate-api.hguencavdi.workers.dev/api/admin/patients/pat_XXX/export -o export.json
# Dosya indirilir, Content-Disposition header'ı olmalı

# 3. Security header
curl -sI https://praxmate-api.hguencavdi.workers.dev/api/health | grep -iE "hsts|content-type-options"
# Strict-Transport-Security + X-Content-Type-Options görünmeli

# 4. Public booking rate limit
for i in {1..6}; do
  curl -s -X POST "https://praxmate-api.hguencavdi.workers.dev/api/appointments?practice=hild" \
    -H "Content-Type: application/json" -d '{}'
done
# 6. istekten sonra 429 "Zu viele Buchungen..." gelmeli
```

---

## Geri al (rollback)

Backend bozulursa:
```bash
cd worker
git checkout v0.8.0-praxen-improvements -- src/
wrangler deploy
```

Front-end regression:
```bash
git revert c219d48   # sadece dist/ kısmını geri almak istersen checkout v0.8.0
git push origin multitenant
```
