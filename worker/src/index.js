// ============================================================
// PRAXMATE API v2 — Multi-tenant
// ============================================================
// Tenant resolution: see lib/tenant.js
// Admin routes: user.practice_id from session
// Public routes: from hostname/slug
// ============================================================

import { jsonResponse, jsonError, handleOptions, corsHeaders } from './lib/http.js';

// Public
import {
  handlePracticeInfo,
  handleDoctorsList,
  handleAppointmentTypes,
  handleAvailability,
  handleSlots,
  handleAppointmentCreate,
  handleAppointmentLookup,
  handleAppointmentPatientCancel,
} from './routes/public.js';

// Admin auth
import {
  handleLogin,
  handleLogout,
  handleMe,
  handlePasswordChange,
} from './routes/admin-auth.js';

// Admin data
import {
  handleDashboard,
  handleAppointmentsList,
  handleAppointmentCreateStaff,
  handleAppointmentCancel,
  handleAppointmentUpdate,
  handlePatientSearch,
  handlePatientDetail,
} from './routes/admin.js';

// Practice settings + super admin
import {
  handlePracticeSettingsGet,
  handlePracticeSettingsUpdate,
  handleSuperPracticesList,
  handleSuperPracticeDetail,
  handleSuperPracticeUpdate,
  handleSuperPracticeCreate,
  handleSuperPracticeDelete,
  handleSuperImpersonate,
  handleSuperStats,
} from './routes/settings.js';

// Logo upload
import {
  handleOwnerLogoUpload,
  handleSuperLogoUpload,
  handleLogoDelete,
} from './routes/upload.js';

// Practice resources CRUD (doctors, types, hours, users)
import {
  handleDoctorsListAdmin,
  handleDoctorCreate,
  handleDoctorUpdate,
  handleDoctorDelete,
  handleTypesListAdmin,
  handleTypeCreate,
  handleTypeUpdate,
  handleTypeDelete,
  handleHoursList,
  handleHoursUpdate,
  handleUsersList,
  handleUserCreate,
  handleUserUpdate,
  handleUserDelete,
} from './routes/resources.js';

// Patients CRUD
import {
  handlePatientsList,
  handlePatientDetailFull,
  handlePatientCreate,
  handlePatientUpdate,
  handlePatientDelete,
  handlePatientNotes,
  handlePatientExport,
} from './routes/patients.js';

// Closures (absences)
import {
  handleClosuresList,
  handleClosuresCreate,
  handleClosuresDelete,
} from './routes/closures.js';

// Public self-service signup
import {
  handlePublicSignup,
  handleSlugCheck,
} from './routes/signup.js';

// Scheduled jobs
import { runReminders } from './routes/reminders.js';
import { runBackup }    from './routes/backup.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') return handleOptions(request);

    try {
      // ============================================================
      // HEALTH
      // ============================================================
      if (path === '/api/health') {
        return jsonResponse({ ok: true, version: '2.0', timestamp: new Date().toISOString() }, request);
      }

      // ============================================================
      // PUBLIC — patient booking flow
      // ============================================================
      if (path === '/api/practice' && method === 'GET') {
        return await handlePracticeInfo(env, request);
      }
      if (path === '/api/doctors' && method === 'GET') {
        return await handleDoctorsList(env, request);
      }
      if (path === '/api/appointment-types' && method === 'GET') {
        return await handleAppointmentTypes(env, request);
      }
      if (path === '/api/availability' && method === 'GET') {
        return await handleAvailability(env, request);
      }
      if (path === '/api/slots' && method === 'GET') {
        return await handleSlots(env, request);
      }
      if (path === '/api/appointments' && method === 'POST') {
        return await handleAppointmentCreate(env, request);
      }

      // ============================================================
      // PUBLIC — self-service practice signup
      // ============================================================
      if (path === '/api/public/signup' && method === 'POST') {
        return await handlePublicSignup(env, request);
      }
      if (path === '/api/public/signup/check-slug' && method === 'GET') {
        return await handleSlugCheck(env, request);
      }

      // (Removed: one-time /api/internal/migrate-signup-rl and /cleanup-tenant.
      //  Both migrations already applied to production D1 — deleted for security.)

      // Patient self-service by magic_token
      const publicApptMatch = path.match(/^\/api\/appointments\/([a-f0-9]{48})$/);
      if (publicApptMatch && method === 'GET') {
        return await handleAppointmentLookup(env, request, publicApptMatch[1]);
      }
      if (publicApptMatch && method === 'DELETE') {
        return await handleAppointmentPatientCancel(env, request, publicApptMatch[1]);
      }

      // ============================================================
      // ADMIN — authentication
      // ============================================================
      if (path === '/api/admin/auth/login' && method === 'POST') {
        return await handleLogin(env, request);
      }
      if (path === '/api/admin/auth/logout' && method === 'POST') {
        return await handleLogout(env, request);
      }
      if (path === '/api/admin/auth/me' && method === 'GET') {
        return await handleMe(env, request);
      }
      if (path === '/api/admin/auth/password/change' && method === 'POST') {
        return await handlePasswordChange(env, request);
      }

      // ============================================================
      // ADMIN — dashboard & appointments
      // ============================================================
      if (path === '/api/admin/dashboard' && method === 'GET') {
        return await handleDashboard(env, request);
      }
      if (path === '/api/admin/appointments' && method === 'GET') {
        return await handleAppointmentsList(env, request);
      }
      if (path === '/api/admin/appointments' && method === 'POST') {
        return await handleAppointmentCreateStaff(env, request);
      }

      const adminApptMatch = path.match(/^\/api\/admin\/appointments\/(apt_[a-f0-9]+)$/);
      if (adminApptMatch && method === 'DELETE') {
        return await handleAppointmentCancel(env, request, adminApptMatch[1]);
      }
      if (adminApptMatch && method === 'PUT') {
        return await handleAppointmentUpdate(env, request, adminApptMatch[1]);
      }

      // ============================================================
      // ADMIN — patients
      // ============================================================
      if (path === '/api/admin/patients/search' && method === 'GET') {
        return await handlePatientSearch(env, request);
      }

      // Paginated list with filters
      if (path === '/api/admin/patients' && method === 'GET') {
        return await handlePatientsList(env, request);
      }
      if (path === '/api/admin/patients' && method === 'POST') {
        return await handlePatientCreate(env, request);
      }

      // Notes shortcut (before the generic :id route)
      const adminPatNotesMatch = path.match(/^\/api\/admin\/patients\/(pat_[a-f0-9]+)\/notes$/);
      if (adminPatNotesMatch && method === 'PUT') {
        return await handlePatientNotes(env, request, adminPatNotesMatch[1]);
      }

      // GDPR Art. 20 — data portability export (before generic :id route)
      const adminPatExportMatch = path.match(/^\/api\/admin\/patients\/(pat_[a-f0-9]+)\/export$/);
      if (adminPatExportMatch && method === 'GET') {
        return await handlePatientExport(env, request, adminPatExportMatch[1]);
      }

      const adminPatMatch = path.match(/^\/api\/admin\/patients\/(pat_[a-f0-9]+)$/);
      if (adminPatMatch && method === 'GET') {
        return await handlePatientDetailFull(env, request, adminPatMatch[1]);
      }
      if (adminPatMatch && method === 'PUT') {
        return await handlePatientUpdate(env, request, adminPatMatch[1]);
      }
      if (adminPatMatch && method === 'DELETE') {
        return await handlePatientDelete(env, request, adminPatMatch[1]);
      }

      // ============================================================
      // ADMIN — practice settings (any user can read, only owner can edit)
      // ============================================================
      if (path === '/api/admin/practice/settings' && method === 'GET') {
        return await handlePracticeSettingsGet(env, request);
      }
      if (path === '/api/admin/practice/settings' && method === 'PUT') {
        return await handlePracticeSettingsUpdate(env, request);
      }

      // ============================================================
      // ADMIN — doctors CRUD
      // ============================================================
      if (path === '/api/admin/doctors' && method === 'GET') {
        return await handleDoctorsListAdmin(env, request);
      }
      if (path === '/api/admin/doctors' && method === 'POST') {
        return await handleDoctorCreate(env, request);
      }
      const adminDocMatch = path.match(/^\/api\/admin\/doctors\/(doc_[a-f0-9]+)$/);
      if (adminDocMatch && method === 'PUT') {
        return await handleDoctorUpdate(env, request, adminDocMatch[1]);
      }
      if (adminDocMatch && method === 'DELETE') {
        return await handleDoctorDelete(env, request, adminDocMatch[1]);
      }

      // ============================================================
      // ADMIN — appointment types CRUD
      // ============================================================
      if (path === '/api/admin/types' && method === 'GET') {
        return await handleTypesListAdmin(env, request);
      }
      if (path === '/api/admin/types' && method === 'POST') {
        return await handleTypeCreate(env, request);
      }
      const adminTypeMatch = path.match(/^\/api\/admin\/types\/(apt_[a-f0-9]+)$/);
      if (adminTypeMatch && method === 'PUT') {
        return await handleTypeUpdate(env, request, adminTypeMatch[1]);
      }
      if (adminTypeMatch && method === 'DELETE') {
        return await handleTypeDelete(env, request, adminTypeMatch[1]);
      }

      // ============================================================
      // ADMIN — working hours
      // ============================================================
      if (path === '/api/admin/hours' && method === 'GET') {
        return await handleHoursList(env, request);
      }
      const adminHoursMatch = path.match(/^\/api\/admin\/hours\/(doc_[a-f0-9]+)$/);
      if (adminHoursMatch && method === 'PUT') {
        return await handleHoursUpdate(env, request, adminHoursMatch[1]);
      }

      // ============================================================
      // ADMIN — users (team)
      // ============================================================
      if (path === '/api/admin/users' && method === 'GET') {
        return await handleUsersList(env, request);
      }
      if (path === '/api/admin/users' && method === 'POST') {
        return await handleUserCreate(env, request);
      }
      const adminUserMatch = path.match(/^\/api\/admin\/users\/(usr_[a-f0-9]+)$/);
      if (adminUserMatch && method === 'PUT') {
        return await handleUserUpdate(env, request, adminUserMatch[1]);
      }
      if (adminUserMatch && method === 'DELETE') {
        return await handleUserDelete(env, request, adminUserMatch[1]);
      }

      // ============================================================
      // ADMIN — closures (absences / Urlaub)
      // ============================================================
      if (path === '/api/admin/closures' && method === 'GET') {
        return await handleClosuresList(env, request);
      }
      if (path === '/api/admin/closures' && method === 'POST') {
        return await handleClosuresCreate(env, request);
      }
      const adminClosureMatch = path.match(/^\/api\/admin\/closures\/(cls_[a-f0-9]+)$/);
      if (adminClosureMatch && method === 'DELETE') {
        return await handleClosuresDelete(env, request, adminClosureMatch[1]);
      }

      // ============================================================
      // SUPER-ADMIN — cross-tenant management
      // ============================================================
      if (path === '/api/super/stats' && method === 'GET') {
        return await handleSuperStats(env, request);
      }
      if (path === '/api/super/practices' && method === 'GET') {
        return await handleSuperPracticesList(env, request);
      }
      if (path === '/api/super/practices' && method === 'POST') {
        return await handleSuperPracticeCreate(env, request);
      }
      const superPrcMatch = path.match(/^\/api\/super\/practices\/(prc_[a-f0-9]+)$/);
      if (superPrcMatch && method === 'GET') {
        return await handleSuperPracticeDetail(env, request, superPrcMatch[1]);
      }
      if (superPrcMatch && method === 'PUT') {
        return await handleSuperPracticeUpdate(env, request, superPrcMatch[1]);
      }
      if (superPrcMatch && method === 'DELETE') {
        return await handleSuperPracticeDelete(env, request, superPrcMatch[1]);
      }
      const superImpMatch = path.match(/^\/api\/super\/practices\/(prc_[a-f0-9]+)\/impersonate$/);
      if (superImpMatch && method === 'POST') {
        return await handleSuperImpersonate(env, request, superImpMatch[1]);
      }

      // ============================================================
      // LOGO UPLOAD (R2)
      // ============================================================
      // Practice owner uploads own logo
      if (path === '/api/admin/practice/logo' && method === 'POST') {
        return await handleOwnerLogoUpload(env, request);
      }
      if (path === '/api/admin/practice/logo' && method === 'DELETE') {
        return await handleLogoDelete(env, request, 'self');
      }
      // Super-admin uploads for any practice
      const superLogoMatch = path.match(/^\/api\/super\/practices\/(prc_[a-f0-9]+)\/logo$/);
      if (superLogoMatch && method === 'POST') {
        return await handleSuperLogoUpload(env, request, superLogoMatch[1]);
      }
      if (superLogoMatch && method === 'DELETE') {
        return await handleLogoDelete(env, request, superLogoMatch[1]);
      }

      // ============================================================
      // 404
      // ============================================================
      return jsonError('Nicht gefunden', request, 404, { path });

    } catch (e) {
      console.error('Worker error:', e);
      const status = e.status || 500;
      return jsonError(e.message || 'Interner Fehler', request, status);
    }
  },

  // ============================================================
  // Scheduled jobs (wrangler.toml [triggers] crons)
  // ============================================================
  async scheduled(event, env, ctx) {
    // Multiple crons share this single handler — branch on cron expression.
    const cron = event.cron;
    if (cron === '0 3 * * *') {
      // 03:00 UTC daily — full DB backup → R2
      ctx.waitUntil(runBackup(env));
    } else {
      // All other crons (currently the hourly "0 * * * *") = reminder sweep
      ctx.waitUntil(runReminders(env));
    }
  },
};
