import { createFileRoute } from '@tanstack/react-router';
import { StoreLayout, PageIntro } from '@/store/layout';
import { storeHead } from '@/store/head';

export const Route = createFileRoute('/shipping-returns')({
  head: () =>
    storeHead({
      title: 'Shipping & returns',
      description: 'Delivery times, shipping costs and the returns policy for the Ozikoro Store.',
      path: '/shipping-returns',
    }),
  component: Shipping,
});

function Shipping() {
  return (
    <StoreLayout>
      <PageIntro
        eyebrow="Help"
        title="Shipping & returns"
        description="What to know before you place an order."
      />
      <div className="site-container border-t border-border max-w-4xl ml-auto mr-auto">
        <div className="py-8 border-b border-border">
          <h2 className="font-display text-3xl mb-3">Shipping</h2>
          <p className="text-muted-foreground leading-relaxed">
            We ship from Lagos. Shipping is calculated from your delivery address at checkout and shown to you in
            full before you pay — there are no charges added afterwards.
          </p>
          <ul className="text-muted-foreground leading-relaxed mt-4 space-y-2 list-disc pl-5">
            <li>Lagos delivery: ₦2,500, 1–3 working days.</li>
            <li>Nationwide courier: ₦5,000, 3–7 working days.</li>
            <li>Free nationwide shipping on orders over ₦150,000.</li>
            <li>International courier: ₦65,000, 7–21 working days. Duties and import taxes, where they apply, are
              payable by the recipient on delivery.</li>
          </ul>
          <p className="text-muted-foreground leading-relaxed mt-4">
            Made-to-order pieces — the carvings and bronzes — are commissioned from the maker and need 2–4 weeks
            before dispatch. The product page says so before you order.
          </p>
        </div>

        <div className="py-8 border-b border-border">
          <h2 className="font-display text-3xl mb-3">Tracking</h2>
          <p className="text-muted-foreground leading-relaxed">
            When your order leaves us, a tracking number is added to your order. You can always see the current
            state of an order on your{' '}
            <span className="text-foreground">order history</span> page.
          </p>
        </div>

        <div className="py-8 border-b border-border">
          <h2 className="font-display text-3xl mb-3">Returns</h2>
          <p className="text-muted-foreground leading-relaxed">
            If something is not right, tell us within 14 days of delivery and we will arrange a return or exchange.
            Items should come back unworn, unused and in their original packaging. See the{' '}
            <span className="text-foreground">refunds policy</span> for how money is returned.
          </p>
          <p className="text-muted-foreground leading-relaxed mt-4">
            Made-to-order and one-of-a-kind pieces cannot be returned unless they arrive damaged or are not as
            described, because they are made specifically for you.
          </p>
        </div>

        <div className="py-8">
          <h2 className="font-display text-3xl mb-3">Need help?</h2>
          <p className="text-muted-foreground leading-relaxed">
            Email store@ozikoro.com with your order number and we will answer within one working day.
          </p>
        </div>
      </div>
    </StoreLayout>
  );
}
