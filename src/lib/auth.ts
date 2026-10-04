/**
 * Sessions and accounts.
 *
 * The cookie carries a 256-bit random token. The database stores only its
 * SHA-256, so a dump of the sessions table cannot be replayed as a working
 * cookie. Sessions expire, and every privileged read re-resolves the role from
 * the database rather than trusting anything the browser sent.
 */

import { db } from './env';
import { randomToken, sha256, hashPassword, verifyPassword } from './crypto';
import { AuthenticationError, AuthorizationError, isRole, type Role, type Capability, can } from './roles';

export const SESSION_COOKIE = 'ozikoro_store_session';
const SESSION_DAYS = 30;

export interface Actor {
  sessionId: string;
  customerId: string | null;
  email: string;
  name: string;
  role: Role;
}

export interface SessionRow {
  id: string;
  customer_id: string | null;
  role: string;
  expires_at: string;
}

export function sessionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
}

export function isExpired(expiresAt: string, now: Date = new Date()): boolean {
  const parsed = Date.parse(expiresAt.includes('T') ? expiresAt : `${expiresAt.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed)) return true;
  return parsed <= now.getTime();
}

/** Issue a session and return the raw token to put in the cookie. */
export async function createSession(input: {
  customerId: string | null;
  role: Role;
  userAgent?: string;
  ipHash?: string;
  expiresAt?: Date;
}): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = randomToken(32);
  const sessionId = sha256(token);
  const expiresAt = input.expiresAt ?? sessionExpiry();
  await db()
    .prepare(
      `INSERT INTO sessions (id, customer_id, role, expires_at, user_agent, ip_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    )
    .bind(
      sessionId,
      input.customerId,
      input.role,
      expiresAt.toISOString(),
      (input.userAgent ?? '').slice(0, 300),
      input.ipHash ?? ''
    )
    .run();
  return { token, sessionId, expiresAt };
}

/** Resolve an actor from a raw cookie token, or null when it is not valid. */
export async function actorFromToken(token: string | undefined | null): Promise<Actor | null> {
  if (!token) return null;
  const sessionId = sha256(token);
  const row = await db()
    .prepare(
      `SELECT s.id, s.customer_id, s.role, s.expires_at,
              COALESCE(c.email, '') AS email,
              COALESCE(c.name, '')  AS name
         FROM sessions s
         LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.id = ?1`
    )
    .bind(sessionId)
    .first<SessionRow & { email: string; name: string }>();

  if (!row) return null;
  if (isExpired(row.expires_at)) {
    await destroySession(token);
    return null;
  }
  const role: Role = isRole(row.role) ? row.role : 'customer';
  return {
    sessionId: row.id,
    customerId: row.customer_id,
    email: row.email,
    name: row.name,
    role,
  };
}

export async function destroySession(token: string): Promise<void> {
  await db().prepare('DELETE FROM sessions WHERE id = ?1').bind(sha256(token)).run();
}

export async function destroyAllSessionsFor(customerId: string): Promise<void> {
  await db().prepare('DELETE FROM sessions WHERE customer_id = ?1').bind(customerId).run();
}

export async function purgeExpiredSessions(now: Date = new Date()): Promise<void> {
  await db().prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now.toISOString()).run();
}

/** Throwing guards. These are what privileged server functions call. */
export function requireActor(actor: Actor | null): Actor {
  if (!actor) throw new AuthenticationError();
  return actor;
}

export function requireCapability(actor: Actor | null, capability: Capability): Actor {
  const resolved = requireActor(actor);
  if (!can(resolved.role, capability)) throw new AuthorizationError();
  return resolved;
}

// --------------------------------------------------------------------- accounts

export interface CustomerRow {
  id: string;
  email: string;
  name: string;
  phone: string;
  password_hash: string | null;
  password_salt: string | null;
  marketing_opt_in: number;
  created_at: string;
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  // Deliberately permissive: the only authority on whether an address works is
  // whether mail to it arrives. This rejects the obvious rubbish and no more.
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

export async function findCustomerByEmail(email: string): Promise<CustomerRow | null> {
  return db()
    .prepare('SELECT * FROM customers WHERE email = ?1')
    .bind(normaliseEmail(email))
    .first<CustomerRow>();
}

export async function findCustomerById(id: string): Promise<CustomerRow | null> {
  return db().prepare('SELECT * FROM customers WHERE id = ?1').bind(id).first<CustomerRow>();
}

/**
 * Create an account, or claim an existing guest record.
 *
 * Checkout creates a customer row for a guest so the order has an owner. When
 * that person later registers with the same address, the account is claimed
 * rather than duplicated — otherwise their order history would be split in two.
 */
export async function registerCustomer(input: {
  email: string;
  password: string;
  name?: string;
  phone?: string;
  marketingOptIn?: boolean;
}): Promise<{ customer: CustomerRow } | { error: string }> {
  const email = normaliseEmail(input.email);
  if (!isValidEmail(email)) return { error: 'Enter a valid email address.' };
  if (input.password.length < 8) return { error: 'Password must be at least 8 characters.' };

  const existing = await findCustomerByEmail(email);
  const { hash, salt } = await hashPassword(input.password);

  if (existing) {
    if (existing.password_hash) {
      return { error: 'An account with that email already exists. Sign in instead.' };
    }
    await db()
      .prepare(
        `UPDATE customers
            SET password_hash = ?2, password_salt = ?3, name = ?4, phone = ?5,
                marketing_opt_in = ?6, updated_at = datetime('now')
          WHERE id = ?1`
      )
      .bind(
        existing.id,
        hash,
        salt,
        input.name?.trim() || existing.name,
        input.phone?.trim() || existing.phone,
        input.marketingOptIn ? 1 : existing.marketing_opt_in
      )
      .run();
    const claimed = await findCustomerById(existing.id);
    return { customer: claimed as CustomerRow };
  }

  const id = `cus_${randomToken(12)}`;
  await db()
    .prepare(
      `INSERT INTO customers (id, email, password_hash, password_salt, name, phone, marketing_opt_in)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    )
    .bind(
      id,
      email,
      hash,
      salt,
      input.name?.trim() ?? '',
      input.phone?.trim() ?? '',
      input.marketingOptIn ? 1 : 0
    )
    .run();
  const created = await findCustomerById(id);
  return { customer: created as CustomerRow };
}

/** The guest record an order can point at, created on demand. */
export async function ensureCustomerForEmail(email: string, name = '', phone = ''): Promise<string> {
  const normalised = normaliseEmail(email);
  const existing = await findCustomerByEmail(normalised);
  if (existing) return existing.id;
  const id = `cus_${randomToken(12)}`;
  await db()
    .prepare('INSERT INTO customers (id, email, name, phone) VALUES (?1, ?2, ?3, ?4)')
    .bind(id, normalised, name, phone)
    .run();
  return id;
}

export async function authenticate(email: string, password: string): Promise<CustomerRow | null> {
  const customer = await findCustomerByEmail(email);
  if (!customer) {
    // Burn comparable time so a missing account and a wrong password are not
    // distinguishable by how quickly the answer comes back.
    await verifyPassword(password, { hash: null, salt: null });
    return null;
  }
  const ok = await verifyPassword(password, { hash: customer.password_hash, salt: customer.password_salt });
  return ok ? customer : null;
}

export async function setCustomerPassword(customerId: string, password: string): Promise<void> {
  const { hash, salt } = await hashPassword(password);
  await db()
    .prepare(
      `UPDATE customers SET password_hash = ?2, password_salt = ?3, updated_at = datetime('now')
        WHERE id = ?1`
    )
    .bind(customerId, hash, salt)
    .run();
}
