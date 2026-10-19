import { useQuery } from "@tanstack/react-query";
import type { CostSummary } from "@paperclipai/shared";
import { costsApi } from "@/api/costs";
import { billingTypeDisplayName, formatCents, formatTokens, providerDisplayName } from "@/lib/utils";

export function CostBillingPolicy({ policy }: { policy: CostSummary["aiBillingPolicy"] }) {
  return <p className="text-sm text-muted-foreground" role="note" aria-label="AI billing policy">
    {policy === "subscriptions_only" ? "Subscriptions only. API billing and fallback are prohibited."
      : policy === "unrestricted" ? "Instance policy permits API and subscription connections."
        : "AI billing policy is unknown; the server has not reported it."}
  </p>;
}

export function CostAccounts({ companyId, from, to, enabled }: {
  companyId: string;
  from?: string;
  to?: string;
  enabled: boolean;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["usage-by-account", companyId, from, to],
    queryFn: () => costsApi.byAccount(companyId, from, to),
    enabled,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  return (
    <section className="space-y-4" aria-label="Account usage">
      <p className="text-sm text-muted-foreground">
        Accounts come from saved run references you may inspect. Missing or inaccessible attribution
        stays unknown, including protected host subscriptions without a retained account receipt.
        Unpriced usage is not free; recorded-charge budgets do not cap it.
      </p>
      {error ? <p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>
        : isLoading ? <p className="text-sm text-muted-foreground">Loading account usage…</p>
          : !data?.length ? <p className="text-sm text-muted-foreground">No recorded usage in this date range.</p>
            : <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead><tr>
                  <th className="p-2">Account reference</th>
                  <th className="p-2">Provider / biller / model</th>
                  <th className="p-2">Tokens</th>
                  <th className="p-2">Recorded charges</th>
                  <th className="p-2">Unpriced events</th>
                  <th className="p-2">Matched runs / events</th>
                </tr></thead>
                <tbody>{data.map(row => (
                  <tr key={JSON.stringify([row.connectionId, row.grantId, row.provider, row.biller, row.billingType, row.model])}>
                    <td className="p-2">
                      {row.connectionId ? <><div className="font-mono text-xs">{row.connectionId}</div>
                        <div className="font-mono text-xs text-muted-foreground">Grant: {row.grantId}</div></>
                        : "Unknown account"}
                    </td>
                    <td className="p-2"><div>{providerDisplayName(row.provider)} / {providerDisplayName(row.biller)}</div>
                      <div className="font-mono text-xs">{row.model}</div>
                      <div className="text-xs text-muted-foreground">{billingTypeDisplayName(row.billingType)}</div></td>
                    <td className="p-2 font-mono">{formatTokens(row.inputTokens + row.cachedInputTokens + row.outputTokens)}</td>
                    <td className="p-2 font-mono">{formatCents(row.costCents)}</td>
                    <td className="p-2 font-mono">{row.unpricedEventCount}</td>
                    <td className="p-2 font-mono">{row.runCount} / {row.eventCount}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>}
    </section>
  );
}
