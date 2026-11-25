import { describe, expect, it, vi } from "vitest";
import { deployment } from "../deployment";
import { metadataLink, readProposalCreator, type GovernanceClient } from "../rpc";

const id = (1_793_819_956n << 128n) | (1_793_820_256n << 64n) | 11n;
const creator = "0x54C15B56800235F273bb659aea820c9D3112B3FD";
const start = deployment.deploymentBlock;
const head = start + 100_000n;

// Counts sequential RPC rounds: a read that starts while none is in flight opens a new round.
function timed(read: (blockNumber: bigint) => bigint) {
  const state = { rounds: 0, pending: 0 };
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
    if (state.pending++ === 0) state.rounds++;
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.pending--;
    return { timestamp: read(blockNumber) };
  });
  return { getBlock, state };
}

// A chain where block `start + n` has timestamp 1000 + n / 4: four blocks share each second.
function chain(logs: unknown[] | Error = [{ args: { proposalId: id, creator } }]) {
  const { getBlock, state } = timed((blockNumber) => 1000n + (blockNumber - start) / 4n);
  const getLogs = logs instanceof Error ? vi.fn().mockRejectedValue(logs) : vi.fn().mockResolvedValue(logs);
  const client = { getBlockNumber: vi.fn().mockResolvedValue(head), getBlock, getLogs };
  return { state, getLogs, client: client as unknown as GovernanceClient };
}

describe("readProposalCreator", () => {
  it("reads the creation log only from the blocks at the creation timestamp", async () => {
    const { state, getLogs, client } = chain();
    // Created at second 2000, so its snapshot is 1999 and blocks start+4000..start+4003 match.
    await expect(readProposalCreator(id, 1999n, client)).resolves.toBe(creator);
    expect(getLogs).toHaveBeenCalledTimes(1);
    expect(getLogs).toHaveBeenCalledWith(
      expect.objectContaining({ args: { proposalId: id }, fromBlock: start + 4000n, toBlock: start + 4003n })
    );
    // 100,000 blocks: ends, 6 narrowing rounds, the bracket round and 1 more, versus ~20 for bisection.
    expect(state.rounds).toBeLessThanOrEqual(9);
  });

  it("finds the exact creation blocks when block times are uneven", async () => {
    // Bursts and long idle gaps, like a chain that makes blocks only on traffic.
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const times: bigint[] = [];
    let time = 1000n;
    for (let i = 0; i < 20_000; i++) {
      const r = random();
      time += r < 0.6 ? 0n : r < 0.95 ? 1n : BigInt(Math.floor(random() * 50_000));
      times.push(time);
    }
    const { getBlock, state } = timed((blockNumber) => times[Number(blockNumber - start)]);
    const getLogs = vi.fn().mockResolvedValue([{ args: { proposalId: id, creator } }]);
    const client = {
      getBlockNumber: vi.fn().mockResolvedValue(start + BigInt(times.length - 1)),
      getBlock,
      getLogs,
    } as unknown as GovernanceClient;
    for (const index of [1, 777, 5_000, 12_345, 19_998]) {
      const created = times[index];
      const first = times.indexOf(created);
      const last = times.lastIndexOf(created);
      getLogs.mockClear();
      getBlock.mockClear();
      state.rounds = 0;
      await expect(readProposalCreator(id, created - 1n, client)).resolves.toBe(creator);
      expect(getLogs).toHaveBeenCalledWith(
        expect.objectContaining({ fromBlock: start + BigInt(first), toBlock: start + BigInt(last) })
      );
      // Uneven spacing does not slow the search: 20,000 blocks take at most 8 rounds.
      expect(state.rounds).toBeLessThanOrEqual(8);
    }
  });

  // A chain given as one timestamp per block from the deployment block to the head.
  function chainOf(times: bigint[]) {
    const { getBlock } = timed((blockNumber) => times[Number(blockNumber - start)]);
    const getLogs = vi.fn().mockResolvedValue([{ args: { proposalId: id, creator } }]);
    const client = { getBlockNumber: vi.fn().mockResolvedValue(start + BigInt(times.length - 1)), getBlock, getLogs };
    return { getLogs, client: client as unknown as GovernanceClient };
  }

  it("stops the window before a later block even when it is the head", async () => {
    const { getLogs, client } = chainOf([100n, 100n, 100n, 102n]);
    await expect(readProposalCreator(id, 99n, client)).resolves.toBe(creator);
    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: start, toBlock: start + 2n }));
  });

  it("finds a long run of equal timestamps that ends far before the head", async () => {
    const times = [...Array<bigint>(600).fill(100n), ...Array.from({ length: 1_000 }, (_, i) => 200n + BigInt(i))];
    const { getLogs, client } = chainOf([50n, ...times]);
    await expect(readProposalCreator(id, 99n, client)).resolves.toBe(creator);
    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: start + 1n, toBlock: start + 600n }));
  });

  it("returns null without reading logs when no block has the creation timestamp", async () => {
    const { getLogs, client } = chainOf([100n, 110n, 120n, 130n]);
    await expect(readProposalCreator(id, 114n, client)).resolves.toBeNull();
    await expect(readProposalCreator(id, 10n, client)).resolves.toBeNull();
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("returns null when no block has the creation timestamp yet", async () => {
    const { getLogs, client } = chain();
    await expect(readProposalCreator(id, 10n ** 9n, client)).resolves.toBeNull();
    expect(getLogs).not.toHaveBeenCalled();
  });

  it("returns null when the log is not in those blocks", async () => {
    await expect(readProposalCreator(id, 1999n, chain([]).client)).resolves.toBeNull();
  });

  it("returns null when the RPC fails", async () => {
    await expect(readProposalCreator(id, 1999n, chain(new Error("RPC down")).client)).resolves.toBeNull();
  });
});

describe("metadataLink", () => {
  it("links https and ipfs references and leaves anything else as text", () => {
    expect(metadataLink("https://example.com/p.json")).toBe("https://example.com/p.json");
    expect(metadataLink("ipfs://bafyabc")).toBe("https://ipfs.io/ipfs/bafyabc");
    expect(metadataLink("http://example.com")).toBeUndefined();
    expect(metadataLink("javascript:alert(1)")).toBeUndefined();
    expect(metadataLink("plain note")).toBeUndefined();
  });
});
