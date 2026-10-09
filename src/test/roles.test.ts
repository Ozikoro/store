import { describe, expect, it } from 'vitest';

import {
  CAPABILITIES,
  ROLES,
  can,
  isRole,
  isStaff,
  rolesFor,
  type Capability,
  type Role,
} from '../lib/roles';

/**
 * Who is allowed to do what.
 *
 * WHY THIS FILE MATTERS MORE THAN MOST
 *
 * Every other rule in this store, when it is wrong, costs money or goodwill. A
 * mistake here hands a stranger the refund button, or lets a member of staff
 * promote themselves. It is also the kind of mistake that is invisible in the
 * interface: hiding a link is not authorisation, and a role that is allowed one
 * capability too many looks exactly like a role that is allowed the right ones.
 *
 * So the matrix is asserted as PROPERTIES over every role and every capability,
 * not as a list of examples. Adding a role, or widening one, has to satisfy these
 * or the suite fails.
 */
describe('the matrix is well formed', () => {
  it('every capability names at least one role', () => {
    for (const [capability, roles] of Object.entries(CAPABILITIES)) {
      expect(roles.length, `${capability} has no roles`).toBeGreaterThan(0);
    }
  });

  it('every capability names only real roles', () => {
    for (const [capability, roles] of Object.entries(CAPABILITIES)) {
      for (const role of roles) {
        expect(ROLES, `${capability} names an unknown role`).toContain(role);
      }
    }
  });

  it('lists no role twice for one capability', () => {
    for (const [capability, roles] of Object.entries(CAPABILITIES)) {
      expect(new Set(roles).size, `${capability} repeats a role`).toBe(roles.length);
    }
  });

  it('every role can do at least one thing, or is deliberately powerless', () => {
    // `customer` holds only `catalog:read`, which is the shop itself. Every
    // STAFF role must hold something, or it is a role that cannot work.
    for (const role of ROLES) {
      const held = (Object.keys(CAPABILITIES) as Capability[]).filter((capability) =>
        can(role, capability)
      );
      if (role === 'customer') continue;
      expect(held.length, `${role} holds no capability at all`).toBeGreaterThan(0);
    }
  });
});

describe('a customer holds nothing administrative', () => {
  it('cannot do anything except read the catalogue', () => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
      if (capability === 'catalog:read' || capability === 'orders:read:own') continue;
      expect(can('customer', capability), `a customer can ${capability}`).toBe(false);
    }
  });

  it('is not staff', () => {
    expect(isStaff('customer')).toBe(false);
  });
});

describe('no role can promote itself', () => {
  it('only a super admin may write permissions', () => {
    expect(rolesFor('permissions:write')).toEqual(['super_admin']);
  });

  it('only a super admin may write integrations', () => {
    // An integration key is a credential. Handing one to a content manager would
    // be handing them the payment provider.
    expect(rolesFor('integrations:write')).toEqual(['super_admin']);
  });

  it('every other role is refused both', () => {
    for (const role of ROLES) {
      if (role === 'super_admin') continue;
      expect(can(role, 'permissions:write'), `${role} can write permissions`).toBe(false);
      expect(can(role, 'integrations:write'), `${role} can write integrations`).toBe(false);
    }
  });
});

describe('money is separable from parcels', () => {
  it('only a store admin or a super admin may refund', () => {
    // Fulfilment moves parcels. Refunding is a business decision about money, and
    // the role that packs boxes is not the role that decides to give it back.
    expect([...rolesFor('orders:refund')].sort()).toEqual(['store_admin', 'super_admin']);
  });

  it('fulfilment may move an order along but not refund it', () => {
    expect(can('fulfilment', 'orders:fulfil')).toBe(true);
    expect(can('fulfilment', 'orders:read:all')).toBe(true);
    expect(can('fulfilment', 'orders:refund')).toBe(false);
  });
});

describe('the catalogue is not content', () => {
  it('a content manager may write content but not the catalogue', () => {
    expect(can('content_manager', 'content:write')).toBe(true);
    expect(can('content_manager', 'catalog:write')).toBe(false);
  });

  it('a content manager cannot move an order or see the dashboard', () => {
    expect(can('content_manager', 'orders:fulfil')).toBe(false);
    expect(can('content_manager', 'orders:read:all')).toBe(false);
    expect(can('content_manager', 'dashboard:read')).toBe(false);
  });
});

describe('holding a capability implies holding the reads beneath it', () => {
  // A role that can refund an order but cannot read one is a role that cannot do
  // its job, and the failure would look like a broken screen rather than a
  // permission.
  it('refunding implies reading every order', () => {
    for (const role of rolesFor('orders:refund')) {
      expect(can(role, 'orders:read:all'), `${role} can refund but not read orders`).toBe(true);
    }
  });

  it('fulfilling implies reading every order', () => {
    for (const role of rolesFor('orders:fulfil')) {
      expect(can(role, 'orders:read:all'), `${role} can fulfil but not read orders`).toBe(true);
    }
  });

  it('writing the catalogue implies reading it', () => {
    for (const role of rolesFor('catalog:write')) {
      expect(can(role, 'catalog:read'), `${role} can write the catalogue but not read it`).toBe(true);
    }
  });

  it('reading every order implies reading your own', () => {
    for (const role of rolesFor('orders:read:all')) {
      expect(can(role, 'orders:read:own'), `${role} can read all orders but not its own`).toBe(true);
    }
  });
});

describe('the guards refuse an absent or unknown actor', () => {
  it('null, undefined and the empty role are all refused everything', () => {
    for (const capability of Object.keys(CAPABILITIES) as Capability[]) {
      expect(can(null, capability)).toBe(false);
      expect(can(undefined, capability)).toBe(false);
      expect(can('' as Role, capability)).toBe(false);
    }
  });

  it('signed out is not staff', () => {
    expect(isStaff(null)).toBe(false);
    expect(isStaff(undefined)).toBe(false);
  });

  it('recognises exactly the declared roles and nothing else', () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
    for (const nonsense of ['admin', 'owner', 'root', 'superadmin', 'Super_Admin', '', null, 42, {}]) {
      expect(isRole(nonsense), `${String(nonsense)} was accepted as a role`).toBe(false);
    }
  });
});

describe('every staff role can reach the admin surface', () => {
  it('is staff for every role except customer', () => {
    for (const role of ROLES) {
      expect(isStaff(role), `${role} misreported as not staff`).toBe(role !== 'customer');
    }
  });

  it('the dashboard is not the only way in', () => {
    // `getAdminSession` admits anyone who `isStaff`, and each SCREEN checks its
    // own capability. So a role without `dashboard:read` must still hold
    // something the admin can serve, or it would be admitted to a shell with
    // nothing in it.
    for (const role of ROLES) {
      if (role === 'customer') continue;
      const reachable = (Object.keys(CAPABILITIES) as Capability[]).filter((capability) =>
        can(role, capability)
      );
      expect(reachable.length, `${role} is staff but can reach no screen`).toBeGreaterThan(0);
    }
  });
});

describe('the shop visibility switch, which is operational and not editorial', () => {
  /**
   * `storefront:publish` decides whether strangers can spend money. Getting it
   * wrong in either direction is costly: too widely held and somebody closes the
   * shop during trading hours; too narrowly held and the person who needs it at
   * 2am cannot find anyone.
   *
   * It is deliberately NOT held by `content_manager`. Closing a shop is not a
   * content edit, and the role that maintains the catalogue should not be able to
   * take the shop offline.
   */
  it('is held by the roles that run the shop, and only those', () => {
    expect([...rolesFor('storefront:publish')].sort()).toEqual(['store_admin', 'super_admin']);
  });

  it('is NOT held by a content manager', () => {
    expect(can('content_manager', 'storefront:publish')).toBe(false);
  });

  it('is NOT held by a fulfilment role, who move parcels rather than run the shop', () => {
    expect(can('fulfilment', 'storefront:publish')).toBe(false);
  });

  it('is NOT held by a customer', () => {
    expect(can('customer', 'storefront:publish')).toBe(false);
  });

  it('refuses an absent or unknown role', () => {
    expect(can(null, 'storefront:publish')).toBe(false);
    expect(can(undefined, 'storefront:publish')).toBe(false);
  });
});
