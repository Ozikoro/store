/**
 * Roles and the authorisation rules that follow from them.
 *
 * The handoff names five roles. Authorisation is decided on the SERVER, in the
 * server function that performs the action — never by hiding a link in the
 * browser. `requireRole` is the only door into every privileged operation, and
 * it throws rather than returning false so a forgotten `if` cannot silently
 * allow an action.
 */

export const ROLES = ['customer', 'store_admin', 'fulfilment', 'content_manager', 'super_admin'] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Capability list, mirroring the handoff's role table. */
export const CAPABILITIES = {
  'catalog:read': ['customer', 'store_admin', 'fulfilment', 'content_manager', 'super_admin'],
  'catalog:write': ['store_admin', 'super_admin'],
  'orders:read:own': ['customer', 'store_admin', 'fulfilment', 'super_admin'],
  'orders:read:all': ['store_admin', 'fulfilment', 'super_admin'],
  'orders:fulfil': ['store_admin', 'fulfilment', 'super_admin'],
  'orders:refund': ['store_admin', 'super_admin'],
  'content:write': ['content_manager', 'store_admin', 'super_admin'],
  'permissions:write': ['super_admin'],
  'integrations:write': ['super_admin'],
  'dashboard:read': ['store_admin', 'super_admin'],
} as const;

export type Capability = keyof typeof CAPABILITIES;

/** The roles that may perform a capability. */
export function rolesFor(capability: Capability): readonly Role[] {
  return CAPABILITIES[capability];
}

export function can(role: Role | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return (CAPABILITIES[capability] as readonly Role[]).includes(role);
}

/** True for any role that may see the admin surface at all. */
export function isStaff(role: Role | null | undefined): boolean {
  if (!role) return false;
  return role !== 'customer';
}

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(message = 'You do not have permission to do that.') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = 'Please sign in to continue.') {
    super(message);
    this.name = 'AuthenticationError';
  }
}
