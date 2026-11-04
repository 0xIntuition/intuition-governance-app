import { expect, it } from "vitest";
import { fixtureTransactions } from "../deployment";
import { decodeStoredEvents } from "../events";
import { fetchReceipt, readProposal, verifyDeployment } from "../rpc";

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
