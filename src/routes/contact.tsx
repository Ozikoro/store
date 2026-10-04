import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Mail, Clock, MapPin } from 'lucide-react';
import { StoreLayout, PageIntro } from '@/store/layout';
import { storeHead } from '@/store/head';
import { Button } from '@/components/ui/button';

export const Route = createFileRoute('/contact')({ head: () => storeHead('Contact', 'Get in touch with the Ozikoro Store about orders, products and artefacts.'), component: Contact });

function Contact() {
  const [sent, setSent] = useState(false);
  return <StoreLayout>
    <PageIntro eyebrow="Help" title="Get in touch" description="Questions about an order, a product or a commissioned artefact? Send us a note." />
    <div className="site-container border-t border-border pt-12 grid md:grid-cols-[1fr_1.4fr] gap-12 md:gap-20">
      <div className="space-y-8">
        {[{ icon: Mail, t: 'Email', d: 'store@ozikoro.com' }, { icon: Clock, t: 'Hours', d: 'Monday – Friday, 9am – 5pm WAT' }, { icon: MapPin, t: 'Based in', d: 'Lagos, Nigeria' }].map((i) => <div key={i.t} className="flex gap-4"><i.icon size={20} className="text-primary mt-1" /><div><p className="eyebrow mb-1">{i.t}</p><p>{i.d}</p></div></div>)}
      </div>
      {sent ? <div className="border border-border p-10"><h2 className="font-display text-3xl">Thank you.</h2><p className="text-muted-foreground mt-3">This is a preview, so your message was not sent. Messaging will be live when the store opens.</p><Button variant="outline" className="mt-6" onClick={() => setSent(false)}>Send another</Button></div> :
      <form className="grid gap-5" onSubmit={(e) => { e.preventDefault(); setSent(true); }}>
        <div className="grid sm:grid-cols-2 gap-5"><label className="text-sm grid gap-2">Name<input required className="field" /></label><label className="text-sm grid gap-2">Email<input required type="email" className="field" /></label></div>
        <label className="text-sm grid gap-2">Topic<select className="field"><option>Order support</option><option>Product question</option><option>Art & artefacts enquiry</option><option>Other</option></select></label>
        <label className="text-sm grid gap-2">Message<textarea required rows={6} className="field" /></label>
        <Button type="submit" className="justify-self-start">Send message</Button>
      </form>}
    </div>
  </StoreLayout>;
}
