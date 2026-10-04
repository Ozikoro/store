import { createFileRoute, Link } from '@tanstack/react-router';
import { PolicyPage } from '@/store/policy-page';

export const Route = createFileRoute('/terms')({
  staticData: {
    seo: {
      title: 'Terms of sale',
      description: 'The terms on which the Ozikoro Store sells goods, including prices, payment and delivery.',
      kind: 'article',
    },
  },
  component: Terms,
});

function Terms() {
  return (
    <PolicyPage
      title="Terms of sale"
      description="The basis on which we sell, and what you can expect from us."
      updated="4 October 2026"
    >
      <section>
        <h2>Who you are buying from</h2>
        <p>
          The Ozikoro Store sells goods from Lagos, Nigeria, as part of Ozikoro. You can reach us at
          store@ozikoro.com for anything to do with an order.
        </p>
      </section>

      <section>
        <h2>Prices and currency</h2>
        <p>
          Prices are shown in Nigerian Naira and include any applicable taxes. The delivery charge is calculated from
          your address and is shown in full at checkout before you pay. The total you see on the payment page is the
          total you are charged; there are no charges added afterwards.
        </p>
        <p>
          If a price is obviously wrong — for example a ₦285,000 carving listed at ₦285 — we may cancel the order and
          refund you in full rather than fulfil it. We will tell you before we do that.
        </p>
      </section>

      <section>
        <h2>Your order</h2>
        <p>
          Placing an order is an offer to buy. It is accepted when the payment is verified and we confirm the order.
          Until then, the items are held for you but the contract is not formed. If we cannot fulfil an order — a
          piece is damaged in the workshop, or a courier cannot reach your address — we will cancel it and refund you
          in full.
        </p>
      </section>

      <section>
        <h2>Payment</h2>
        <p>
          Payment is taken by card, bank transfer or USSD through Paystack. Card details are entered on Paystack's
          page and are never seen or stored by this store. An order is marked paid only once the payment is verified
          on our server directly with Paystack — a browser returning from a payment page is not, by itself, proof of
          payment.
        </p>
      </section>

      <section>
        <h2>Delivery</h2>
        <p>
          Delivery estimates are estimates, not guarantees: courier networks in Nigeria are affected by weather,
          traffic and public holidays. Risk in the goods passes to you on delivery. If your order is lost in transit
          we will replace it or refund it — see the <Link to="/refunds">refunds policy</Link>.
        </p>
        <p>
          For international orders, any import duty or tax charged by the destination country is payable by the
          recipient.
        </p>
      </section>

      <section>
        <h2>Made-to-order pieces</h2>
        <p>
          Carvings, bronzes and other commissioned pieces are made after you order and take 2–4 weeks before dispatch.
          Each is unique; small variations in finish and detail are the nature of hand work, not a fault.
        </p>
      </section>

      <section>
        <h2>Returns</h2>
        <p>
          Returns and refunds are governed by the <Link to="/refunds">refunds policy</Link>, which forms part of these
          terms.
        </p>
      </section>

      <section>
        <h2>Our liability</h2>
        <p>
          We are responsible for loss you suffer that is a foreseeable result of our breaking these terms or failing
          to use reasonable care, up to the value of the order concerned. We are not responsible for loss that is not
          foreseeable, or for business losses such as lost profit. Nothing here limits liability for death, personal
          injury or fraud, or any liability that cannot be limited by law.
        </p>
      </section>

      <section>
        <h2>Using this site</h2>
        <p>
          The content, photography and design of this store belong to Ozikoro. Please do not reproduce them
          commercially without permission. Do not attempt to interfere with the store, place fraudulent orders, or
          probe its security.
        </p>
      </section>

      <section>
        <h2>Governing law</h2>
        <p>
          These terms are governed by the laws of the Federal Republic of Nigeria. See also our{' '}
          <Link to="/privacy">privacy policy</Link>.
        </p>
      </section>
    </PolicyPage>
  );
}
