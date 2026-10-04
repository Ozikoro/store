import { createFileRoute } from '@tanstack/react-router';
import { Search as SearchIcon } from 'lucide-react';
import { useState } from 'react';
import { StoreLayout, PageIntro } from '@/store/layout';
import { ProductCard } from '@/store/product-card';
import { products } from '@/store/catalog';
import { storeHead } from '@/store/head';
export const Route = createFileRoute('/search')({ head: () => storeHead('Search', 'Find books, apparel and prints in the Ozikoro Store.'), component: SearchPage });
function SearchPage() { const [query, setQuery] = useState(''); const results = products.filter((p) => `${p.title} ${p.category} ${p.description}`.toLowerCase().includes(query.toLowerCase())); return <StoreLayout><PageIntro eyebrow="Find something meaningful" title="Search the store"/><div className="site-container"><div className="flex items-center border-b border-foreground pb-3 gap-4"><SearchIcon size={22}/><input autoFocus type="search" aria-label="Search products" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products, collections..." className="bg-transparent outline-none flex-1 text-lg md:text-2xl placeholder:text-muted-foreground"/></div><p className="text-xs text-muted-foreground mt-8">{query ? `${results.length} results for “${query}”` : 'Explore the collection'}</p>{results.length ? <div className="grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-12 md:gap-x-6 mt-8">{results.map((p) => <ProductCard key={p.slug} product={p}/>)}</div> : <p className="py-24 text-muted-foreground">No products found. Try another search.</p>}</div></StoreLayout>; }
