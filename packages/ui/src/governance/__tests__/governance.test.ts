import { describe, expect, it, vi } from "vitest";
import { encodeFunctionData, type Address, type Hex, type TransactionReceipt } from "viem";
import logs from "./fixtures/plugin-logs.json";
import { decodeStoredEvents, normalizeReceipt, parseTransactionHash, receiptSchema } from "../events";
import { clearReceipts, loadReceipts, removeReceipt, saveReceipt, storagePrefix } from "../storage";
import { decodeAction, fetchReceipt, proposalStatus, readProposal, vetoThreshold, type GovernanceClient } from "../rpc";
import { deployment, fixtureTransactions } from "../deployment";
import { timelockAbi, proxyAdminAbi } from "../contracts";

const HASH = fixtureTransactions[0];
function receiptFor(hash: string = HASH) {
  const matching = logs.filter((l) => l.transactionHash === hash);
  const first = matching[0];
  return {
    status: "success",
    transactionHash: hash,
    blockHash: first.blockHash,
    blockNumber: BigInt(first.blockNumber),
    transactionIndex: Number(first.transactionIndex),
    logs: matching.map((l) => ({ ...l, logIndex: Number(l.logIndex) })),
  } as unknown as TransactionReceipt;
}
class MemoryStorage implements Storage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

describe("deployed receipt import", () => {
  it("decodes real creation, veto and execution receipts without losing proposal integer precision", () => {
    const events = fixtureTransactions.flatMap((hash) => decodeStoredEvents(normalizeReceipt(receiptFor(hash))));
    expect(events.filter((e) => e.name === "ProposalCreated")).toHaveLength(4);
    expect(events.filter((e) => e.name === "VetoCast")).toHaveLength(2);
    expect(events.filter((e) => e.name === "ProposalExecuted")).toHaveLength(1);
    expect(events[0].proposalId).toBe("610405300457693690041668389091439876825658949632");
    expect(events[0].creator?.toLowerCase()).toBe(deployment.manager.toLowerCase());
  });
  it("ignores unrelated Safe logs but rejects receipts with only a foreign emitter", () => {
    const original = receiptFor();
    const foreign = { ...original.logs[0], address: "0x0000000000000000000000000000000000001234" as Address };
    expect(decodeStoredEvents(normalizeReceipt({ ...original, logs: [foreign, ...original.logs] }))).toHaveLength(1);
    expect(() => normalizeReceipt({ ...original, logs: [foreign] })).toThrow();
  });
  it("rejects reverted transactions, malformed hashes and corrupt supported event payloads", () => {
    expect(() => normalizeReceipt({ ...receiptFor(), status: "reverted" })).toThrow("reverted");
    expect(() => parseTransactionHash("https://example.com/tx/" + HASH)).toThrow("transaction hash");
    expect(() => normalizeReceipt({ ...receiptFor(), logs: [{ ...receiptFor().logs[0], data: "0x" }] })).toThrow();
  });
  it("rejects wrong RPC chains and noncanonical receipts", async () => {
    const client = {
      getChainId: vi.fn().mockResolvedValue(1),
      getTransactionReceipt: vi.fn().mockResolvedValue(receiptFor()),
      getBlock: vi.fn().mockResolvedValue({ hash: "0xwrong" }),
    };
    await expect(fetchReceipt(HASH, client as unknown as GovernanceClient)).rejects.toThrow("chain");
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
    client.getChainId.mockResolvedValue(deployment.chainId);
    await expect(fetchReceipt(HASH, client as unknown as GovernanceClient)).rejects.toThrow("canonical");
  });
  it("does not treat missing receipts as a successful import", async () => {
    const client = {
      getChainId: vi.fn().mockResolvedValue(deployment.chainId),
      getTransactionReceipt: vi.fn().mockRejectedValue(new Error("Transaction not found")),
    };
    await expect(fetchReceipt(HASH, client as unknown as GovernanceClient)).rejects.toThrow("not found");
  });
});

describe("browser-local receipts", () => {
  it("survives reload, deduplicates reimports and handles out-of-order events", () => {
    const storage = new MemoryStorage();
    saveReceipt(storage, normalizeReceipt(receiptFor(fixtureTransactions[6])));
    saveReceipt(storage, normalizeReceipt(receiptFor()));
    saveReceipt(storage, normalizeReceipt(receiptFor()));
    expect(storage.length).toBe(2);
    const read = loadReceipts(storage);
    expect(read.warnings).toEqual([]);
    expect(read.receipts.flatMap(decodeStoredEvents).map((e) => e.name)).toEqual([
      "ProposalExecuted",
      "ProposalCreated",
    ]);
    expect(storagePrefix).not.toContain("BUILD");
    expect(read.receipts.find((r) => r.transactionHash === HASH)).toEqual(normalizeReceipt(receiptFor()));
  });
  it("isolates deployments and preserves unrelated storage on clear", () => {
    const storage = new MemoryStorage();
    storage.setItem("another-chain:import", "leave-me");
    saveReceipt(storage, normalizeReceipt(receiptFor()));
    clearReceipts(storage);
    expect(storage.getItem("another-chain:import")).toBe("leave-me");
    expect(loadReceipts(storage).receipts).toEqual([]);
    expect(() => receiptSchema.parse({ ...normalizeReceipt(receiptFor()), chainId: 1155 })).toThrow();
  });
  it("reports corrupted records and failed writes without discarding valid history", () => {
    const storage = new MemoryStorage();
    saveReceipt(storage, normalizeReceipt(receiptFor()));
    storage.setItem(storagePrefix + "broken", "{");
    expect(loadReceipts(storage).receipts).toHaveLength(1);
    expect(loadReceipts(storage).warnings).toHaveLength(1);
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => saveReceipt(storage, normalizeReceipt(receiptFor(fixtureTransactions[1])))).toThrow(
      "could not be saved"
    );
    expect(loadReceipts(storage).receipts).toHaveLength(1);
    removeReceipt(storage, HASH);
    expect(loadReceipts(storage).receipts).toHaveLength(0);
  });
});

describe("voting and decoding", () => {
  it("rounds the veto threshold up and uses contract booleans for status", () => {
    expect(vetoThreshold(6n, 200000)).toBe(2n);
    expect(vetoThreshold(10n ** 30n + 1n, 200000)).toBe(2n * 10n ** 29n + 1n);
    expect(proposalStatus(true, true, false, false)).toBe("Executed");
    expect(proposalStatus(false, true, false, false)).toBe("Vetoed");
    expect(proposalStatus(false, false, true, false)).toBe("Active");
    expect(proposalStatus(false, false, false, true)).toBe("Executable");
    expect(proposalStatus(false, false, true, true)).toBe("Executable");
  });
  it("pins confirmed state to one block and evaluates execution at pending", async () => {
    const snapshot = 1793810000n;
    const client = {
      getBlock: vi.fn().mockResolvedValue({ number: 123n, timestamp: snapshot + 10n }),
      readContract: vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => {
        if (functionName === "getProposal")
          return [
            true,
            false,
            { snapshotTimestamp: snapshot, vetoEndDate: snapshot + 120n, minVetoRatio: 200000 },
            1n,
            "0x",
            [],
            0n,
          ];
        if (functionName === "getPastTotalSupply") return 6n;
        return false;
      }),
    };
    const proposal = await readProposal(1n, client as unknown as GovernanceClient);
    expect(proposal.threshold).toBe(2n);
    expect(
      client.readContract.mock.calls.every(([request]) =>
        request.functionName === "canExecute" ? request.blockTag === "pending" : request.blockNumber === 123n
      )
    ).toBe(true);
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "getPastTotalSupply", args: [snapshot] })
    );
  });
  it("expands known timelock upgrades and retains raw unknown calls", () => {
    const payload = encodeFunctionData({
      abi: proxyAdminAbi,
      functionName: "upgradeAndCall",
      args: [deployment.trustBonding, deployment.adapter, "0x"],
    });
    const data = encodeFunctionData({
      abi: timelockAbi,
      functionName: "execute",
      args: [deployment.proxyAdmin, 0n, payload, ("0x" + "00".repeat(32)) as Hex, ("0x" + "01".repeat(32)) as Hex],
    });
    const outer = decodeAction({ to: deployment.upgradesTimelock, value: 0n, data });
    expect(outer.operationId).toMatch(/^0x[0-9a-f]{64}$/);
    const inner = decodeAction(outer.children![0]);
    expect(inner.proxy).toBe(deployment.trustBonding);
    expect(inner.implementation).toBe(deployment.adapter);
    expect(decodeAction({ to: deployment.manager, value: 0n, data }).name).toContain("unrecognized");
  });
});
