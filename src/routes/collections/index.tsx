import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import { StoreLayout, PageIntro } from '@/store/layout';
import { categories } from '@/store/catalog';
import { storeHead } from '@/store/head';
export const Route = createFileRoute('/collections/')({ head: () => storeHead('Collections', 'Explore the Ozikoro Store collections.'), component: Collections });
function Collections() { return <StoreLayout><PageIntro eyebrow="Explore" title="The collections" description="A closer look at the things we make, publish and share."/><div className="site-container grid sm:grid-cols-2 lg:grid-cols-4 gap-6 pb-10">{categories.map((c) => <Link key={c.slug} to="/collections/$slug" params={{ slug: c.slug }} className="group"><div className="aspect-[4/5] overflow-hidden bg-secondary"><img src={c.image} alt={c.title} width={912} height={1104} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"/></div><div className="flex justify-between items-start mt-5"><div><h2 className="font-display text-3xl">{c.title}</h2><p className="text-muted-foreground text-sm mt-1">{c.description}</p></div><ArrowUpRight size={20}/></div></Link>)}</div></StoreLayout>; }
