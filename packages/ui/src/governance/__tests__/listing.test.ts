import { describe, expect, it, vi } from "vitest";
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  isAddressEqual,
  multicall3Abi,
  type Hex,
} from "viem";
import { deployment, governanceChain } from "../deployment";
import { pluginAbi } from "../contracts";
import {
  mergeProposalIds,
  nextProposalIdPage,
  proposalIdPageSize,
  proposalIndex,
  readProposalIdPage,
  type GovernanceClient,
  type ProposalIdPage,
} from "../rpc";

// Matches the plugin's layout: start date, end date and creation counter.
const idAt = (index: bigint) => (1_793_819_956n << 128n) | (1_793_820_256n << 64n) | index;

function mockClient(count: bigint) {
  return {
    readContract: vi.fn().mockResolvedValue(count),
    multicall: vi.fn(async ({ contracts }: { contracts: { args: [bigint] }[] }) =>
      contracts.map((c) => idAt(c.args[0]))
    ),
  };
}
const asClient = (client: object) => client as unknown as GovernanceClient;

async function readAll(client: GovernanceClient) {
  const pages: ProposalIdPage[] = [];
  let param: { page: number; count?: bigint } | undefined = { page: 0 };
  while (param) {
    const page = await readProposalIdPage(param.page, param.count, client);
    pages.push(page);
    param = nextProposalIdPage(page, param.page);
  }
  return pages;
}

describe("onchain proposal listing", () => {
  it("lists nothing, without ID reads, when no proposal exists", async () => {
    const client = mockClient(0n);
    const pages = await readAll(asClient(client));
    expect(pages).toEqual([{ count: 0n, ids: [] }]);
    expect(client.readContract).toHaveBeenCalledTimes(1);
    expect(client.readContract.mock.calls[0][0]).toMatchObject({
      address: deployment.plugin,
      functionName: "proposalCount",
    });
    expect(client.multicall).not.toHaveBeenCalled();
  });

  it("lists a single proposal", async () => {
    const client = mockClient(1n);
    const pages = await readAll(asClient(client));
    expect(pages).toEqual([{ count: 1n, ids: [idAt(0n).toString()] }]);
    expect(client.multicall).toHaveBeenCalledTimes(1);
    expect(client.multicall.mock.calls[0][0]).toMatchObject({
      allowFailure: false,
      contracts: [{ address: deployment.plugin, functionName: "proposalIds", args: [0n] }],
    });
  });

  it("pages many proposals newest first, reading the count once", async () => {
    const client = mockClient(45n);
    const pages = await readAll(asClient(client));
    expect(pages.map((p) => p.ids.length)).toEqual([20, 20, 5]);
    const indexes = pages.flatMap((p) => p.ids).map((id) => proposalIndex(BigInt(id)));
    expect(indexes).toEqual(Array.from({ length: 45 }, (_, i) => BigInt(44 - i)));
    expect(client.readContract).toHaveBeenCalledTimes(1);
    expect(client.multicall).toHaveBeenCalledTimes(3);
    for (const [call] of client.multicall.mock.calls) expect(call.contracts.length).toBeLessThanOrEqual(20);
  });

  it("stops at an exact page boundary", async () => {
    const client = mockClient(BigInt(proposalIdPageSize));
    const pages = await readAll(asClient(client));
    expect(pages).toHaveLength(1);
    expect(pages[0].ids).toHaveLength(proposalIdPageSize);
  });

  it("sends each page as one eth_call to the chain's Multicall3", async () => {
    const requests: { method: string; params: unknown }[] = [];
    const multicall3 = governanceChain.contracts.multicall3.address;
    const client = createPublicClient({
      chain: governanceChain,
      transport: custom({
        async request({ method, params }) {
          requests.push({ method, params });
          if (method === "eth_chainId") return `0x${deployment.chainId.toString(16)}`;
          if (method !== "eth_call") throw new Error(`unexpected ${method}`);
          const [{ to, data }] = params as [{ to: Hex; data: Hex }];
          if (isAddressEqual(to, deployment.plugin))
            return encodeAbiParameters([{ type: "uint256" }], [3n * BigInt(proposalIdPageSize)]);
          expect(isAddressEqual(to, multicall3)).toBe(true);
          const { args } = decodeFunctionData({ abi: multicall3Abi, data });
          const calls = (args as readonly [readonly { target: Hex; callData: Hex }[]])[0];
          const results = calls.map(({ target, callData }) => {
            expect(isAddressEqual(target, deployment.plugin)).toBe(true);
            const decoded = decodeFunctionData({ abi: pluginAbi, data: callData });
            expect(decoded.functionName).toBe("proposalIds");
            const index = (decoded.args as [bigint])[0];
            return { success: true, returnData: encodeAbiParameters([{ type: "uint256" }], [idAt(index)]) };
          });
          // A single array output must be wrapped, or viem reads it as the output list.
          return encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: [results] as never });
        },
      }),
    });
    const page = await readProposalIdPage(1, undefined, client as unknown as GovernanceClient);
    expect(page.ids.map((id) => proposalIndex(BigInt(id)))).toEqual(
      Array.from({ length: 20 }, (_, i) => BigInt(39 - i))
    );
    expect(requests.filter((r) => r.method === "eth_call")).toHaveLength(2);
  });

  it("surfaces RPC failures instead of an empty list", async () => {
    const countFails = mockClient(0n);
    countFails.readContract.mockRejectedValue(new Error("HTTP request failed"));
    await expect(readProposalIdPage(0, undefined, asClient(countFails))).rejects.toThrow("HTTP request failed");

    const idsFail = mockClient(3n);
    idsFail.multicall.mockRejectedValue(new Error("execution reverted"));
    await expect(readProposalIdPage(0, undefined, asClient(idsFail))).rejects.toThrow("execution reverted");

    const lagging = mockClient(2n);
    lagging.multicall.mockResolvedValue([0n, idAt(0n)]);
    await expect(readProposalIdPage(0, undefined, asClient(lagging))).rejects.toThrow("incomplete");
  });
});

describe("merging listed and imported proposals", () => {
  const ids = (...indexes: number[]) => indexes.map((i) => idAt(BigInt(i)).toString());

  it("deduplicates imported IDs that the chain already listed, newest first", () => {
    expect(mergeProposalIds(ids(4, 3, 2, 1, 0), ids(1, 3), true)).toEqual(ids(4, 3, 2, 1, 0));
    expect(mergeProposalIds(ids(2, 1), ids(1, 1, 2), true)).toEqual(ids(2, 1));
  });

  it("holds back imported IDs older than the loaded pages until their page loads", () => {
    expect(mergeProposalIds(ids(9, 8, 7), ids(8, 2), false)).toEqual(ids(9, 8, 7));
    expect(mergeProposalIds(ids(9, 8, 7), ids(8, 2), true)).toEqual(ids(9, 8, 7, 2));
  });

  it("keeps imported proposals visible when the chain listing is unavailable", () => {
    expect(mergeProposalIds([], ids(0, 5, 3), false)).toEqual(ids(5, 3, 0));
  });

  it("orders by creation counter rather than by the timestamps in the high bits", () => {
    const older = ((2_000_000_000n << 128n) | 0n).toString();
    const newer = ((1_000_000_000n << 128n) | 1n).toString();
    expect(mergeProposalIds([older], [newer], true)).toEqual([newer, older]);
  });
});
