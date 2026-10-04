import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { getAuditLog } from '@/server/admin';
import { AdminPage, ErrorNote, Panel, adminButtonClass, formatDateTime } from '@/store/admin-layout';
import { storeHead } from '@/store/head';

export const Route = createFileRoute('/admin/audit')({
  head: () =>
    storeHead({
      title: 'Admin audit log',
      description: 'Price, inventory, refund and order-state changes.',
      path: '/admin/audit',
    }),
  component: AuditAdmin,
});

const ENTITIES = ['all', 'product', 'variant', 'order', 'refund', 'discount', 'shipment'] as const;
const LIMITS = [50, 100, 250, 500] as const;

function AuditAdmin() {
  const [entityDraft, setEntityDraft] = useState<string>('all');
  const [entityIdDraft, setEntityIdDraft] = useState('');
  const [limitDraft, setLimitDraft] = useState<string>('100');
  const [filters, setFilters] = useState({ entity: 'all', entityId: '', limit: 100 });

  const query = useQuery({
    queryKey: ['admin', 'audit', filters.entity, filters.entityId, filters.limit],
    queryFn: () =>
      getAuditLog({ data: { entity: filters.entity, entityId: filters.entityId, limit: filters.limit } }),
  });

  return (
    <AdminPage
      title="Audit log"
      description="Price, inventory, refund and order-state changes, newest first. Rows are never updated or deleted."
    >
      <Panel testId="audit-filters">
        <form
          className="flex flex-wrap items-end gap-4"
          data-testid="audit-filter-form"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters({ entity: entityDraft, entityId: entityIdDraft.trim(), limit: Number(limitDraft) || 100 });
          }}
        >
          <label className="min-w-[170px]">
            <span className="field-label">Entity</span>
            <select
              className="field"
              value={entityDraft}
              data-testid="audit-entity"
              onChange={(event) => setEntityDraft(event.target.value)}
            >
              {ENTITIES.map((entity) => (
                <option key={entity} value={entity}>
                  {entity}
                </option>
              ))}
            </select>
          </label>
          <label className="flex-1 min-w-[220px]">
            <span className="field-label">Entity id (optional, needs an entity)</span>
            <input
              className="field"
              value={entityIdDraft}
              data-testid="audit-entity-id"
              placeholder="ord_…, prd_…, var_…"
              onChange={(event) => setEntityIdDraft(event.target.value)}
            />
          </label>
          <label className="min-w-[130px]">
            <span className="field-label">Rows</span>
            <select
              className="field"
              value={limitDraft}
              data-testid="audit-limit"
              onChange={(event) => setLimitDraft(event.target.value)}
            >
              {LIMITS.map((limit) => (
                <option key={limit} value={limit}>
                  {limit}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={adminButtonClass} data-testid="audit-filter-submit">
            Apply
          </button>
        </form>
      </Panel>

      {query.isError ? (
        <ErrorNote>{query.error instanceof Error ? query.error.message : 'The audit log could not be loaded.'}</ErrorNote>
      ) : null}

      <Panel className="mt-6" testId="audit-table">
        {query.isPending ? <p className="text-sm text-muted-foreground">Loading the trail…</p> : null}
        {query.data && query.data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been recorded for that filter.</p>
        ) : null}
        {query.data && query.data.rows.length > 0 ? (
          <ul className="text-sm">
            {query.data.rows.map((row) => (
              <li key={row.id} className="border-t border-border py-4" data-testid={`audit-entry-${row.id}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <span className="font-mono text-xs">{row.action}</span>
                  <span className="text-xs text-muted-foreground">
                    {row.actor_email || 'system'} · {formatDateTime(row.created_at)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1 font-mono break-all">
                  {row.entity}/{row.entity_id}
                </p>
                <details className="mt-2">
                  <summary className="text-xs cursor-pointer">Before and after</summary>
                  <pre className="text-[11px] mt-2 overflow-x-auto bg-secondary p-2">{`before ${row.before}\nafter  ${row.after}`}</pre>
                </details>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </AdminPage>
  );
}
