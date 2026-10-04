import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { StoreLayout, PageIntro } from '@/store/layout';
import { products } from '@/store/catalog';
import { ProductCard } from '@/store/product-card';
import { storeHead } from '@/store/head';
import { Button } from '@/components/ui/button';
const filters = ['All', 'Apparel', 'Books & Publications', 'Prints & Posters'];
export const Route = createFileRoute('/shop')({ head: () => storeHead('Shop all', 'Explore apparel, books, publications and art prints from Ozikoro.'), component: Shop });
function Shop() { const [filter, setFilter] = useState('All'); const [sort, setSort] = useState('featured'); const shown = products.filter((p) => filter === 'All' || p.category === filter).sort((a,b) => sort === 'low' ? a.price-b.price : sort === 'high' ? b.price-a.price : 0); return <StoreLayout><PageIntro eyebrow="The Ozikoro Store" title="Shop all" description="Considered pieces for curious minds and everyday life."/><div className="site-container"><div className="border-y border-border py-4 flex flex-wrap justify-between gap-4 items-center"><div className="flex gap-1 overflow-x-auto">{filters.map((f) => <Button key={f} variant={filter === f ? 'filterActive' : 'filter'} onClick={() => setFilter(f)}>{f}</Button>)}</div><div className="flex items-center gap-3 text-xs"><span className="text-muted-foreground">{shown.length} products</span><select aria-label="Sort products" className="bg-background border-0 outline-none font-medium" value={sort} onChange={(e) => setSort(e.target.value)}><option value="featured">Featured</option><option value="low">Price: low to high</option><option value="high">Price: high to low</option></select></div></div><div className="grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-12 md:gap-x-6 py-10">{shown.map((p) => <ProductCard key={p.slug} product={p}/>)}</div></div></StoreLayout>; }
