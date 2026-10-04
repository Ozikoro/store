import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft, Package } from 'lucide-react';
import { StoreLayout, PageIntro } from '@/store/layout';
import { storeHead } from '@/store/head';
import { Button } from '@/components/ui/button';
export const Route = createFileRoute('/account/orders')({ head: () => storeHead('Order history', 'Your Ozikoro Store order history preview.'), component: Orders });
function Orders() { return <StoreLayout><PageIntro eyebrow="Your account" title="Order history"/><div className="site-container border-t border-border py-16 text-center"><Package size={34} className="mx-auto text-primary"/><h2 className="font-display text-3xl mt-5">No orders yet</h2><p className="text-muted-foreground text-sm mt-3">Orders will appear here when the store opens.</p><Button asChild className="mt-7"><Link to="/shop">Browse the store</Link></Button><div><Link to="/account" className="inline-flex gap-2 items-center text-xs mt-8 text-muted-foreground"><ArrowLeft size={14}/> Back to account</Link></div></div></StoreLayout>; }
