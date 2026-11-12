import { expect, it } from "vitest";
import { fixtureTransactions } from "../deployment";
import { decodeStoredEvents } from "../events";
import {
  fetchReceipt,
  nextProposalIdPage,
  proposalIndex,
  readProposal,
  readProposalIdPage,
  verifyDeployment,
} from "../rpc";

// Opt-in, read-only RPC check. Does not open a browser, simulate writes or send transactions.
it.runIf(process.env.CHECK_GOVERNANCE_RPC === "1")(
  "reads the deployed testnet route and fixture proposals",
  async () => {
    const { settings, timelockDelay } = await verifyDeployment();
    expect(settings[0]).toBe(200000);
    expect(settings[1]).toBe(120);
    expect(settings[5]).toBe(true);
    expect(timelockDelay).toBe(120n);
    const rows = [];
    for (const hash of fixtureTransactions.slice(0, 4)) {
      const receipt = await fetchReceipt(hash);
      const creation = decodeStoredEvents(receipt).find((event) => event.name === "ProposalCreated")!;
      expect(creation).toBeDefined();
      const proposal = await readProposal(BigInt(creation.proposalId!));
      expect(proposal.result[5]).toHaveLength(1);
      expect(proposal.supply).toBeGreaterThan(0n);
      rows.push({
        proposal: creation.proposalId,
        status: proposal.status,
        snapshot: proposal.result[2].snapshotTimestamp.toString(),
      });
    }
    console.info("Verified testnet fixtures:", rows);
  },
  180_000
);

it.runIf(process.env.CHECK_GOVERNANCE_RPC === "1")(
  "enumerates every testnet proposal through Multicall3",
  async () => {
    const ids: string[] = [];
    let param: { page: number; count?: bigint } | undefined = { page: 0 };
    let count = 0n;
    while (param) {
      const page = await readProposalIdPage(param.page, param.count);
      count = page.count;
      ids.push(...page.ids);
      param = nextProposalIdPage(page, param.page);
    }
    expect(count).toBeGreaterThanOrEqual(6n);
    expect(ids).toHaveLength(Number(count));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.map((id) => proposalIndex(BigInt(id)))).toEqual(
      Array.from({ length: Number(count) }, (_, i) => count - 1n - BigInt(i))
    );
    const created = [];
    for (const hash of fixtureTransactions) {
      const receipt = await fetchReceipt(hash);
      created.push(
        ...decodeStoredEvents(receipt).flatMap((e) => (e.name === "ProposalCreated" ? [e.proposalId!] : []))
      );
    }
    expect(created.length).toBeGreaterThan(0);
    for (const id of created) expect(ids).toContain(id);
    console.info(`Enumerated ${ids.length} testnet proposals; ${created.length} fixture creations are listed.`);
  },
  180_000
);
