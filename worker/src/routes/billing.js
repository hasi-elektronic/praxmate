// ============================================================
// BILLING — Stripe Checkout + Customer Portal + Webhook
// ============================================================
// POST /api/admin/billing/checkout  — owner starts upgrade flow
// POST /api/admin/billing/portal    — owner manages existing sub (cancel/update)
// GET  /api/admin/billing/status    — current plan + period end
// POST /api/public/stripe-webhook   — Stripe → us (signed payload)
// ============================================================

import { jsonResponse, jsonError } from '../lib/http.js';
import { requireRole } from '../lib/auth.js';
import { getPracticeById } from '../lib/tenant.js';
import { logAudit } from '../lib/audit.js';
import {
  stripeRequest,
  verifyStripeSignature,
  priceIdForPlan,
  planForPriceId,
} from '../lib/stripe.js';

// ============================================================
// POST /api/admin/billing/checkout
// Body: { plan: 'solo'|'team'|'klinik', return_base: 'https://<host>' }
// Creates (or reuses) a Stripe Customer, then a Checkout Session,
// and returns { url } for the client to redirect to.
// ============================================================
export async function handleCheckoutStart(env, request) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const plan = body?.plan;
  const returnBase = String(body?.return_base || 'https://praxmate.de').replace(/\/+$/, '');

  // mode: 'trial7' (7-day trial), 'direct' (no trial, charge now), or omitted (preserve tenant's remaining trial).
  // Explicit integer `trial_days` also accepted (0-90). Takes precedence over mode.
  const mode = body?.mode;
  const explicitDays = typeof body?.trial_days === 'number' ? body.trial_days : null;

  const priceId = priceIdForPlan(env, plan);
  if (!priceId) return jsonError('Unbekannter Plan', request, 400);

  const practice = await getPracticeById(env, user.practice_id);
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  // ===== Ensure a Stripe Customer exists for this practice =====
  let customerId = practice.stripe_customer_id;
  if (!customerId) {
    const customer = await stripeRequest(env, 'POST', '/customers', {
      email: user.email,
      name:  practice.name,
      metadata: {
        practice_id: practice.id,
        practice_slug: practice.slug,
      },
    });
    customerId = customer.id;
    await env.DB.prepare(
      `UPDATE practices SET stripe_customer_id = ? WHERE id = ?`
    ).bind(customerId, practice.id).run();
  }

  // ===== Resolve trial days =====
  // Precedence: explicit trial_days > mode > tenant's remaining trial (default).
  let trialDays;
  if (explicitDays !== null) {
    trialDays = Math.max(0, Math.min(90, Math.floor(explicitDays)));
  } else if (mode === 'trial7') {
    trialDays = 7;
  } else if (mode === 'direct') {
    trialDays = 0;
  } else {
    // Fallback: preserve tenant's remaining trial if still in trial
    const stillInTrial = practice.plan_status === 'trial' && practice.trial_ends_at
      && new Date(practice.trial_ends_at).getTime() > Date.now();
    trialDays = stillInTrial
      ? Math.max(0, Math.ceil((new Date(practice.trial_ends_at).getTime() - Date.now()) / 86400000))
      : 0;
  }

  // ===== Create Checkout Session =====
  const session = await stripeRequest(env, 'POST', '/checkout/sessions', {
    customer: customerId,
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    success_url: `${returnBase}/praxis/billing.html?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${returnBase}/praxis/billing.html?status=cancelled`,
    locale: practice.locale?.slice(0, 2) || 'de',
    // Only pass trial_period_days if > 0 (Stripe rejects 0 as invalid)
    ...(trialDays > 0 ? { 'subscription_data[trial_period_days]': trialDays } : {}),
    'subscription_data[metadata][practice_id]': practice.id,
    'subscription_data[metadata][practice_slug]': practice.slug,
    'subscription_data[metadata][trial_mode]': mode || (explicitDays !== null ? `explicit:${trialDays}` : 'default'),
    allow_promotion_codes: 'true',
    billing_address_collection: 'auto',
    'metadata[practice_id]': practice.id,
    'metadata[plan]': plan,
  });

  await logAudit(env, {
    practice_id: practice.id,
    actor_type: 'user',
    actor_id: user.user_id,
    action: 'billing.checkout_started',
    meta: { plan, price_id: priceId, session_id: session.id, trial_days: daysLeft },
    request,
  });

  return jsonResponse({ url: session.url, session_id: session.id }, request);
}

// ============================================================
// POST /api/admin/billing/portal
// Redirect to the Stripe-hosted Customer Portal for plan management.
// ============================================================
export async function handleCustomerPortal(env, request) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { body = {}; }

  const returnUrl = String(body?.return_base || 'https://praxmate.de').replace(/\/+$/, '') + '/praxis/billing.html';
  const practice = await getPracticeById(env, user.practice_id);
  if (!practice?.stripe_customer_id) {
    return jsonError('Kein aktives Abonnement', request, 400);
  }

  const session = await stripeRequest(env, 'POST', '/billing_portal/sessions', {
    customer: practice.stripe_customer_id,
    return_url: returnUrl,
  });

  return jsonResponse({ url: session.url }, request);
}

// ============================================================
// GET /api/admin/billing/status
// Returns plan, status, trial/period end, public key for client-side Stripe.js.
// ============================================================
export async function handleBillingStatus(env, request) {
  const user = await requireRole(env, request, ['owner', 'doctor', 'staff']);
  const practice = await getPracticeById(env, user.practice_id);
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  // Read the Stripe-specific columns explicitly (they may not be in getPracticeById)
  const stripeRow = await env.DB.prepare(`
    SELECT stripe_customer_id, stripe_subscription_id, stripe_price_id, current_period_end
    FROM practices WHERE id = ?
  `).bind(practice.id).first() || {};

  return jsonResponse({
    plan: practice.plan,
    plan_status: practice.plan_status,
    trial_ends_at: practice.trial_ends_at,
    current_period_end: stripeRow.current_period_end || null,
    has_subscription: !!stripeRow.stripe_subscription_id,
    stripe_public_key: env.STRIPE_PUBLIC_KEY || null,
    prices: {
      solo:   { id: env.STRIPE_PRICE_SOLO,   amount_cents: 3900,  currency: 'EUR' },
      team:   { id: env.STRIPE_PRICE_TEAM,   amount_cents: 6900,  currency: 'EUR' },
      klinik: { id: env.STRIPE_PRICE_KLINIK, amount_cents: 11900, currency: 'EUR' },
    },
  }, request);
}

// ============================================================
// POST /api/public/stripe-webhook
// Verify Stripe signature, update practice state, return 200 fast.
// ============================================================
export async function handleStripeWebhook(env, request) {
  const sig = request.headers.get('Stripe-Signature');
  const rawBody = await request.text();

  const ok = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!ok) {
    // Log but reply 400 so Stripe retries with different timestamp tolerance
    console.warn('Stripe webhook: signature mismatch');
    return jsonError('Invalid signature', request, 400);
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return jsonError('Bad JSON', request, 400); }

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const s = event.data.object;
        // s.customer, s.subscription, s.metadata.practice_id
        const practiceId = s.metadata?.practice_id;
        if (practiceId && s.subscription) {
          await env.DB.prepare(`
            UPDATE practices
            SET stripe_customer_id = COALESCE(stripe_customer_id, ?),
                stripe_subscription_id = ?,
                plan_status = 'active'
            WHERE id = ?
          `).bind(s.customer, s.subscription, practiceId).run();
          await logAudit(env, {
            practice_id: practiceId,
            actor_type: 'system',
            actor_id: 'stripe',
            action: 'billing.checkout_completed',
            meta: { session_id: s.id, subscription: s.subscription },
            request,
          });
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const practiceId = sub.metadata?.practice_id;
        if (!practiceId) break;

        const item = sub.items?.data?.[0] || {};
        const priceId = item.price?.id || null;
        const derivedPlan = planForPriceId(env, priceId);
        // Stripe API 2025+: current_period_end lives on the item, not the subscription.
        const periodEnd = sub.current_period_end ?? item.current_period_end ?? null;
        const statusMap = {
          active:            'active',
          trialing:          'trial',
          past_due:          'past_due',
          unpaid:            'past_due',
          canceled:          'cancelled',
          incomplete:        'trial',
          incomplete_expired:'cancelled',
          paused:            'suspended',
        };
        const planStatus = statusMap[sub.status] || 'active';

        await env.DB.prepare(`
          UPDATE practices
          SET stripe_subscription_id = ?,
              stripe_price_id = ?,
              plan = COALESCE(?, plan),
              plan_status = ?,
              current_period_end = CASE WHEN ? IS NULL THEN NULL ELSE datetime(?, 'unixepoch') END
          WHERE id = ?
        `).bind(
          sub.id, priceId, derivedPlan, planStatus,
          periodEnd, periodEnd, practiceId
        ).run();
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const practiceId = sub.metadata?.practice_id;
        if (!practiceId) break;
        await env.DB.prepare(`
          UPDATE practices
          SET plan_status = 'cancelled',
              stripe_subscription_id = NULL
          WHERE id = ?
        `).bind(practiceId).run();
        await logAudit(env, {
          practice_id: practiceId,
          actor_type: 'system',
          actor_id: 'stripe',
          action: 'billing.subscription_cancelled',
          meta: { subscription: sub.id },
          request,
        });
        break;
      }

      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        // API 2025+: invoice.subscription may be missing; look through parent
        const subId = inv.subscription
          ?? inv.parent?.subscription_details?.subscription
          ?? inv.lines?.data?.[0]?.parent?.subscription_item_details?.subscription
          ?? null;
        if (!subId) break;
        const periodEnd = inv.lines?.data?.[0]?.period?.end;
        if (periodEnd) {
          await env.DB.prepare(`
            UPDATE practices
            SET current_period_end = datetime(?, 'unixepoch'),
                plan_status = 'active'
            WHERE stripe_subscription_id = ?
          `).bind(periodEnd, subId).run();
        }
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const subId = inv.subscription;
        if (!subId) break;
        await env.DB.prepare(`
          UPDATE practices SET plan_status = 'past_due'
          WHERE stripe_subscription_id = ?
        `).bind(subId).run();
        // Find practice id for audit
        const row = await env.DB.prepare(
          `SELECT id FROM practices WHERE stripe_subscription_id = ?`
        ).bind(subId).first();
        if (row) {
          await logAudit(env, {
            practice_id: row.id,
            actor_type: 'system',
            actor_id: 'stripe',
            action: 'billing.payment_failed',
            meta: { invoice: inv.id, amount_due: inv.amount_due },
            request,
          });
        }
        break;
      }

      default:
        // Ignore unhandled event types silently.
        break;
    }

    return jsonResponse({ received: true }, request);
  } catch (e) {
    console.error('Stripe webhook handler error:', e);
    // Return 500 so Stripe retries
    return jsonError(e.message || 'webhook handler failed', request, 500);
  }
}
