import { createFileRoute, Outlet } from '@tanstack/react-router';

import { AdminShell } from '@/store/admin-layout';
import { storeHead } from '@/store/head';

export const Route = createFileRoute('/admin')({
  head: () =>
    storeHead({
      title: 'Admin',
      description: 'Ozikoro Store administration.',
      path: '/admin',
    }),
  component: () => (
    <AdminShell>
      <Outlet />
    </AdminShell>
  ),
});
