import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CreateProposalPage from "../create";
import { deployment } from "../deployment";
import { makeProposalPlan } from "../proposing";

const mocks = vi.hoisted(() => ({
  account: { address: "", chainId: 13579 },
  permission: true,
  prepare: vi.fn(),
  write: vi.fn(),
  wait: vi.fn(),
  transaction: vi.fn(),
  receipt: vi.fn(),
  save: vi.fn(),
  invalidate: vi.fn(),
  importEnabled: true,
}));
vi.mock("../deployment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../deployment")>()),
  get importEnabled() {
    return mocks.importEnabled;
  },
}));
vi.mock("wagmi", () => ({
  useAccount: () => mocks.account,
  useWalletClient: () => ({
    data: {
      account: { address: mocks.account.address },
      getAddresses: async () => [mocks.account.address],
      getChainId: async () => mocks.account.chainId,
      writeContract: mocks.write,
    },
  }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "proposal-config" ? { settings: [200000, 120] } : mocks.permission,
    isSuccess: true,
    isFetching: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("../shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared")>()),
  GovernanceHeader: () => null,
}));
vi.mock("../proposing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../proposing")>()),
  prepareProposal: mocks.prepare,
}));
vi.mock("../rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../rpc")>()),
  governanceClient: { waitForTransactionReceipt: mocks.wait, getTransaction: mocks.transaction },
  fetchReceipt: mocks.receipt,
}));
vi.mock("../storage", () => ({ saveReceipt: mocks.save }));
vi.mock("../events", () => ({
  decodeStoredEvents: () => [{ name: "ProposalCreated", proposalId: "999", creator: mocks.account.address }],
}));

const hash = `0x${"ab".repeat(32)}`;
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.account = { address: deployment.manager, chainId: deployment.chainId };
  mocks.permission = true;
  mocks.prepare.mockResolvedValue({ request: {}, result: 123n });
  mocks.write.mockResolvedValue(hash);
  mocks.wait.mockResolvedValue({ status: "success", transactionHash: hash });
  mocks.transaction.mockResolvedValue({
    to: deployment.plugin,
    from: deployment.manager,
    value: 0n,
    input: makeProposalPlan({ kind: "test", proposer: "", metadata: "", duration: "120", actions: [] }, 120n).data,
  });
  mocks.receipt.mockResolvedValue({ transactionHash: hash });
  mocks.save.mockImplementation(() => {});
  mocks.importEnabled = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  Array.from(container.querySelectorAll("button")).find((node) => node.textContent === text)!;
const render = () => act(() => root.render(<CreateProposalPage />));
async function submit() {
  render();
  await act(async () => button("Review proposal").click());
  await act(async () => button("Create proposal").click());
}
it("disables proposal submission for unauthorized and wrong-chain wallets", () => {
  mocks.permission = false;
  render();
  expect(button("Review proposal").disabled).toBe(true);
  expect(container.textContent).toContain("cannot create this proposal");
  mocks.permission = true;
  mocks.account.chainId = 1;
  render();
  expect(button("Review proposal").disabled).toBe(true);
  expect(mocks.write).not.toHaveBeenCalled();
});
it("uses the confirmed event ID and keeps success visible when local storage fails", async () => {
  mocks.save.mockImplementation(() => {
    throw new Error("Storage unavailable");
  });
  await submit();
  expect(container.querySelector('a[href="/?proposal=999"]')).not.toBeNull();
  expect(container.querySelector('a[href="/?proposal=123"]')).toBeNull();
  expect(container.textContent).toContain("Storage unavailable");
  expect(container.textContent).toContain("proposal was created successfully");
});
it("does not touch local history when import is off", async () => {
  mocks.importEnabled = false;
  await submit();
  expect(container.querySelector('a[href="/?proposal=999"]')).not.toBeNull();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["governance-proposal-ids"] });
  expect(container.textContent).not.toMatch(/import/i);
});
it("keeps a timed-out transaction available for confirmation without submitting twice", async () => {
  mocks.wait.mockRejectedValueOnce(new Error("Confirmation timed out"));
  await submit();
  expect(button("Create proposal")).toBeUndefined();
  expect(container.textContent).toContain("Confirmation timed out");
  await act(async () => button("Check confirmation").click());
  expect(mocks.write).toHaveBeenCalledTimes(1);
  expect(container.querySelector('a[href="/?proposal=999"]')).not.toBeNull();
});
it("allows retry after a rejected signature without displaying a successful proposal", async () => {
  mocks.write.mockRejectedValueOnce(new Error("User rejected the request"));
  await submit();
  expect(container.textContent).toContain("User rejected");
  expect(button("Create proposal").disabled).toBe(false);
  expect(mocks.wait).not.toHaveBeenCalled();
});
it("blocks signing when the account changes during preflight", async () => {
  mocks.prepare.mockImplementationOnce(async () => {
    mocks.account.address = deployment.dao;
    return { request: {} };
  });
  await submit();
  expect(mocks.write).not.toHaveBeenCalled();
  expect(container.textContent).toContain("wallet or network changed");
});
it("does not report success for a different transaction", async () => {
  mocks.transaction.mockResolvedValueOnce({ to: deployment.plugin, from: deployment.manager, value: 0n, input: "0x" });
  await submit();
  expect(container.textContent).toContain("does not match");
  expect(mocks.save).not.toHaveBeenCalled();
  expect(container.querySelector('a[href="/?proposal=999"]')).toBeNull();
});
it("allows a fresh review after a reverted transaction", async () => {
  mocks.wait.mockResolvedValueOnce({ status: "reverted", transactionHash: hash });
  await submit();
  expect(container.textContent).toContain("transaction reverted");
  expect(button("Review proposal").disabled).toBe(false);
  expect(mocks.save).not.toHaveBeenCalled();
});
it("compares confirmed calldata by bytes regardless of hexadecimal casing", async () => {
  const transaction = await mocks.transaction();
  mocks.transaction.mockResolvedValueOnce({ ...transaction, input: "0x" + transaction.input.slice(2).toUpperCase() });
  await submit();
  expect(container.querySelector('a[href="/?proposal=999"]')).not.toBeNull();
});
