import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Mail, Clock, MapPin } from 'lucide-react';
import { StoreLayout, PageIntro, Notice } from '@/store/layout';
import { Button } from '@/components/ui/button';
import { sendContactMessage } from '@/server/store';

export const Route = createFileRoute('/contact')({
  staticData: {
    seo: {
      title: 'Contact',
      description: 'Get in touch with the Ozikoro Store about orders, products and commissioned artefacts. Lagos, Nigeria.',
      kind: 'article',
    },
  },
  component: Contact,
});

function Contact() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const result = await sendContactMessage({
        data: {
          name: String(form.get('name') ?? ''),
          email: String(form.get('email') ?? ''),
          topic: String(form.get('topic') ?? ''),
          message: String(form.get('message') ?? ''),
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Your message could not be sent. Please email us instead.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <StoreLayout>
      <PageIntro
        eyebrow="Help"
        title="Get in touch"
        description="Questions about an order, a product or a commissioned artefact? Send us a note."
      />
      <div className="site-container border-t border-border pt-12 grid md:grid-cols-[1fr_1.4fr] gap-12 md:gap-20">
        <div className="space-y-8">
          {[
            { icon: Mail, title: 'Email', detail: 'store@ozikoro.com' },
            { icon: Clock, title: 'Hours', detail: 'Monday – Friday, 9am – 5pm WAT' },
            { icon: MapPin, title: 'Based in', detail: 'Lagos, Nigeria' },
          ].map((item) => (
            <div key={item.title} className="flex gap-4">
              <item.icon size={20} className="text-primary-strong mt-1" aria-hidden />
              <div>
                <p className="eyebrow mb-1">{item.title}</p>
                <p>{item.detail}</p>
              </div>
            </div>
          ))}
        </div>

        {sent ? (
          <div className="border border-border p-10" data-testid="contact-sent">
            <h2 className="font-display text-3xl">Thank you.</h2>
            <p className="text-muted-foreground mt-3">
              Your message has reached us and we will reply within one working day.
            </p>
            <Button variant="outline" className="mt-6" onClick={() => setSent(false)}>
              Send another
            </Button>
          </div>
        ) : (
          <form className="grid gap-5" onSubmit={onSubmit} data-testid="contact-form">
            <div className="grid sm:grid-cols-2 gap-5">
              <label className="text-sm grid gap-2">
                Name
                <input required name="name" className="field" data-testid="contact-name" />
              </label>
              <label className="text-sm grid gap-2">
                Email
                <input required type="email" name="email" className="field" data-testid="contact-email" />
              </label>
            </div>
            <label className="text-sm grid gap-2">
              Topic
              <select name="topic" className="field" data-testid="contact-topic">
                <option>Order support</option>
                <option>Product question</option>
                <option>Art &amp; artefacts enquiry</option>
                <option>Other</option>
              </select>
            </label>
            <label className="text-sm grid gap-2">
              Message
              <textarea required name="message" rows={6} className="field h-auto py-3" data-testid="contact-message" />
            </label>
            {error && <Notice>{error}</Notice>}
            <Button type="submit" className="justify-self-start" disabled={busy} data-testid="contact-submit">
              {busy ? 'Sending…' : 'Send message'}
            </Button>
          </form>
        )}
      </div>
    </StoreLayout>
  );
}
