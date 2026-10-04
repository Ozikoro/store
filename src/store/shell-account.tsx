/**
 * The account as the shell needs it.
 *
 * The root route already resolves the session on the server, and the header
 * needs one fact from it: whether this visitor is staff, so the admin link
 * appears. Threading that through every `StoreLayout` call site would be
 * fourteen edits and a prop that is easy to forget on the fifteenth page, so it
 * travels in context instead.
 *
 * It is a convenience for the UI and NOT an authorisation decision: every admin
 * server function re-resolves the actor from the session and checks the
 * capability itself. A visitor who fakes this flag gets a visible link and a 403
 * on every page behind it.
 */

import { createContext, useContext, type ReactNode } from 'react';

export interface ShellAccount {
  isStaff: boolean;
  name: string;
  email: string;
}

const EMPTY: ShellAccount = { isStaff: false, name: '', email: '' };

const ShellAccountContext = createContext<ShellAccount>(EMPTY);

export function ShellAccountProvider({
  account,
  children,
}: {
  account?: Partial<ShellAccount> | undefined;
  children: ReactNode;
}) {
  return (
    <ShellAccountContext.Provider value={{ ...EMPTY, ...(account ?? {}) }}>
      {children}
    </ShellAccountContext.Provider>
  );
}

export function useShellAccount(): ShellAccount {
  return useContext(ShellAccountContext);
}
