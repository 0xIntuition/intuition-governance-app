import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, zeroAddress } from "viem";
import { daoPermissionsAbi, pluginAbi, proposerPermissionId } from "../contracts";
import { deployment } from "../deployment";
import { decodeAction, type GovernanceClient } from "../rpc";
import { makeProposalPlan, prepareProposal, type ProposalDraft } from "../proposing";

const draft: ProposalDraft = { kind: "test", proposer: deployment.manager, metadata: "", duration: "120", actions: [] };
function client(permission = true, minDuration = 120) {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case "dao":
        return deployment.dao;
      case "votingToken":
        return deployment.adapter;
      case "trustBonding":
        return deployment.trustBonding;
      case "governanceSettings":
        return [200000, minDuration, 0, 0, 0, true];
      case "getMinDelay":
        return 120n;
      case "hasPermission":
        return permission;
      default:
        throw new Error("Unexpected call");
    }
  });
  return {
    getChainId: vi.fn(async (): Promise<number> => deployment.chainId),
    getCode: vi.fn(async () => "0x01"),
    readContract,
    simulateContract: vi.fn(async () => ({ result: 123n })),
  };
}
describe("proposal construction", () => {
  it("bounds the aggregate calldata to fit local receipt storage", () => {
    const action = { to: deployment.multiVault, value: "0", data: "0x" + "aa".repeat(40000) };
    expect(() => makeProposalPlan({ ...draft, kind: "calls", actions: [action, action] }, 120n)).toThrow(
      "combined action calldata"
    );
  });
  it("builds a no-action proposal with an enforced all-actions-must-succeed map", () => {
    const plan = makeProposalPlan(draft, 120n);
    expect(decodeFunctionData({ abi: pluginAbi, data: plan.data })).toMatchObject({
      functionName: "createProposal",
      args: ["0x", [], 0n, 120n],
    });
  });
  it("grants only the deployed plugin's proposer permission through a DAO action", () => {
    const plan = makeProposalPlan({ ...draft, kind: "proposer" }, 120n);
    const action = plan.args[1][0];
    expect(action.to).toBe(deployment.dao);
    expect(action.value).toBe(0n);
    expect(decodeFunctionData({ abi: daoPermissionsAbi, data: action.data })).toEqual({
      functionName: "grant",
      args: [deployment.plugin, deployment.manager, proposerPermissionId],
    });
    expect(decodeAction(action).name).toContain("Grant proposer access");
    expect(decodeAction({ ...action, to: deployment.manager }).name).toBe("Contract call (unrecognized)");
    expect(decodeAction({ ...action, value: 1n }).name).toBe("Contract call (unrecognized)");
  });
  it.each([zeroAddress, "0xffffffffffffffffffffffffffffffffffffffff", "0x123", deployment.manager.slice(0, -1) + "e"])(
    "rejects invalid or broad proposer address %s",
    (proposer) => {
      expect(() => makeProposalPlan({ ...draft, kind: "proposer", proposer }, 120n)).toThrow();
    }
  );
  it.each(["119", "0", "-1", "1.5", "1e3", "31536001"])("rejects invalid duration %s", (duration) => {
    expect(() => makeProposalPlan({ ...draft, duration }, 120n)).toThrow();
  });
  it("preserves action order and full token precision", () => {
    const actions = [
      { to: deployment.multiVault, value: "0.000000000000000001", data: "0x1234" },
      { to: deployment.manager, value: "0", data: "0x" },
    ];
    const plan = makeProposalPlan({ ...draft, kind: "calls", actions }, 120n);
    expect(plan.args[1]).toEqual([
      { ...actions[0], value: 1n },
      { ...actions[1], value: 0n },
    ]);
  });
  it.each([
    { value: "-1", data: "0x" },
    { value: "0.0000000000000000001", data: "0x" },
    { value: "0", data: "0x123" },
    { value: "0", data: "1234" },
  ])("rejects invalid contract-call inputs %j", (action) => {
    expect(() =>
      makeProposalPlan({ ...draft, kind: "calls", actions: [{ to: deployment.multiVault, ...action }] }, 120n)
    ).toThrow();
  });
  it("rejects empty contract-call batches and unsafe metadata schemes", () => {
    expect(() => makeProposalPlan({ ...draft, kind: "calls" }, 120n)).toThrow();
    expect(() => makeProposalPlan({ ...draft, metadata: "javascript:alert(1)" }, 120n)).toThrow();
  });
});
describe("proposal preflight", () => {
  it("checks exact calldata permissions and simulates against pending state", async () => {
    const rpc = client();
    await prepareProposal(deployment.manager, draft, rpc as unknown as GovernanceClient);
    expect(rpc.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "hasPermission",
        args: [deployment.plugin, deployment.manager, proposerPermissionId, makeProposalPlan(draft, 120n).data],
        blockTag: "pending",
      })
    );
    expect(rpc.simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: "createProposal",
        account: deployment.manager,
        args: makeProposalPlan(draft, 120n).args,
        blockTag: "pending",
      })
    );
  });
  it("rejects revoked permissions before simulation", async () => {
    const rpc = client(false);
    await expect(prepareProposal(deployment.manager, draft, rpc as unknown as GovernanceClient)).rejects.toThrow(
      "does not have permission"
    );
    expect(rpc.simulateContract).not.toHaveBeenCalled();
  });
  it("rechecks changed duration requirements", async () => {
    const rpc = client(true, 300);
    await expect(prepareProposal(deployment.manager, draft, rpc as unknown as GovernanceClient)).rejects.toThrow("300");
    expect(rpc.simulateContract).not.toHaveBeenCalled();
  });
  it("fails closed on the wrong RPC chain and bubbles simulation failures", async () => {
    const rpc = client();
    rpc.getChainId.mockResolvedValueOnce(1);
    await expect(prepareProposal(deployment.manager, draft, rpc as unknown as GovernanceClient)).rejects.toThrow(
      "different chain"
    );
    rpc.simulateContract.mockRejectedValueOnce(new Error("NoVotingPower"));
    await expect(prepareProposal(deployment.manager, draft, rpc as unknown as GovernanceClient)).rejects.toThrow(
      "NoVotingPower"
    );
  });
});
