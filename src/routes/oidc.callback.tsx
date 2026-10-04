import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Loader2, XCircle, CheckCircle2 } from 'lucide-react';
import { StoreLayout } from '@/store/layout';
import { Button } from '@/components/ui/button';
import { completeOidcSignIn } from '@/server/oidc';

/**
 * The store's own OIDC redirect target.
 *
 * The store is registered as a client of its own identity provider, which looks
 * circular and is not: it is what lets the second and third platforms be added
 * without inventing a second mechanism, and it exercises the provider on every
 * sign-in rather than only in tests.
 *
 * What happens here is the standard client half: take the code from the query,
 * exchange it at the token endpoint with the PKCE verifier held in
 * `sessionStorage`, and establish the session. Nothing is believed from the URL
 * except the code, and the code is worthless without the verifier.
 */
export const Route = createFileRoute('/oidc/callback')({
  staticData: {
    seo: {
      title: 'Signing in',
      description: 'Completing a sign-in to Ozikoro.',
      kind: 'private',
    },
  },
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search['code'] === 'string' ? search['code'] : '',
    state: typeof search['state'] === 'string' ? search['state'] : '',
    error: typeof search['error'] === 'string' ? search['error'] : '',
    error_description:
      typeof search['error_description'] === 'string' ? search['error_description'] : '',
  }),
  component: OidcCallback,
});

/** Where the verifier and state wait between the two halves of the flow. */
export const PKCE_VERIFIER_KEY = 'ozikoro-oidc-verifier';
export const PKCE_STATE_KEY = 'ozikoro-oidc-state';
export const PKCE_RETURN_KEY = 'ozikoro-oidc-return';

function OidcCallback() {
  const params = Route.useSearch();
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState('Completing your sign-in…');

  useEffect(() => {
    let cancelled = false;

    async function complete() {
      if (params.error) {
        setState('failed');
        setMessage(
          params.error === 'access_denied'
            ? 'You declined to continue. Nothing was shared.'
            : params.error_description || 'The sign-in was refused.'
        );
        return;
      }
      if (!params.code) {
        setState('failed');
        setMessage('This page needs a sign-in code. Start again from the application you were using.');
        return;
      }

      const verifier = window.sessionStorage.getItem(PKCE_VERIFIER_KEY) ?? '';
      const expectedState = window.sessionStorage.getItem(PKCE_STATE_KEY) ?? '';
      const returnTo = window.sessionStorage.getItem(PKCE_RETURN_KEY) ?? '/account';

      // The state check is what stops a code from ANOTHER browser session being
      // fed to this one — a login-CSRF. It is checked before anything is sent.
      if (expectedState && params.state !== expectedState) {
        setState('failed');
        setMessage('That sign-in did not start in this browser, so it was not accepted.');
        return;
      }
      if (!verifier) {
        setState('failed');
        setMessage('The sign-in was started in a different browser. Start again from this one.');
        return;
      }

      try {
        const result = await completeOidcSignIn({ data: { code: params.code, codeVerifier: verifier } });
        if (cancelled) return;
        if (!result.ok) {
          setState('failed');
          setMessage(result.error);
          return;
        }
        window.sessionStorage.removeItem(PKCE_VERIFIER_KEY);
        window.sessionStorage.removeItem(PKCE_STATE_KEY);
        window.sessionStorage.removeItem(PKCE_RETURN_KEY);
        setState('done');
        setMessage('Signed in. Taking you back…');
        // The session cookie is set; a full load is what makes the server render
        // the signed-in header.
        window.location.replace(returnTo);
      } catch (error) {
        if (cancelled) return;
        setState('failed');
        setMessage(error instanceof Error ? error.message : 'The sign-in could not be completed.');
      }
    }

    void complete();
    return () => {
      cancelled = true;
    };
  }, [params.code, params.error, params.error_description, params.state]);

  return (
    <StoreLayout minimal>
      <div className="site-container max-w-xl py-24 text-center">
        {state === 'working' && <Loader2 size={28} className="mx-auto animate-spin text-primary-strong" />}
        {state === 'done' && <CheckCircle2 size={28} className="mx-auto text-primary-strong" />}
        {state === 'failed' && <XCircle size={28} className="mx-auto text-destructive" />}
        <p className="mt-6 text-lg" data-testid="oidc-callback-message">
          {message}
        </p>
        {state === 'failed' && (
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild>
              <Link to="/account">Go to sign-in</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/shop">Continue shopping</Link>
            </Button>
          </div>
        )}
      </div>
    </StoreLayout>
  );
}
