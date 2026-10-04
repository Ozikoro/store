/**
 * The cart, as the browser sees it.
 *
 * There is no client-side source of truth here. Every mutation goes to the
 * server and the server's answer replaces what is displayed — including the
 * count in the header badge and every total. That is the point: the browser
 * never computes a price it will later be charged.
 *
 * The initial state comes from the route loader (server-rendered), so the badge
 * is correct in the first paint and there is no flash of an empty cart.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from '@tanstack/react-router';
import {
  getCart,
  addToCart as addToCartFn,
  setCartQuantity as setCartQuantityFn,
  removeFromCart as removeFromCartFn,
  emptyCart as emptyCartFn,
} from '@/server/store';
import type { CartLine } from '@/lib/cart';
import type { Totals } from '@/lib/pricing';

export interface CartSnapshot {
  count: number;
  lines: CartLine[];
  totals: Totals;
  subtotalMinor: number;
  currency: string;
}

const EMPTY_TOTALS: Totals = {
  subtotalMinor: 0,
  discountMinor: 0,
  shippingMinor: 0,
  taxMinor: 0,
  totalMinor: 0,
  itemCount: 0,
  freeShipping: false,
};

export const EMPTY_CART: CartSnapshot = {
  count: 0,
  lines: [],
  subtotalMinor: 0,
  totals: EMPTY_TOTALS,
  currency: 'NGN',
};

interface CartContextValue {
  cart: CartSnapshot;
  /** True while a mutation is in flight, so controls can be disabled. */
  busy: boolean;
  /** The last message the server refused with, for an inline notice. */
  notice: string | null;
  add: (variantId: string, quantity?: number) => Promise<boolean>;
  setQuantity: (itemId: string, quantity: number) => Promise<void>;
  remove: (itemId: string) => Promise<void>;
  clear: () => Promise<void>;
  refresh: () => Promise<void>;
  dismissNotice: () => void;
}

const CartContext = createContext<CartContextValue | null>(null);

export function CartProvider({ initialCart, children }: { initialCart?: CartSnapshot | undefined; children: ReactNode }) {
  const router = useRouter();
  const [cart, setCart] = useState<CartSnapshot>(initialCart ?? EMPTY_CART);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const next = await getCart();
    setCart(next as CartSnapshot);
    // Tell the router its loader data is stale, so a page reading the loader
    // re-renders with the same numbers the header is now showing.
    await router.invalidate();
  }, [router]);

  const add = useCallback(
    async (variantId: string, quantity = 1): Promise<boolean> => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await addToCartFn({ data: { variantId, quantity } });
        if (!result.ok) {
          setNotice(result.message ?? 'That item could not be added.');
          return false;
        }
        await refresh();
        return true;
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'That item could not be added.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const setQuantity = useCallback(
    async (itemId: string, quantity: number) => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await setCartQuantityFn({ data: { itemId, quantity } });
        if (!result.ok) setNotice(result.message ?? 'That quantity is not available.');
        await refresh();
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not update the quantity.');
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const remove = useCallback(
    async (itemId: string) => {
      setBusy(true);
      try {
        await removeFromCartFn({ data: { itemId } });
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  const clear = useCallback(async () => {
    setBusy(true);
    try {
      await emptyCartFn();
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      busy,
      notice,
      add,
      setQuantity,
      remove,
      clear,
      refresh,
      dismissNotice: () => setNotice(null),
    }),
    [cart, busy, notice, add, setQuantity, remove, clear, refresh]
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const context = useContext(CartContext);
  if (!context) throw new Error('useCart must be used inside CartProvider');
  return context;
}
