/**
 * Audit log helper
 * Logs every sensitive action for DSGVO compliance
 */

import { generateId } from './crypto.js';

/**
 * Log an action to audit trail
 * @param {object} env - Worker environment
 * @param {string} practiceId
 * @param {string} actorType - 'system' | 'user' | 'patient'
 * @param {string} actorId - user.id or 'system' or patient email
 * @param {string} action - e.g. 'appointment.created', 'user.login'
 * @param {object} opts - { target_type, target_id, meta, ip, ua }
 */
export async function logAudit(env, practiceId, actorType, actorId, action, opts = {}) {
  try {
    await env.DB.prepare(`
      INSERT INTO audit_log (id, practice_id, actor_type, actor_id, action, target_type, target_id, meta_json, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId('log'),
      practiceId,
      actorType,
      actorId,
      action,
      opts.target_type || null,
      opts.target_id || null,
      opts.meta ? JSON.stringify(opts.meta) : null,
      opts.ip || null,
      opts.ua || null
    ).run();
  } catch (e) {
    // Audit log failure should not block the main request
    console.error('Audit log failed:', e.message);
  }
}

/**
 * Convenience: log from request context
 */
export async function logAuditFromRequest(env, request, user, action, opts = {}) {
  return logAudit(env, user.practice_id, 'user', user.user_id, action, {
    ...opts,
    ip: request.headers.get('CF-Connecting-IP') || '',
    ua: request.headers.get('User-Agent') || '',
  });
}
