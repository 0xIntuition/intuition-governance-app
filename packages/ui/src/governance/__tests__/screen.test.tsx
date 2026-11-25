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
  importEnabled: false,
  query: {} as Record<string, string>,
  readCreator: vi.fn(),
}));
vi.mock("next/router", () => ({ useRouter: () => ({ query: mocks.query, push: vi.fn() }) }));
vi.mock("../deployment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../deployment")>()),
  get importEnabled() {
    return mocks.importEnabled;
  },
}));
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
  readProposalCreator: mocks.readCreator,
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
  mocks.importEnabled = false;
  mocks.query = {};
  mocks.readCreator.mockResolvedValue(null);
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
  expect(container.textContent).not.toMatch(/unavailable/i);
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
  mocks.importEnabled = true;
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
  expect(container.textContent).not.toMatch(/unavailable/i);
  await act(async () => button("Retry loading proposals").click());
  await until(() => expect(rows()).toEqual(["Proposal 1", "Proposal 0"]));
  expect(container.textContent).not.toContain("could not be loaded");
});

it("keeps imported proposals visible while the chain listing fails", async () => {
  mocks.importEnabled = true;
  mocks.readPage.mockRejectedValue(new Error("HTTP request failed."));
  mocks.receipts = [{ transactionHash: "0x01" }];
  mocks.importedIds = [idAt(4)];
  render();
  await until(() => expect(container.textContent).toContain("Some proposals may be missing below."));
  expect(rows()).toEqual(["Proposal 4"]);
  expect(container.textContent).not.toContain("No proposals have been created yet.");
});

it("shows nothing about importing when the import flag is off", async () => {
  chainWith(1);
  mocks.receipts = [{ transactionHash: "0x01" }];
  mocks.importedIds = [idAt(7)];
  render();
  await until(() => expect(rows()).toEqual(["Proposal 0"]));
  expect(container.textContent).not.toMatch(/import/i);
  expect(container.querySelector("#transaction-hash")).toBeNull();
});

it("shows the import form and fixtures when the import flag is on", async () => {
  mocks.importEnabled = true;
  chainWith(1);
  render();
  await until(() => expect(rows()).toEqual(["Proposal 0"]));
  expect(container.textContent).toContain("Import a transaction");
  expect(button("Import testnet fixtures")).toBeDefined();
});

const creator = "0x1234567890AbcdEF1234567890aBcdef12345678";
function detail(metadata: string) {
  const id = idAt(3);
  mocks.query = { proposal: id };
  mocks.readProposal.mockResolvedValue({
    id: BigInt(id),
    result: [true, false, { vetoEndDate: 1n, snapshotTimestamp: 1n, minVetoRatio: 100000 }, 0n, metadata, [], 0n],
    status: "Active",
    supply: 10n,
    threshold: 1n,
    executable: false,
    blockNumber: 5n,
    blockTimestamp: 1n,
  });
  render();
}

it("shows the creator read from chain on the proposal page", async () => {
  mocks.readCreator.mockResolvedValue(creator);
  detail("0x");
  await until(() => expect(container.textContent).toContain("Proposed by"));
  expect(container.querySelector(`a[title="${creator}"]`)).not.toBeNull();
  expect(mocks.readCreator).toHaveBeenCalledWith(BigInt(idAt(3)), 1n);
});

it("hides the creator row, metadata and imported activity when none are available", async () => {
  detail("0x");
  await until(() => expect(container.textContent).toContain("Onchain actions"));
  await until(() => expect(mocks.readCreator).toHaveBeenCalled());
  expect(container.textContent).not.toContain("Proposed by");
  expect(container.textContent).not.toContain("Proposal description");
  expect(container.textContent).not.toMatch(/not imported|unavailable|Imported activity/i);
});

it("links an ipfs metadata reference through a public gateway", async () => {
  detail("0x697066733a2f2f62616679"); // "ipfs://bafy"
  await until(() => expect(container.textContent).toContain("Proposal description"));
  const link = Array.from(container.querySelectorAll("a")).find((a) => a.textContent === "ipfs://bafy");
  expect(link?.getAttribute("href")).toBe("https://ipfs.io/ipfs/bafy");
});

it("shows a failed row read as its error, with no status badge", async () => {
  chainWith(1);
  mocks.readProposal.mockRejectedValue(new Error("Row read failed."));
  render();
  await until(() => expect(container.textContent).toContain("Row read failed."));
  expect(container.querySelector(".gov-rows .gov-status")).toBeNull();
  expect(container.textContent).not.toMatch(/unavailable/i);
});
