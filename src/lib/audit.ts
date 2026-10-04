/**
 * The audit trail.
 *
 * The handoff names exactly four things that must be auditable: price,
 * inventory, refunds and order-state changes. Those are the four `entity`
 * values this application writes, and the admin surface is the only writer.
 *
 * An audit row is never updated or deleted. It records what changed, from what,
 * to what, and who did it — where "who" is an email, because an actor id is
 * meaningless once the account is gone.
 */

import { db } from './env';
import { randomToken } from './crypto';

export type AuditEntity = 'product' | 'variant' | 'order' | 'refund' | 'discount' | 'shipment';

export interface AuditActor {
  id: string;
  email: string;
}

export function isAuditEntity(value: string): value is AuditEntity {
  return ['product', 'variant', 'order', 'refund', 'discount', 'shipment'].includes(value);
}

/**
 * Write one audit row.
 *
 * Deliberately never throws. An audit failure must not roll back a legitimate
 * order or refund — losing the note is bad, losing the sale is worse — but it is
 * logged loudly so the gap is visible.
 */
export async function recordAudit(input: {
  actor: AuditActor | null;
  action: string;
  entity: AuditEntity;
  entityId: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  try {
    await db()
      .prepare(
        `INSERT INTO audit_log (id, actor_id, actor_email, action, entity, entity_id, before, after)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
      )
      .bind(
        `aud_${randomToken(12)}`,
        input.actor?.id ?? '',
        input.actor?.email ?? '',
        input.action,
        input.entity,
        input.entityId,
        JSON.stringify(input.before ?? {}),
        JSON.stringify(input.after ?? {})
      )
      .run();
  } catch (error) {
    console.error('[audit] failed to record', input.action, input.entity, input.entityId, error);
  }
}

export interface AuditRow {
  id: string;
  actor_email: string;
  action: string;
  entity: string;
  entity_id: string;
  before: string;
  after: string;
  created_at: string;
}

export async function auditTrailFor(entity: AuditEntity, entityId: string, limit = 50): Promise<AuditRow[]> {
  const result = await db()
    .prepare(
      `SELECT * FROM audit_log WHERE entity = ?1 AND entity_id = ?2
        ORDER BY created_at DESC LIMIT ?3`
    )
    .bind(entity, entityId, limit)
    .all<AuditRow>();
  return result.results ?? [];
}

export async function recentAudit(limit = 100): Promise<AuditRow[]> {
  const result = await db()
    .prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?1')
    .bind(limit)
    .all<AuditRow>();
  return result.results ?? [];
}
