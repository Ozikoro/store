import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { products } from './catalog';
type CartItem = { slug: string; variant: string; quantity: number };
type CartContextValue = { items: CartItem[]; count: number; add: (slug: string, variant: string) => void; update: (slug: string, variant: string, quantity: number) => void; clear: () => void };
const CartContext = createContext<CartContextValue | null>(null);
export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  useEffect(() => { try { const saved = JSON.parse(localStorage.getItem('ozikoro-preview-cart') || '[]'); if (Array.isArray(saved)) setItems(saved.filter((item) => products.some((p) => p.slug === item.slug))); } catch { /* ignore invalid preview data */ } }, []);
  useEffect(() => { localStorage.setItem('ozikoro-preview-cart', JSON.stringify(items)); }, [items]);
  const add = (slug: string, variant: string) => setItems((old) => { const existing = old.find((i) => i.slug === slug && i.variant === variant); return existing ? old.map((i) => i === existing ? { ...i, quantity: i.quantity + 1 } : i) : [...old, { slug, variant, quantity: 1 }]; });
  const update = (slug: string, variant: string, quantity: number) => setItems((old) => quantity <= 0 ? old.filter((i) => i.slug !== slug || i.variant !== variant) : old.map((i) => i.slug === slug && i.variant === variant ? { ...i, quantity } : i));
  return <CartContext.Provider value={{ items, count: items.reduce((sum, i) => sum + i.quantity, 0), add, update, clear: () => setItems([]) }}>{children}</CartContext.Provider>;
}
export function useCart() { const cart = useContext(CartContext); if (!cart) throw new Error('CartProvider missing'); return cart; }
