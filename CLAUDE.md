# Hasi Elektronic - Deployment System

## Übersicht

Dieses Repository enthält das automatische Website-Deployment-System für Hasi Elektronic.

## Hauptbefehl

```bash
new-client <slug> "<Firmenname>" "<Stadt>" "<Telefon>" "<Branche>"
```

**Beispiel:**
```bash
new-client schmidt-elektriker "Schmidt Elektriker" "Mühlacker" "07041/123456" "Elektroinstallation"
```

**Was passiert automatisch:**
1. GitHub Repository wird erstellt
2. Cloudflare Pages Projekt wird erstellt  
3. GitHub Actions Deploy-Workflow wird eingerichtet
4. Secrets (CF_API_TOKEN, CF_ACCOUNT_ID) werden gesetzt
5. Fertige Website mit Kundendaten wird committed
6. Deploy startet automatisch → ~3 Min → Live

## Voraussetzungen

Tokens müssen gesetzt sein:
```bash
export CF_TOKEN="..."   # Cloudflare API Token
export GH_TOKEN="..."   # GitHub Personal Access Token
```

Diese sind in ~/.zshrc gespeichert und werden automatisch geladen.

## Cloudflare Account

- Account ID: ac6ab4ce1149a3591d014841856490af
- GitHub User: hasi-elektronic

## Dateien

- `new-client.sh` — Hauptscript (v4)
- `.claude/commands/new-client.md` — Claude Code Kommando-Definition
- `.claude/agents/` — **11-Agent Orchestra** (siehe `AGENTS.md`)
- `CLAUDE.md` — Diese Datei

## 🤖 Agent-Armee (ab April 2026)

Multi-Agent-System für alle digitalen Aufgaben. Leader: `hasi-orchestrator`.

**Alle 11 Agents sind global** (`~/.claude/agents/`), funktionieren in jedem Projekt:
- 👑 `hasi-orchestrator` (opus) — Leader
- `hasi-devops` · `hasi-customer-comms` · `hasi-marketing`
- `planner` · `researcher` · `designer` · `builder`
- `qa-reviewer` · `security-guardian` · `backend-architect`

Details: `.claude/agents/AGENTS.md`

## 🏗️ Technology Stack — Cloudflare-first

Entscheidung April 2026: Alle neuen Projekte nutzen Cloudflare-Ökosystem.

| Ebene | Service | Verwendung |
|---|---|---|
| Frontend Hosting | **CF Pages** | Static sites, SPAs (React/Vite/Astro) |
| Backend | **CF Workers** | API endpoints, serverless TS |
| Database | **CF D1** | SQLite SQL DB, edge-replicated |
| Cache | **CF KV** | Sessions, config, rate-limit |
| Storage | **CF R2** | Files, uploads (S3-compatible, kostenloser Egress) |
| Real-time | **Durable Objects** | WebSocket, multiplayer state |
| Mobile | **Expo + EAS** | iOS + Android cross-platform |

**NICHT mehr verwenden**: Supabase, Firebase (außer FCM), PlanetScale, Neon, Heroku.

**Rationale**: Ein Ökosystem, eine Rechnung, ein Dashboard, Edge-Performance.

## Typische Anfragen an Claude Code

- "Website für [Firma] in [Stadt] erstellen" → orchestrator + devops
- "new-client für [Firma]" → devops
- "Neuen Kunden anlegen" → orchestrator (plant komplett)
- "Angebot für [Firma]" → customer-comms
- "App für [Firma]" → orchestrator + builder + designer
- "Welche Websites haben wir bereits?" → GitHub Repos auflisten
- "Sicherheitsaudit" → security-guardian
- "Instagram Post / Karussell" → marketing
