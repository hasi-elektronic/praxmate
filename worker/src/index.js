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
      const adminPatMatch = path.match(/^\/api\/admin\/patients\/(pat_[a-f0-9]+)$/);
      if (adminPatMatch && method === 'GET') {
        return await handlePatientDetail(env, request, adminPatMatch[1]);
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
};
