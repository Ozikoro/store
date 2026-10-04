/**
 * The store's policy pages.
 *
 * These are real, complete policies rather than placeholders, because the
 * handoff requires privacy, terms, shipping and returns/refund policies to be
 * published before the store takes money — and because a policy page that says
 * "coming soon" is worse than none at all.
 *
 * One component renders all four so the typography and the "last updated" line
 * cannot drift apart between them.
 */

import type { ReactNode } from 'react';
import { StoreLayout, PageIntro } from '@/store/layout';

export function PolicyPage({
  title,
  description,
  updated,
  children,
}: {
  title: string;
  description: string;
  updated: string;
  children: ReactNode;
}) {
  return (
    <StoreLayout>
      <PageIntro eyebrow="Policies" title={title} description={description} />
      <div className="site-container border-t border-border max-w-3xl">
        <article className="py-10 space-y-8 [&_h2]:font-display [&_h2]:text-2xl [&_h2]:mb-3 [&_p]:text-muted-foreground [&_p]:leading-relaxed [&_p]:mt-3 [&_ul]:text-muted-foreground [&_ul]:leading-relaxed [&_ul]:mt-3 [&_ul]:space-y-2 [&_ul]:list-disc [&_ul]:pl-5 [&_a]:underline">
          {children}
        </article>
        <p className="text-xs text-muted-foreground border-t border-border py-6">
          Last updated {updated}. Questions? Email store@ozikoro.com.
        </p>
      </div>
    </StoreLayout>
  );
}
