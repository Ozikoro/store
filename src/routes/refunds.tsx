import { createFileRoute, Link } from '@tanstack/react-router';
import { PolicyPage } from '@/store/policy-page';
import { storeHead } from '@/store/head';

export const Route = createFileRoute('/refunds')({
  head: () =>
    storeHead({
      title: 'Refunds',
      description: 'How refunds and returns work at the Ozikoro Store, including made-to-order pieces.',
      path: '/refunds',
    }),
  component: Refunds,
});

function Refunds() {
  return (
    <PolicyPage
      title="Refunds & returns"
      description="How returns and refunds work, and how money reaches you."
      updated="4 October 2026"
    >
      <section>
        <h2>Changing your mind</h2>
        <p>
          Tell us within 14 days of delivery and we will arrange a return, exchange or refund. Items should come back
          unworn, unused and in their original packaging, with anything that came with them. We may reduce a refund
          where an item has been used or damaged.
        </p>
        <p>
          To start a return, email store@ozikoro.com with your order number and what you would like to do.
        </p>
      </section>

      <section>
        <h2>Made-to-order and one-of-a-kind pieces</h2>
        <p>
          Carvings, bronzes and other pieces made specifically for you cannot be returned because you changed your
          mind. They can be returned, repaired or refunded if they arrive damaged, are materially different from
          their description, or are faulty.
        </p>
      </section>

      <section>
        <h2>Faulty or incorrect items</h2>
        <p>
          If something arrives damaged, faulty or is not what you ordered, tell us within 14 days with a photograph
          where you can. We will cover the cost of returning it and will replace it or refund it in full, including
          the original shipping.
        </p>
      </section>

      <section>
        <h2>How refunds are paid</h2>
        <p>
          Refunds go back to the card or bank account used to pay, through Paystack, which is the payment provider
          for this store. We start a refund within 2 working days of approving it. Banks then take a further 5–10
          working days to post it, depending on the bank — that part is outside our control.
        </p>
        <p>
          Shipping charges are refunded when the whole order is returned because of a fault or our error. Where you
          are returning an item because you changed your mind, the original shipping is not refunded and you pay the
          cost of sending it back.
        </p>
      </section>

      <section>
        <h2>Cancelling before dispatch</h2>
        <p>
          You can cancel an order that has not yet been dispatched and receive a full refund. Email us as soon as
          possible with the order number; if it has already left us, the returns process above applies instead.
        </p>
      </section>

      <section>
        <h2>Late or missing deliveries</h2>
        <p>
          If tracking shows an order as delivered but you have not received it, contact us within 14 days and we will
          open a case with the courier. Where an order is genuinely lost in transit we will replace it or refund it.
        </p>
      </section>

      <section>
        <h2>Your statutory rights</h2>
        <p>
          Nothing in this policy limits your rights under the consumer protection law that applies to you. Where this
          policy and your statutory rights differ, your statutory rights apply.
        </p>
        <p>
          See also our <Link to="/shipping-returns">shipping and returns</Link> page.
        </p>
      </section>
    </PolicyPage>
  );
}
