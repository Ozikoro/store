import { createFileRoute, Link } from '@tanstack/react-router';
import { StoreLayout, PageIntro } from '@/store/layout';
import { storeHead } from '@/store/head';
import { Button } from '@/components/ui/button';
export const Route = createFileRoute('/confirmation')({ head: () => storeHead('Order confirmation', 'Ozikoro Store order confirmation information.'), component: Confirmation });
function Confirmation() { return <StoreLayout><PageIntro eyebrow="Orders" title="Order confirmation"/><div className="site-container border-t border-border py-16"><p className="font-display text-3xl">Ordering is not yet open.</p><p className="text-muted-foreground mt-4 max-w-lg">When purchases are available, this page will show your confirmation and order details after a successful payment.</p><Button asChild className="mt-8"><Link to="/shop">Return to shop</Link></Button></div></StoreLayout>; }
