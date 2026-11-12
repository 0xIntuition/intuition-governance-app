import { encodeFunctionData, isAddressEqual, parseAbi, parseUnits, type Abi, type Address, type Hex } from "viem";
import { deployment } from "./deployment";
import { governanceClient, type GovernanceClient } from "./rpc";

// ABI subset from intuition-contracts-v2 at 91c1a24: VotingEscrow and TrustBonding.
// The wrapping sequence matches governance/script/testnet/LockTrust.s.sol.
export const trustBondingAbi = parseAbi([
  "function token() view returns (address)",
  "function multiVault() view returns (address)",
  "function MINTIME() view returns (uint256)",
  "function MAXTIME() view returns (uint256)",
  "function paused() view returns (bool)",
  "function unlocked() view returns (bool)",
  "function contracts_whitelist(address) view returns (bool)",
  "function locked(address) view returns (int128 amount,uint256 end)",
  "function balanceOf(address) view returns (uint256)",
  "function create_lock(uint256 value,uint256 unlockTime)",
  "function increase_amount(uint256 value)",
  "function withdraw()",
]);
export const wrappedTrustAbi = parseAbi([
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner,address spender) view returns (uint256)",
  "function approve(address spender,uint256 amount) returns (bool)",
  "function deposit() payable",
]);
export const DAY = 86_400n;
export const WEEK = 7n * DAY;
export type LockState = {
  timestamp: bigint;
  minTime: bigint;
  maxTime: bigint;
  paused: boolean;
  unlocked: boolean;
  account?: Address;
  nativeBalance: bigint;
  wrappedBalance: bigint;
  allowance: bigint;
  lockedAmount: bigint;
  lockEnd: bigint;
  votingPower: bigint;
  walletAllowed: boolean;
};
export async function readLockState(
  account?: Address,
  client: GovernanceClient = governanceClient
): Promise<LockState> {
  if ((await client.getChainId()) !== deployment.chainId) throw new Error(`Connect to the ${deployment.name} RPC.`);
  const at = { address: deployment.trustBonding, abi: trustBondingAbi, blockTag: "pending" } as const;
  const tokenAt = { address: deployment.wrappedTrust, abi: wrappedTrustAbi, blockTag: "pending" } as const;
  // Independent reads run together; concurrent pending reads share one Multicall3 call.
  // The checks below keep their original order, so the first failure reported is unchanged.
  const reads = await Promise.allSettled([
    Promise.all(
      [deployment.trustBonding, deployment.wrappedTrust, deployment.multiVault].map((address) =>
        client.getCode({ address })
      )
    ),
    client.readContract({ ...at, functionName: "token" }),
    client.readContract({ ...at, functionName: "multiVault" }),
    client.readContract({ ...tokenAt, functionName: "decimals" }),
    client.readContract({ ...at, functionName: "MINTIME" }),
    client.readContract({ ...at, functionName: "MAXTIME" }),
    client.readContract({ ...at, functionName: "paused" }),
    client.readContract({ ...at, functionName: "unlocked" }),
    client.getBlock({ blockTag: "pending" }),
  ] as const);
  const value = <T>(read: PromiseSettledResult<T>) => {
    if (read.status === "rejected") throw read.reason;
    return read.value;
  };
  if (value(reads[0]).some((code) => !code || code === "0x"))
    throw new Error("A configured core contract is missing. Locking is unavailable.");
  const token = value(reads[1]);
  const multiVault = value(reads[2]);
  if (!isAddressEqual(token, deployment.wrappedTrust) || !isAddressEqual(multiVault, deployment.multiVault))
    throw new Error("The TrustBonding configuration changed. Locking is unavailable until the deployment is checked.");
  if (value(reads[3]) !== 18) throw new Error("The configured wrapped TRUST token has unsupported decimals.");
  const minTime = value(reads[4]);
  const maxTime = value(reads[5]);
  if (minTime <= 0n || maxTime < minTime) throw new Error("The lock duration settings are invalid.");
  const paused = value(reads[6]);
  const unlocked = value(reads[7]);
  const timestamp = value(reads[8]).timestamp;
  const state: LockState = {
    timestamp,
    minTime,
    maxTime,
    paused,
    unlocked,
    account,
    nativeBalance: 0n,
    wrappedBalance: 0n,
    allowance: 0n,
    lockedAmount: 0n,
    lockEnd: 0n,
    votingPower: 0n,
    walletAllowed: true,
  };
  if (!account) return state;
  let accountCode: Hex | undefined;
  [
    state.nativeBalance,
    state.wrappedBalance,
    state.allowance,
    [state.lockedAmount, state.lockEnd],
    state.votingPower,
    accountCode,
  ] = await Promise.all([
    client.getBalance({ address: account, blockTag: "pending" }),
    client.readContract({ ...tokenAt, functionName: "balanceOf", args: [account] }),
    client.readContract({ ...tokenAt, functionName: "allowance", args: [account, deployment.trustBonding] }),
    client.readContract({ ...at, functionName: "locked", args: [account] }),
    client.readContract({ ...at, functionName: "balanceOf", args: [account] }),
    client.getCode({ address: account, blockTag: "pending" }),
  ]);
  // EIP-7702 delegation does not make an EOA a msg.sender != tx.origin caller.
  if (accountCode && accountCode !== "0x" && !accountCode.startsWith("0xef0100"))
    state.walletAllowed = await client.readContract({ ...at, functionName: "contracts_whitelist", args: [account] });
  return state;
}
export type LockPlan = {
  amount: bigint;
  unlockTime: bigint;
  wrapAmount: bigint;
  mode: "create" | "add";
  step: "wrap" | "approve" | "lock";
  estimatedPower: bigint;
};
export function parseLockAmount(input: string) {
  const value = input.trim();
  if (!/^\d{1,38}(?:\.\d{1,18})?$/.test(value))
    throw new Error("Enter a TRUST amount with no more than 18 decimal places.");
  const amount = parseUnits(value, 18);
  if (amount <= 0n || amount > 2n ** 127n - 1n) throw new Error("Enter a positive amount within the lock limit.");
  return amount;
}
export function makeLockPlan(state: LockState, input: string, days: string): LockPlan {
  if (!state.account) throw new Error("Connect a wallet to prepare your lock.");
  if (!state.walletAllowed)
    throw new Error("This smart wallet is not approved by TrustBonding. Use an eligible wallet.");
  if (state.paused) throw new Error("Locking is paused by the contract. Try again after it resumes.");
  if (state.unlocked) throw new Error("Locks have been globally unlocked. New deposits are disabled.");
  const amount = parseLockAmount(input);
  if (state.lockedAmount + amount > 2n ** 127n - 1n) throw new Error("This amount exceeds the lock limit.");
  const mode = state.lockedAmount > 0n ? "add" : "create";
  let unlockTime = state.lockEnd;
  if (mode === "add") {
    if (state.lockEnd <= state.timestamp) throw new Error("Withdraw your expired lock before creating a new one.");
  } else {
    if (!/^\d{1,4}$/.test(days) || BigInt(days) <= 0n) throw new Error("Enter a whole number of days.");
    unlockTime = ((state.timestamp + BigInt(days) * DAY) / WEEK) * WEEK;
    if (unlockTime < state.timestamp + state.minTime)
      throw new Error("Choose a longer duration: the rounded unlock date is before the minimum lock period.");
    if (unlockTime > state.timestamp + state.maxTime)
      throw new Error("Choose a shorter duration within the maximum lock period.");
  }
  const wrapAmount = amount > state.wrappedBalance ? amount - state.wrappedBalance : 0n;
  if (wrapAmount >= state.nativeBalance)
    throw new Error(`Keep enough native ${deployment.nativeCurrency.symbol} for wrapping and transaction fees.`);
  const step = wrapAmount > 0n ? "wrap" : state.allowance < amount ? "approve" : "lock";
  // Match VotingEscrow's integer slope division before multiplying by time.
  const estimatedPower = ((state.lockedAmount + amount) / state.maxTime) * (unlockTime - state.timestamp);
  return { amount, unlockTime, wrapAmount, mode, step, estimatedPower };
}
export function sameLockIntent(a: LockPlan, b: LockPlan) {
  return (
    a.amount === b.amount &&
    a.unlockTime === b.unlockTime &&
    a.mode === b.mode &&
    a.step === b.step &&
    a.wrapAmount === b.wrapAmount
  );
}
export function canWithdraw(state: LockState) {
  return state.lockedAmount > 0n && (state.unlocked || state.lockEnd <= state.timestamp);
}
// Encode only the exact request that passed simulation; raw transaction fields
// let wrap/approve/lock share one wallet path without weakening ABI type checks.
function transaction(request: {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}) {
  return { to: request.address, data: encodeFunctionData(request), value: request.value ?? 0n };
}
export async function prepareLockTransaction(
  state: LockState,
  plan: LockPlan | "withdraw",
  client: GovernanceClient = governanceClient
) {
  if (!state.account) throw new Error("Connect a wallet first.");
  const base = { account: state.account, blockTag: "pending" } as const;
  if (plan === "withdraw") {
    if (!canWithdraw(state)) throw new Error("Your lock has not expired.");
    const simulation = await client.simulateContract({
      ...base,
      address: deployment.trustBonding,
      abi: trustBondingAbi,
      functionName: "withdraw",
    });
    return transaction(simulation.request);
  }
  if (plan.step === "wrap") {
    const simulation = await client.simulateContract({
      ...base,
      address: deployment.wrappedTrust,
      abi: wrappedTrustAbi,
      functionName: "deposit",
      value: plan.wrapAmount,
    });
    return transaction(simulation.request);
  }
  if (plan.step === "approve") {
    const simulation = await client.simulateContract({
      ...base,
      address: deployment.wrappedTrust,
      abi: wrappedTrustAbi,
      functionName: "approve",
      args: [deployment.trustBonding, plan.amount],
    });
    if (!simulation.result) throw new Error("The token did not accept the approval.");
    return transaction(simulation.request);
  }
  if (plan.mode === "add") {
    const simulation = await client.simulateContract({
      ...base,
      address: deployment.trustBonding,
      abi: trustBondingAbi,
      functionName: "increase_amount",
      args: [plan.amount],
    });
    return transaction(simulation.request);
  }
  const simulation = await client.simulateContract({
    ...base,
    address: deployment.trustBonding,
    abi: trustBondingAbi,
    functionName: "create_lock",
    args: [plan.amount, plan.unlockTime],
  });
  return transaction(simulation.request);
}
