import { createFileRoute, Link } from '@tanstack/react-router';
import { PolicyPage } from '@/store/policy-page';
import { storeHead } from '@/store/head';

export const Route = createFileRoute('/privacy')({
  head: () =>
    storeHead({
      title: 'Privacy',
      description: 'What the Ozikoro Store collects, why, how long it is kept, and how to have it removed.',
      path: '/privacy',
    }),
  component: Privacy,
});

function Privacy() {
  return (
    <PolicyPage
      title="Privacy"
      description="What we collect, why we collect it, and what we never do with it."
      updated="4 October 2026"
    >
      <section>
        <h2>What we collect</h2>
        <ul>
          <li>
            <strong>To take and deliver an order:</strong> your name, email address, phone number, delivery address
            and what you bought.
          </li>
          <li>
            <strong>If you create an account:</strong> your email address and a password. The password is stored only
            as a salted scrypt hash — we cannot read it, and neither can anyone who obtains the database.
          </li>
          <li>
            <strong>Payment:</strong> card payments are handled entirely by Paystack. We receive a payment reference,
            the amount, the status and the card's channel (for example "card" or "bank transfer"). We never receive or
            store your card number, expiry date or CVV.
          </li>
          <li>
            <strong>To keep the store working:</strong> a session cookie, a cart cookie, and a hashed form of your IP
            address used to rate-limit sign-in and checkout so the store cannot be brute-forced. The hash cannot be
            reversed to your IP address.
          </li>
          <li>
            <strong>If you write to us:</strong> your name, email address and message.
          </li>
        </ul>
      </section>

      <section>
        <h2>Cookies</h2>
        <p>
          This store sets two cookies, both strictly necessary and neither used for advertising or tracking:
        </p>
        <ul>
          <li>
            <code>ozikoro_store_session</code> — keeps you signed in. It holds a random token; the session itself
            lives on our server. It expires after 30 days.
          </li>
          <li>
            <code>ozikoro_store_cart</code> — remembers your basket. It expires after 60 days.
          </li>
        </ul>
        <p>
          There are no analytics cookies, no advertising pixels and no third-party trackers on this site. The only
          third party loaded in the page is Google Fonts, for typography.
        </p>
      </section>

      <section>
        <h2>Who we share it with</h2>
        <ul>
          <li>
            <strong>Paystack</strong> — to take the payment and to process refunds.
          </li>
          <li>
            <strong>Our couriers</strong> — the name, address and phone number needed to deliver your parcel.
          </li>
          <li>
            <strong>Cloudflare</strong> — this site is hosted on Cloudflare, which necessarily handles every request.
          </li>
        </ul>
        <p>We do not sell your data, and we do not share it for advertising.</p>
      </section>

      <section>
        <h2>How long we keep it</h2>
        <p>
          Order records are kept for as long as tax and accounting rules require. Account details are kept until you
          ask us to close the account. Contact messages are kept for two years. Session records are deleted when they
          expire.
        </p>
      </section>

      <section>
        <h2>Your rights</h2>
        <p>
          You can ask for a copy of what we hold about you, ask us to correct it, or ask us to delete it. Email
          store@ozikoro.com. Where an order record must be kept for tax purposes we cannot delete it, but we will tell
          you that rather than quietly refuse.
        </p>
      </section>

      <section>
        <h2>Security</h2>
        <p>
          Passwords are hashed with scrypt. Administrative access is authorised on the server for every action, not by
          hiding links. Payment webhooks are verified by HMAC signature over the exact bytes received, and every
          payment is confirmed independently with Paystack before an order is marked paid. Card details never touch
          this application.
        </p>
        <p>
          See also our <Link to="/terms">terms of sale</Link>.
        </p>
      </section>
    </PolicyPage>
  );
}
