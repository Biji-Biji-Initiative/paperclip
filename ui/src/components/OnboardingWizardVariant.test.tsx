// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "../lib/queryKeys";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizardVariant } from "./OnboardingWizardVariant";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("./OnboardingWizard", () => ({
  OnboardingWizard: () => <div data-testid="wizard-capsule" />,
}));

describe("OnboardingWizardVariant (PAP-138)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function renderVariant() {
    root = createRoot(container);
    flushSync(() => {
      const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
      client.setQueryData(queryKeys.auth.session, { user: { id: "board-user" } });
      root!.render(<QueryClientProvider client={client}><OnboardingWizardVariant /></QueryClientProvider>);
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("renders the capsule wizard without reading the chat flag", () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    renderVariant();

    expect(container.querySelector('[data-testid="wizard-capsule"]')).not.toBeNull();
    expect(mockInstanceSettingsApi.getExperimental).not.toHaveBeenCalled();
  });
});
