import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, parseEther } from "viem";
import { deployment } from "../deployment";
import { type GovernanceClient } from "../rpc";
import {
  canWithdraw,
  DAY,
  WEEK,
  makeLockPlan,
  parseLockAmount,
  prepareLockTransaction,
  readLockState,
  sameLockIntent,
  trustBondingAbi,
  wrappedTrustAbi,
  type LockState,
} from "../locking";

const state: LockState = {
  timestamp: 1793820700n,
  minTime: 14n * DAY,
  maxTime: 730n * DAY,
  account: deployment.manager,
  nativeBalance: parseEther("1"),
  wrappedBalance: 0n,
  allowance: 0n,
  lockedAmount: 0n,
  lockEnd: 0n,
  votingPower: 0n,
  paused: false,
  unlocked: false,
  walletAllowed: true,
};

describe("lock inputs and state transitions", () => {
  it("keeps decimal precision and rejects silent rounding, exponents, negatives and zero", () => {
    expect(parseLockAmount("0.000000000000000001")).toBe(1n);
    expect(parseLockAmount("0.123456789012345678")).toBe(123456789012345678n);
    for (const value of ["0", "-1", "1e3", "1,000", ".5", "0.0000000000000000001", "9".repeat(39)])
      expect(() => parseLockAmount(value)).toThrow();
  });
  it("rounds the actual unlock time down and applies the minimum after rounding", () => {
    const plan = makeLockPlan(state, "0.01", "30");
    expect(plan.unlockTime % WEEK).toBe(0n);
    expect(plan.unlockTime).toBe(((state.timestamp + 30n * DAY) / WEEK) * WEEK);
    expect(plan.unlockTime).toBeGreaterThanOrEqual(state.timestamp + state.minTime);
    expect(() => makeLockPlan(state, "0.01", "14")).toThrow("rounded unlock date");
    expect(() => makeLockPlan(state, "0.01", "740")).toThrow("maximum");
    expect(() => makeLockPlan(state, "0.01", "30.5")).toThrow("whole number");
  });
  it("wraps only the shortfall and resumes from actual balances and allowance", () => {
    const initial = { ...state, wrappedBalance: parseEther("0.003") };
    const wrap = makeLockPlan(initial, "0.01", "30");
    expect(wrap.step).toBe("wrap");
    expect(wrap.wrapAmount).toBe(parseEther("0.007"));
    const funded = { ...initial, wrappedBalance: parseEther("0.01") };
    expect(makeLockPlan(funded, "0.01", "30").step).toBe("approve");
    const approved = { ...funded, allowance: parseEther("0.01") };
    expect(makeLockPlan(approved, "0.01", "30").step).toBe("lock");
    expect(makeLockPlan({ ...approved, allowance: parseEther("0.009") }, "0.01", "30").step).toBe("approve");
  });
  it("preserves existing lock dates and matches integer voting-power math", () => {
    const existing = { ...state, lockedAmount: parseEther("0.02"), lockEnd: state.timestamp + 100n * DAY };
    const plan = makeLockPlan(existing, "0.01", "invalid unused days");
    expect(plan.mode).toBe("add");
    expect(plan.unlockTime).toBe(existing.lockEnd);
    expect(plan.estimatedPower).toBe((parseEther("0.03") / state.maxTime) * (100n * DAY));
  });
  it("rejects paused, globally unlocked, expired and ineligible-wallet deposits", () => {
    for (const overrides of [
      { paused: true },
      { unlocked: true },
      { walletAllowed: false },
      { account: undefined },
      { lockedAmount: 1n, lockEnd: state.timestamp },
    ])
      expect(() => makeLockPlan({ ...state, ...overrides }, "0.01", "30")).toThrow();
  });
  it("does not spend the whole native balance or ignore gas when wrapped tokens suffice", () => {
    expect(() => makeLockPlan(state, "1", "30")).toThrow("transaction fees");
    expect(() => makeLockPlan({ ...state, nativeBalance: 0n, wrappedBalance: parseEther("1") }, "0.01", "30")).toThrow(
      "transaction fees"
    );
  });
  it("permits withdrawal at expiry or global unlock, including while paused", () => {
    expect(canWithdraw(state)).toBe(false);
    expect(canWithdraw({ ...state, lockedAmount: 1n, lockEnd: state.timestamp + 1n })).toBe(false);
    expect(canWithdraw({ ...state, lockedAmount: 1n, lockEnd: state.timestamp, paused: true })).toBe(true);
    expect(canWithdraw({ ...state, lockedAmount: 1n, lockEnd: state.timestamp + 1n, unlocked: true })).toBe(true);
  });
  it("requires review when balances, approval stage or actual unlock date change", () => {
    const plan = makeLockPlan(state, "0.01", "30");
    expect(sameLockIntent(plan, makeLockPlan(state, "0.01", "30"))).toBe(true);
    for (const change of [
      { wrapAmount: 1n },
      { unlockTime: plan.unlockTime + WEEK },
      { step: "approve" as const },
      { mode: "add" as const },
    ])
      expect(sameLockIntent(plan, { ...plan, ...change })).toBe(false);
  });
});

describe("transaction preparation", () => {
  const simulatedClient = () => {
    const simulateContract = vi.fn().mockImplementation(async (request) => ({ request, result: true }));
    return { simulateContract, client: { simulateContract } as unknown as GovernanceClient };
  };
  it("simulates wrapping on pending, sending only the native shortfall to the pinned token", async () => {
    const { client, simulateContract } = simulatedClient();
    const plan = makeLockPlan({ ...state, wrappedBalance: parseEther("0.004") }, "0.01", "30");
    const tx = await prepareLockTransaction(state, plan, client);
    expect(tx.to).toBe(deployment.wrappedTrust);
    expect(tx.value).toBe(parseEther("0.006"));
    expect(decodeFunctionData({ abi: wrappedTrustAbi, data: tx.data }).functionName).toBe("deposit");
    expect(simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({ account: state.account, blockTag: "pending" })
    );
  });
  it("approves only the entered amount to the configured TrustBonding spender", async () => {
    const { client } = simulatedClient();
    const funded = { ...state, wrappedBalance: parseEther("1") };
    const tx = await prepareLockTransaction(funded, makeLockPlan(funded, "0.01", "30"), client);
    expect(tx.to).toBe(deployment.wrappedTrust);
    expect(tx.value).toBe(0n);
    expect(decodeFunctionData({ abi: wrappedTrustAbi, data: tx.data })).toEqual({
      functionName: "approve",
      args: [deployment.trustBonding, parseEther("0.01")],
    });
  });
  it("creates or tops up exactly the simulated lock without native value", async () => {
    const { client } = simulatedClient();
    const funded = { ...state, wrappedBalance: parseEther("1"), allowance: parseEther("1") };
    const plan = makeLockPlan(funded, "0.01", "30");
    const tx = await prepareLockTransaction(funded, plan, client);
    expect(tx.to).toBe(deployment.trustBonding);
    expect(tx.value).toBe(0n);
    expect(decodeFunctionData({ abi: trustBondingAbi, data: tx.data })).toEqual({
      functionName: "create_lock",
      args: [plan.amount, plan.unlockTime],
    });
    const existing = { ...funded, lockedAmount: 1n, lockEnd: state.timestamp + 30n * DAY };
    const topup = await prepareLockTransaction(existing, makeLockPlan(existing, "0.01", "30"), client);
    expect(decodeFunctionData({ abi: trustBondingAbi, data: topup.data })).toEqual({
      functionName: "increase_amount",
      args: [plan.amount],
    });
  });
  it("stops on failed simulation or false token approval, and never prepares an early withdrawal", async () => {
    const { client, simulateContract } = simulatedClient();
    await expect(prepareLockTransaction(state, "withdraw", client)).rejects.toThrow("not expired");
    expect(simulateContract).not.toHaveBeenCalled();
    const funded = { ...state, wrappedBalance: parseEther("1") };
    simulateContract.mockImplementation(async (request) => ({ request, result: false }));
    await expect(prepareLockTransaction(funded, makeLockPlan(funded, "0.01", "30"), client)).rejects.toThrow(
      "did not accept"
    );
    simulateContract.mockRejectedValue(new Error("execution reverted"));
    await expect(prepareLockTransaction(state, makeLockPlan(state, "0.01", "30"), client)).rejects.toThrow("reverted");
  });
});

it("rejects a different RPC chain or token identity before reading wallet funds", async () => {
  const client = {
    getChainId: vi.fn().mockResolvedValue(1),
    getCode: vi.fn().mockResolvedValue("0x1234"),
    readContract: vi.fn().mockResolvedValue(deployment.dao),
    getBalance: vi.fn(),
  };
  await expect(readLockState(state.account, client as unknown as GovernanceClient)).rejects.toThrow("testnet RPC");
  client.getChainId.mockResolvedValue(deployment.chainId);
  await expect(readLockState(state.account, client as unknown as GovernanceClient)).rejects.toThrow(
    "configuration changed"
  );
  expect(client.getBalance).not.toHaveBeenCalled();
});

it.runIf(process.env.CHECK_GOVERNANCE_RPC === "1")(
  "reads live core links, balances and lock limits without broadcasting",
  async () => {
    const live = await readLockState(deployment.manager);
    expect(live.minTime).toBe(14n * DAY);
    expect(live.maxTime).toBe(730n * DAY);
    expect(live.lockedAmount).toBeGreaterThan(0n);
    expect(live.lockEnd).toBeGreaterThan(live.timestamp);
    expect(live.walletAllowed).toBe(true);
  },
  120_000
);
