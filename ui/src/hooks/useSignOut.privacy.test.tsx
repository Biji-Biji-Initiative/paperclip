// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSignOut } from "./useSignOut";

const mocks = vi.hoisted(() => ({ signOut: vi.fn(), navigate: vi.fn() }));
vi.mock("@/api/auth", () => ({ authApi: { signOut: mocks.signOut } }));
vi.mock("@/lib/browserNavigation", () => ({ navigateTopLevel: mocks.navigate }));
vi.mock("./useCloudInstance", () => ({ useCloudInstance: () => null }));

afterEach(() => vi.resetAllMocks());
describe("logout privacy and revocation", () => {
  it.each(["network", "malformed", "callback"])("clears account data even when %s fails", async (failure) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["private-draft"], { body: "private proposal" });
    const element = document.createElement("div");
    const root = createRoot(element);
    let mutation: ReturnType<typeof useSignOut>;
    function Harness() {
      mutation = useSignOut({ onSignedOut: () => { if (failure === "callback") throw new Error("Component callback failed"); } });
      return null;
    }
    let finish: (value: { success: true; providerLogoutUrl: string }) => void = () => {};
    let fail: (error: Error) => void = () => {};
    mocks.signOut.mockImplementation(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    try {
      await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>));
      await act(async () => { mutation.mutate(); });
      expect(client.getQueryData(["private-draft"])).toBeUndefined();
      expect(mocks.navigate).not.toHaveBeenCalled();
      await act(async () => {
        if (failure === "callback") finish({ success: true, providerLogoutUrl: "https://authentik.fixture/logout" });
        else fail(new Error(failure === "network" ? "Network unavailable" : "Unconfirmed response"));
      });
      expect(client.getQueryData(["private-draft"])).toBeUndefined();
      expect(mocks.navigate).toHaveBeenCalledWith(failure === "callback" ? "https://authentik.fixture/logout" : "/auth?logout=unconfirmed");
    } finally { await act(async () => root.unmount()); client.clear(); }
  });
});
