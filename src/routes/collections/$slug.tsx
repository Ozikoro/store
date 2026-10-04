import { createFileRoute, notFound } from '@tanstack/react-router';
import { StoreLayout, PageIntro } from '@/store/layout';
import { categories, products } from '@/store/catalog';
import { ProductCard } from '@/store/product-card';
import { storeHead } from '@/store/head';
export const Route = createFileRoute('/collections/$slug')({ loader: ({ params }) => { const category = categories.find((c) => c.slug === params.slug); if (!category) throw notFound(); return category; }, head: ({ loaderData }) => storeHead(loaderData?.title || 'Collection', loaderData?.description || 'Explore Ozikoro collections.'), component: Collection });
function Collection() { const category = Route.useLoaderData(); return <StoreLayout><PageIntro eyebrow="Collection" title={category.title} description={category.description}/><div className="site-container border-t border-border pt-10 grid grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-12 md:gap-x-6">{products.filter((p) => p.category === category.title).map((p) => <ProductCard key={p.slug} product={p}/>)}</div></StoreLayout>; }
