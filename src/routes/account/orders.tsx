import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { StoreLayout, PageIntro } from '@/store/layout';
import { storeHead } from '@/store/head';
import { products, money } from '@/store/catalog';

export const Route = createFileRoute('/account/orders')({ head: () => storeHead('Order history', 'Your Ozikoro Store order history preview.'), component: Orders });

const find = (slug: string) => products.find((p) => p.slug === slug)!;
const orders = [
  { id: 'OZK-10428', date: '28 Sep 2026', status: 'Processing', items: [{ p: find('ikenga-carved-figure'), qty: 1 }, { p: find('the-ozikoro-reader'), qty: 1 }], shipping: 3500 },
  { id: 'OZK-10311', date: '12 Sep 2026', status: 'Shipped', items: [{ p: find('ozikoro-heritage-tee'), qty: 2, v: 'M' }], shipping: 2500 },
  { id: 'OZK-10107', date: '20 Aug 2026', status: 'Delivered', items: [{ p: find('land-and-memory-print'), qty: 1, v: 'A2' }, { p: find('notes-on-culture'), qty: 1 }], shipping: 2500 },
];

function Orders() {
  return <StoreLayout>
    <PageIntro eyebrow="Your account" title="Order history" description="A sample of how your past orders will appear." />
    <div className="site-container border-t border-border">
      {orders.map((o) => {
        const total = o.items.reduce((s, i) => s + i.p.price * i.qty, 0) + o.shipping;
        return <div key={o.id} className="py-8 border-b border-border">
          <div className="flex flex-wrap justify-between gap-3 items-baseline mb-5">
            <div><h2 className="font-display text-2xl">{o.id}</h2><p className="text-xs text-muted-foreground mt-1">Placed {o.date}</p></div>
            <div className="flex items-center gap-5"><span className={`text-xs uppercase tracking-widest font-semibold ${o.status === 'Delivered' ? 'text-muted-foreground' : 'text-primary'}`}>{o.status}</span><span className="font-medium">{money(total)}</span></div>
          </div>
          <div className="grid gap-4">{o.items.map((i) => <Link key={i.p.slug} to="/products/$slug" params={{ slug: i.p.slug }} className="flex gap-4 items-center group">
            <img src={i.p.image} alt={i.p.title} width={64} height={80} loading="lazy" className="w-16 h-20 object-cover bg-secondary" />
            <div className="flex-1"><p className="group-hover:text-primary">{i.p.title}</p><p className="text-xs text-muted-foreground">{'v' in i && i.v ? `${i.v} · ` : ''}Qty {i.qty}</p></div>
            <span className="text-sm">{money(i.p.price * i.qty)}</span>
          </Link>)}</div>
        </div>;
      })}
      <p className="text-xs text-muted-foreground mt-6">Demo orders shown for preview purposes only.</p>
      <Link to="/account" className="inline-flex gap-2 items-center text-xs mt-6 text-muted-foreground"><ArrowLeft size={14} /> Back to account</Link>
    </div>
  </StoreLayout>;
}
