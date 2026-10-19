// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CostAccounts, CostBillingPolicy } from "./CostAccounts";

const byAccount = vi.hoisted(() => vi.fn());
vi.mock("@/api/costs", () => ({ costsApi: { byAccount } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.resetAllMocks(); });

async function render(enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}>
      <CostBillingPolicy policy="subscriptions_only" />
      <CostAccounts companyId="company-1" from="2026-02-01" to="2026-02-28" enabled={enabled} />
    </QueryClientProvider>);
  });
}

it("shows recorded account references and unknown unpriced usage under the selected dates", async () => {
  const row = { connectionId: null, grantId: null, provider: "openai", biller: "chatgpt",
    model: "fixture-model", billingType: "subscription_included", costCents: 0,
    inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, unpricedEventCount: 2, runCount: 1, eventCount: 2 };
  byAccount.mockResolvedValue([row, { ...row, connectionId: "retained-connection", grantId: "retained-grant" }]);
  await render();
  await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("retained-connection")); });
  expect(byAccount).toHaveBeenCalledWith("company-1", "2026-02-01", "2026-02-28");
  expect(container.textContent).toContain("retained-grant");
  expect(container.textContent).toContain("Unknown account");
  expect(container.textContent).toContain("Unpriced usage is not free");
  expect(container.textContent).toContain("Recorded charges");
  expect(container.textContent).toContain("API billing and fallback are prohibited");
  expect(container.textContent).toContain("150");
});

it("surfaces failed account reads without displaying zero-charge data", async () => {
  byAccount.mockRejectedValue(new Error("Account usage could not load"));
  await render();
  await act(async () => { await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent)
    .toContain("Account usage could not load")); });
  expect(container.querySelector("table")).toBeNull();
});

it("makes no account request while its tab is inactive", async () => {
  await render(false);
  expect(byAccount).not.toHaveBeenCalled();
});

it("keeps an older server's missing billing policy unknown", () => {
  act(() => root.render(<CostBillingPolicy policy={undefined} />));
  expect(container.textContent).toContain("AI billing policy is unknown");
  expect(container.textContent).not.toContain("permits API");
  expect(byAccount).not.toHaveBeenCalled();
});
