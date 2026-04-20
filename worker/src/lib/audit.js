import { generateId } from './crypto.js';
import { getClientIp, getUserAgent } from './http.js';

export async function logAudit(env, {
  practice_id,
  actor_type = 'user',
  actor_id,
  action,
  target_type,
  target_id,
  meta,
  request,
}) {
  try {
    await env.DB.prepare(`
      INSERT INTO audit_log
        (id, practice_id, actor_type, actor_id, action,
         target_type, target_id, meta, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      generateId('al'),
      practice_id || null,
      actor_type,
      actor_id || null,
      action,
      target_type || null,
      target_id || null,
      meta ? JSON.stringify(meta) : null,
      request ? getClientIp(request) : null,
      request ? getUserAgent(request) : null
    ).run();
  } catch (e) {
    console.error('audit log error', e);
  }
}
