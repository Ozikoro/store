import { createFileRoute, Outlet } from '@tanstack/react-router';

import { AdminShell } from '@/store/admin-layout';

export const Route = createFileRoute('/admin')({
  staticData: {
    seo: {
      title: 'Admin',
      description: 'Ozikoro Store administration.',
      kind: 'private',
      noindex: true,
    },
  },
  component: () => (
    <AdminShell>
      <Outlet />
    </AdminShell>
  ),
});
