// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStreamlinedUiEnabled } from "@/hooks/useStreamlinedUiEnabled";
import { useCombinedInboxTasksEnabled } from "@/hooks/useCombinedInboxTasksEnabled";
import { useAdapterCapabilities } from "@/adapters/use-adapter-capabilities";
import { OnboardingWizardVariant } from "@/components/OnboardingWizardVariant";
import { CloudAccessGate } from "@/components/CloudAccessGate";
import { queryKeys } from "@/lib/queryKeys";

const api = vi.hoisted(() => ({ session: vi.fn(), settings: vi.fn(), adapters: vi.fn(), open: false }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: api.session } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: api.settings } }));
vi.mock("@/api/adapters", () => ({ adaptersApi: { list: api.adapters } }));
vi.mock("@/api/health", () => ({ healthApi: { get: async () => ({ status: "ok", deploymentMode: "authenticated", bootstrapStatus: "ready" }) } }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => ({ isInstanceAdmin: true, companyIds: [] }) } }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/", search: "", hash: "" }),
  Navigate: ({ to }: { to: string }) => <div data-redirect>{to}</div>,
  Outlet: () => <div data-board>Board</div>,
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/components/OnboardingWizard", () => ({ OnboardingWizard: () => <div data-wizard="mounted"><CapabilityProbe open={api.open} /></div> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function CapabilityProbe({ open }: { open: boolean }) {
  const lookup = useAdapterCapabilities({ enabled: open });
  return <output data-capability>{String(lookup("codex_local").supportsSkills)}</output>;
}

function EntryProbe({ withAccessGate = true }: { withAccessGate?: boolean }) {
  const streamlined = useStreamlinedUiEnabled();
  const combined = useCombinedInboxTasksEnabled();
  return <>
    <output data-flags>{JSON.stringify({ streamlined, combined })}</output>
    {streamlined.loaded && withAccessGate && <div data-access-gate="mounted"><CloudAccessGate /></div>}
    <OnboardingWizardVariant />
  </>;
}

let client: QueryClient;
let host: HTMLDivElement;
let root: Root;
async function render(element = <EntryProbe />) {
  await act(async () => { root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>); });
}
async function settle() {
  for (let turn = 0; turn < 6; turn += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  }
}
function signedIn(id = "staff") {
  return { session: { id: `session:${id}`, userId: id }, user: { id, email: "fixture@example.invalid", name: "Fixture", image: null } };
}
function flags() {
  return JSON.parse(host.querySelector("[data-flags]")?.textContent ?? "null");
}

beforeEach(() => {
  vi.resetAllMocks();
  api.open = false;
  api.session.mockResolvedValue(null);
  api.settings.mockResolvedValue({ enableStreamlinedUi: true, enableCombinedInboxTasks: true });
  api.adapters.mockResolvedValue([{ type: "codex_local", capabilities: { supportsSkills: false } }]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});

describe("public entry does not query protected board endpoints", () => {
  it("lets the access gate mount while identity is still unknown", async () => {
    api.session.mockImplementation(() => new Promise(() => {}));
    await render();
    await settle();
    expect(host.querySelector("[data-access-gate]")).not.toBeNull();
    expect(host.querySelector("[data-wizard]")).toBeNull();
    expect(host.querySelector("[data-redirect]")).toBeNull();
    expect(api.settings).not.toHaveBeenCalled();
    expect(api.adapters).not.toHaveBeenCalled();
  });

  it("settles anonymous entry without protected settings or onboarding reads", async () => {
    await render();
    await settle();
    expect(flags()).toEqual({ streamlined: { enabled: true, loaded: true }, combined: { enabled: false, loaded: true } });
    expect(host.querySelector("[data-wizard]")).toBeNull();
    expect(host.querySelector("[data-redirect]")?.textContent).toBe("/auth?next=%2F");
    expect(api.settings).not.toHaveBeenCalled();
    expect(api.adapters).not.toHaveBeenCalled();
  });

  it("leaves an unavailable session to the access gate instead of starting board reads", async () => {
    api.session.mockRejectedValue(new Error("session unavailable"));
    await render();
    await settle();
    expect(client.getQueryState(queryKeys.auth.session)?.status).toBe("error");
    expect(host.querySelector("[data-access-gate]")).not.toBeNull();
    expect(host.textContent).toContain("Unable to load Paperclip");
    expect(host.querySelector("[data-redirect]")).toBeNull();
    expect(host.querySelector("[data-wizard]")).toBeNull();
    expect(api.settings).not.toHaveBeenCalled();
    expect(api.adapters).not.toHaveBeenCalled();
  });

  it("deduplicates signed-in settings reads and defers closed onboarding adapters", async () => {
    api.session.mockResolvedValue(signedIn());
    await render();
    await settle();
    expect(api.settings).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-wizard]")).not.toBeNull();
    expect(api.adapters).not.toHaveBeenCalled();
    expect(flags()).toEqual({ streamlined: { enabled: true, loaded: true }, combined: { enabled: true, loaded: true } });
    api.open = true;
    await render();
    await settle();
    expect(api.adapters).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-capability]")?.textContent).toBe("false");
  });

  it("honors explicit legacy settings after sign-in", async () => {
    api.session.mockResolvedValue(signedIn());
    api.settings.mockResolvedValue({ enableStreamlinedUi: false, enableCombinedInboxTasks: true });
    await render();
    await settle();
    expect(flags()).toEqual({ streamlined: { enabled: false, loaded: true }, combined: { enabled: false, loaded: true } });
  });

  it("enables the same reads after the local-trusted synthetic session answers", async () => {
    api.session.mockResolvedValue(signedIn("local-board"));
    api.open = true;
    await render();
    await settle();
    expect(api.settings).toHaveBeenCalledTimes(1);
    expect(api.adapters).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-wizard]")).not.toBeNull();
  });

  it("starts protected reads only after an anonymous session is replaced by sign-in", async () => {
    await render();
    await settle();
    expect(api.settings).not.toHaveBeenCalled();
    expect(api.adapters).not.toHaveBeenCalled();
    await act(async () => client.setQueryData(queryKeys.auth.session, signedIn()));
    await settle();
    expect(api.settings).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-wizard]")).not.toBeNull();
    expect(api.adapters).not.toHaveBeenCalled();
  });

  it("unmounts onboarding and disables settings when a cached session signs out", async () => {
    api.session.mockResolvedValue(signedIn());
    await render();
    await settle();
    expect(api.settings).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-wizard]")).not.toBeNull();
    await act(async () => client.setQueryData(queryKeys.auth.session, null));
    await settle();
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }); });
    await settle();
    expect(host.querySelector("[data-wizard]")).toBeNull();
    expect(host.querySelector("[data-redirect]")?.textContent).toBe("/auth?next=%2F");
    expect(api.settings).toHaveBeenCalledTimes(1);
    expect(api.adapters).not.toHaveBeenCalled();
  });

  it("preserves providerless entry defaults without making any request", async () => {
    await act(async () => root.render(<EntryProbe withAccessGate={false} />));
    await settle();
    expect(flags()).toEqual({ streamlined: { enabled: true, loaded: true }, combined: { enabled: false, loaded: true } });
    expect(host.querySelector("[data-wizard]")).toBeNull();
    expect(api.session).not.toHaveBeenCalled();
    expect(api.settings).not.toHaveBeenCalled();
    expect(api.adapters).not.toHaveBeenCalled();
  });
});

describe("capability lookup without an open wizard", () => {
  it("keeps synchronous built-in defaults while disabled, then loads server capabilities on open", async () => {
    await render(<CapabilityProbe open={false} />);
    await settle();
    expect(api.adapters).not.toHaveBeenCalled();
    expect(host.querySelector("[data-capability]")?.textContent).toBe("true");
    await render(<CapabilityProbe open />);
    await settle();
    expect(api.adapters).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-capability]")?.textContent).toBe("false");
  });
});
