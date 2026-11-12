import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import GovernanceScreen from "../screen";
import type { ProposalIdPage } from "../rpc";

const mocks = vi.hoisted(() => ({
  readPage: vi.fn(),
  readProposal: vi.fn(),
  receipts: [] as { transactionHash: string }[],
  importedIds: [] as string[],
}));
vi.mock("next/router", () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock("wagmi", () => ({ useAccount: () => ({}), useWalletClient: () => ({}) }));
vi.mock("../shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared")>()),
  GovernanceHeader: () => null,
}));
vi.mock("../storage", () => ({
  loadReceipts: () => ({ receipts: mocks.receipts, warnings: [] }),
  saveReceipt: vi.fn(),
  removeReceipt: vi.fn(),
  clearReceipts: vi.fn(),
}));
vi.mock("../events", () => ({
  decodeStoredEvents: () =>
    mocks.importedIds.map((proposalId, logIndex) => ({
      name: "ProposalCreated",
      proposalId,
      blockNumber: 1n,
      logIndex,
      transactionHash: "0x01",
    })),
}));
vi.mock("../rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rpc")>()),
  verifyDeployment: vi.fn().mockResolvedValue({}),
  fetchReceipt: vi.fn(async (hash: string) => ({ transactionHash: hash })),
  readProposalIdPage: mocks.readPage,
  readProposal: mocks.readProposal,
}));

const idAt = (index: number) => ((1_793_819_956n << 128n) | (1_793_820_256n << 64n) | BigInt(index)).toString();
// Serves `count` proposals newest first in pages of 20, like the plugin index.
function chainWith(count: number) {
  mocks.readPage.mockImplementation(async (page: number, known?: bigint): Promise<ProposalIdPage> => {
    const total = known ?? BigInt(count);
    const end = Number(total) - page * 20;
    const start = Math.max(0, end - 20);
    return { count: total, ids: Array.from({ length: Math.max(0, end - start) }, (_, i) => idAt(end - 1 - i)) };
  });
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.receipts = [];
  mocks.importedIds = [];
  mocks.readProposal.mockImplementation(async (id: bigint) => ({
    id,
    result: [true, false, {}, 0n, "0x", [{}], 0n],
    status: "Active",
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
// Lets queries settle inside act until the check passes, then fails with the last assertion.
async function until(check: () => void) {
  for (let i = 0; i < 100; i++) {
    try {
      return check();
    } catch {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  check();
}
function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <GovernanceScreen />
      </QueryClientProvider>
    )
  );
}
const button = (text: string) =>
  Array.from(container.querySelectorAll("button")).find((node) => node.textContent === text)!;
const rows = () => Array.from(container.querySelectorAll(".gov-proposal-link")).map((a) => a.textContent);
const page = (from: number, to: number) => Array.from({ length: from - to + 1 }, (_, i) => `Proposal ${from - i}`);

it("says plainly that no proposals exist when the chain has none", async () => {
  chainWith(0);
  render();
  await until(() => expect(container.textContent).toContain("No proposals have been created yet."));
  expect(container.textContent).not.toContain("Import a transaction or");
  expect(rows()).toEqual([]);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it("lists a single onchain proposal for a browser with no imports", async () => {
  chainWith(1);
  render();
  await until(() => expect(container.textContent).toContain("1 onchain action"));
  expect(rows()).toEqual(["Proposal 0"]);
  expect(container.textContent).not.toContain("No proposals have been created yet.");
});

it("pages through many proposals and reads more IDs only when needed", async () => {
  chainWith(25);
  render();
  await until(() => expect(rows()).toEqual(page(24, 19)));
  expect(mocks.readPage).toHaveBeenCalledTimes(1);
  for (const [from, to] of [
    [18, 13],
    [12, 7],
  ]) {
    await act(async () => button("Next").click());
    await until(() => expect(rows()).toEqual(page(from, to)));
  }
  expect(mocks.readPage).toHaveBeenCalledTimes(1);
  await act(async () => button("Next").click());
  await until(() => expect(rows()).toEqual(page(6, 1)));
  expect(mocks.readPage).toHaveBeenCalledTimes(2);
  expect(mocks.readPage).toHaveBeenLastCalledWith(1, 25n);
  await until(() => expect(button("Next").disabled).toBe(false));
  await act(async () => button("Next").click());
  await until(() => expect(rows()).toEqual(["Proposal 0"]));
  expect(button("Next").disabled).toBe(true);
  expect(mocks.readPage).toHaveBeenCalledTimes(2);
});

it("shows an imported proposal once when the chain also lists it", async () => {
  chainWith(3);
  mocks.receipts = [{ transactionHash: "0x01" }];
  mocks.importedIds = [idAt(1)];
  render();
  await until(() => expect(rows()).toEqual(["Proposal 2", "Proposal 1", "Proposal 0"]));
});

it("shows an RPC failure as a recoverable error, never as an empty list", async () => {
  chainWith(2);
  mocks.readPage.mockRejectedValueOnce(new Error("HTTP request failed."));
  render();
  await until(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Proposals could not be loaded from the RPC. HTTP request failed."
    )
  );
  expect(container.textContent).not.toContain("No proposals have been created yet.");
  expect(rows()).toEqual([]);
  await act(async () => button("Retry loading proposals").click());
  await until(() => expect(rows()).toEqual(["Proposal 1", "Proposal 0"]));
  expect(container.textContent).not.toContain("could not be loaded");
});

it("keeps imported proposals visible while the chain listing fails", async () => {
  mocks.readPage.mockRejectedValue(new Error("HTTP request failed."));
  mocks.receipts = [{ transactionHash: "0x01" }];
  mocks.importedIds = [idAt(4)];
  render();
  await until(() => expect(container.textContent).toContain("Some proposals may be missing below."));
  expect(rows()).toEqual(["Proposal 4"]);
  expect(container.textContent).not.toContain("No proposals have been created yet.");
});
