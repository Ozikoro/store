/**
 * The identity provider's own pages: sign-in hand-off and consent.
 *
 * Inline CSS rather than the store's stylesheet. These pages are reached from
 * another platform, often on a slow connection, and a sign-in page that waits on
 * a font and a bundle before it can be read is a sign-in page people abandon.
 * The brand is carried by the mark, which is inlined as SVG.
 *
 * The mark's path data is the official artwork, the same bytes as
 * `src/store/brand.tsx` uses. It is duplicated rather than imported because that
 * module is a React component and this file is rendered without React — one
 * shared source would mean pulling the component runtime into a page that
 * otherwise has none.
 */

const MARK_PATHS = [
  'M47.32,143.71c-2.94-.89-6-1.61-8.8-2.72-7.56-3-15.12-5.18-23.47-4.21-5.2.61-9.74-1.59-13.53-5-1.25-1.11-2.18-2.51-.92-4,1-1.26,2.45-1,3.81-.36,5.16,2.61,10.52,2.08,16,1.57,7.16-.67,14.22,0,20.81,3.22a29.92,29.92,0,0,0,9.53,2.67c4,.5,7.51.86,6.26,6.24s-5,3-8.22,2.73a11.18,11.18,0,0,1-1.39-.32Z',
  'M52.14,119.53c-2.67-1.47-5.45-2.79-8-4.45-6.7-4.41-13.57-8.14-22-8.91-5.25-.49-9.17-3.56-12.06-7.6-.95-1.33-1.53-2.88.08-4.12,1.32-1,2.66-.5,3.82.45,4.43,3.59,9.82,4.18,15.3,4.81,7.18.82,13.93,3,19.62,7.41a29.16,29.16,0,0,0,8.7,4.55c3.82,1.32,7.15,2.38,4.61,7.33s-5.64,1.91-8.72,1a10.68,10.68,0,0,1-1.29-.59Z',
  'M62.75,97.1c-2.25-2-4.66-3.82-6.73-5.95C50.53,85.5,44.7,80.48,36.63,78c-5-1.55-8.12-5.33-10-9.85-.61-1.49-.8-3.1,1.08-4,1.53-.7,2.73.07,3.64,1.22,3.46,4.39,8.61,6.07,13.83,7.81C52.05,75.48,58.15,79,62.64,84.42a28.13,28.13,0,0,0,7.42,6.21c3.44,2.06,6.44,3.78,2.75,8.05s-6,.68-8.79-.89A9,9,0,0,1,62.9,97Z',
  'M78.63,77.57c-1.73-2.38-3.64-4.66-5.15-7.15-4-6.61-8.5-12.67-15.81-16.75-4.55-2.53-6.67-6.83-7.38-11.58-.24-1.57,0-3.17,2-3.62,1.67-.37,2.66.62,3.27,1.92,2.33,5,7,7.66,11.66,10.42C73.41,54.43,78.54,59,81.61,65.27a26.86,26.86,0,0,0,5.77,7.54c2.87,2.7,5.39,5,.73,8.36s-6-.57-8.41-2.67a9.94,9.94,0,0,1-.89-1Z',
  'M99,61.93c-1.12-2.66-2.44-5.27-3.31-8-2.32-7.22-5.25-14-11.43-19.47-3.85-3.4-4.87-8-4.41-12.75.15-1.56.74-3.07,2.87-3.08,1.73,0,2.46,1.15,2.74,2.54,1.07,5.29,5,8.84,8.9,12.49,5.15,4.77,9.06,10.3,10.56,17a25,25,0,0,0,3.81,8.49c2.16,3.21,4.08,5.94-1.32,8.25s-5.8-1.8-7.59-4.32a8.38,8.38,0,0,1-.62-1.19Z',
  'M122.72,51c-.71-2.82-1.57-5.6-2.07-8.45-1.14-6.5-3.3-12.4-8.63-17.06-3.34-2.92-4.1-7.09-3.35-11.3.26-1.48.92-2.87,2.85-2.76,1.62.09,2.24,1.22,2.4,2.58.6,5.1,4.1,8.65,7.5,12.24,4.37,4.62,7.62,9.94,8.6,16.36a22.63,22.63,0,0,0,2.92,8.15c1.83,3.08,3.45,5.7-1.68,7.62s-5.42-2.2-6.93-4.63a7.22,7.22,0,0,1-.5-1.12Z',
  'M148.72,43.68c-.35-2.9-.85-5.77-1-8.67-.34-6.6-1.6-12.71-6.28-17.9-2.99-3.32-3.28-7.5-2.09-11.6.42-1.44,1.2-2.76,3.1-2.4,1.6.3,2.06,1.51,2.05,2.87-.05,5.14,2.98,9.06,5.92,12.94,3.79,5.01,6.5,10.65,6.86,17.13a21.4,21.4,0,0,0,2.06,8.55c1.44,3.26,2.72,6.03-2.6,7.31s-5.12-2.71-6.32-5.31a6.66,6.66,0,0,1-.34-1.19Z',
  'M176.79,39.46c-.05-2.92-.2-5.83-.04-8.74.4-6.6-.18-12.79-4.27-18.53-2.63-3.7-2.44-7.87-.8-11.78.57-1.36,1.5-2.6,3.36-2.03,1.56.48,1.85,1.78,1.66,3.13-.75,5.08,1.77,9.4,4.2,13.65,3.13,5.47,5.21,11.36,4.96,17.85a21.2,21.2,0,0,0,1.36,8.71c1.11,3.44,2.09,6.36-3.29,7.03s-4.79-3.16-5.71-5.9a6.6,6.6,0,0,1-.18-1.23Z',
  'M206.27,37.2c.14-2.94.1-5.88.36-8.81.55-6.63.2-12.85-3.65-18.79-2.45-3.79-2.03-7.94-.18-11.72.68-1.31,1.7-2.5,3.51-1.81,1.53.58,1.73,1.9,1.44,3.24-1.14,5.03,1.08,9.5,3.2,13.9,2.69,5.6,4.35,11.62,3.7,18.11a20.4,20.4,0,0,0,.9,8.79c.92,3.49,1.72,6.46-3.68,6.79s-4.44-3.44-5.2-6.24a6.5,6.5,0,0,1-.1-1.24Z',
];

function markSvg(width: number, color: string): string {
  const height = Math.round((width * 282.88) / 534.79);
  const paths = MARK_PATHS.map((d) => `<path d="${d}"/>`).join('');
  return `<svg width="${width}" height="${height}" viewBox="0 0 534.79 282.88" role="img" aria-label="Ozikoro" fill="${color}">${paths}</svg>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface ConsentForm {
  action: string;
  fields: Record<string, string>;
  submit: string;
  deny: string;
  scopes: string[];
}

const SCOPE_LABELS: Record<string, string> = {
  openid: 'Confirm who you are',
  profile: 'Your name and role',
  email: 'Your email address',
};

export function renderAuthPage(input: {
  title: string;
  message: string;
  form?: ConsentForm;
  error?: string;
}): string {
  const form = input.form;
  const hidden = form
    ? Object.entries(form.fields)
        .map(
          ([name, value]) =>
            `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
        )
        .join('')
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(input.title)} | Ozikoro</title>
<style>
  :root { color-scheme: light; --yellow: #ddb02f; --ink: #231f1c; --cream: #faf7f0; --line: #ddd5c8; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
         background: var(--cream); color: var(--ink);
         font: 15px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .card { width: min(100%, 440px); background: #fff; border: 1px solid var(--line); padding: 34px 32px 28px; }
  h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 600; font-size: 27px; line-height: 1.2;
       margin: 22px 0 10px; }
  p { margin: 0 0 16px; color: #4a443d; }
  ul { margin: 0 0 22px; padding: 0; list-style: none; }
  li { display: flex; gap: 10px; align-items: baseline; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 14px; }
  li:last-child { border-bottom: 0; }
  li::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--yellow); flex: none; transform: translateY(-1px); }
  .actions { display: flex; gap: 10px; margin-top: 22px; }
  button { font: inherit; font-weight: 600; border-radius: 3px; padding: 12px 18px; cursor: pointer; border: 1px solid transparent; }
  .allow { background: var(--ink); color: #fff; flex: 1; }
  .allow:hover { background: #000; }
  .deny { background: transparent; color: #4a443d; border-color: var(--line); }
  .deny:hover { border-color: var(--ink); color: var(--ink); }
  .foot { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line); font-size: 12px; color: #6c655c; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
</style>
</head>
<body>
  <main class="card">
    ${markSvg(56, '#ddb02f')}
    <h1>${escapeHtml(input.title)}</h1>
    <p>${escapeHtml(input.message)}</p>
    ${input.error ? `<p style="color:#a3341f">${escapeHtml(input.error)}</p>` : ''}
    ${
      form
        ? `<form method="post" action="${escapeHtml(form.action)}">
      ${hidden}
      <ul>${form.scopes
        .map((scope) => `<li>${escapeHtml(SCOPE_LABELS[scope] ?? scope)}</li>`)
        .join('')}</ul>
      <div class="actions">
        <button class="allow" type="submit" name="decision" value="allow">${escapeHtml(form.submit)}</button>
        <button class="deny" type="submit" name="decision" value="deny">${escapeHtml(form.deny)}</button>
      </div>
    </form>`
        : ''
    }
    <p class="foot">
      This is the Ozikoro account service, used by ozikoro.com, ozituma.com and shop.ozikoro.com.
      Your password is never shared with an application.
    </p>
  </main>
</body>
</html>`;
}

/** Read an `application/x-www-form-urlencoded` or JSON body as a flat map. */
export async function readForm(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get('content-type') ?? '';
  const text = await request.text();
  if (type.includes('application/json')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}
