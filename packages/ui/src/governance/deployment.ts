import { defineChain, getAddress } from "viem";

// Mainnet: intuition-contracts-v2-governance config/1155.json, deployed Nov 6, 2026
// (blocks 10,565,302 to 10,565,310, governance commit 56c4553b0043e0c484e604afe3ef97447e5488d6).
// Testnet: intuition-contracts-v2-governance deployments.md and config/13579.json,
// 2026-11-04, governance commit 8434b5ce3a232364392c4bc3f5efbfdeefcc6d57.
// Keep superseded routes out of this configuration.
const deployments = {
  mainnet: {
    chainId: 1155,
    name: "Intuition",
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://rpc.intuition.systems/http",
    explorer: "https://explorer.intuition.systems",
    dao: getAddress("0x9c965C3D39beb6293ca92cd35e552963e913F4Fd"),
    plugin: getAddress("0x013d36E344ce912440Bc615f774fAD73F7d62c3D"),
    adapter: getAddress("0x83d2c9D0fc344598166533dd306034ae8E75bD0f"),
    trustBonding: getAddress("0x635bBD1367B66E7B16a21D6E5A63C812fFC00617"),
    multiVault: getAddress("0x6E35cF57A41fA15eA0EaE9C33e751b01A784Fe7e"),
    wrappedTrust: getAddress("0x81cFb09cb44f7184Ad934C09F82000701A4bF672"),
    manager: getAddress("0xbeA18ab4c83a12be25f8AA8A10D8747A07Cdc6eb"),
    upgradesTimelock: getAddress("0x321e5d4b20158648dFd1f360A79CAFc97190bAd1"),
    parametersTimelock: getAddress("0x71b0F1ABebC2DaA0b7B5C3f9b72FAa1cd9F35FEA"),
    proxyAdmin: getAddress("0xF10FEE90B3C633c4fCd49aA557Ec7d51E5AEef62"),
    deploymentBlock: 10565302n,
    tokenSymbol: "veTRUST",
    tokenDecimals: 18,
    nativeCurrency: { name: "TRUST", symbol: "TRUST", decimals: 18 },
    testnet: false,
  },
  testnet: {
    chainId: 13579,
    name: "Intuition testnet",
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://testnet.rpc.intuition.systems/http",
    explorer: "https://intuition-testnet.explorer.caldera.xyz",
    dao: getAddress("0x866DBeF7fcfC703FBce7eb0292912f1A9D81EC99"),
    plugin: getAddress("0x61818dCD98276a426b6B95bDCB9E9FCC2235ED46"),
    adapter: getAddress("0x66591cdB76D6feC57A056A53faD3d35f850354df"),
    trustBonding: getAddress("0xc72c348dD5574C10245066846cbA6ce98C3282fc"),
    multiVault: getAddress("0xAC1AA948D5c40b6C60a07170C5794E595d08C32c"),
    wrappedTrust: getAddress("0xDE80b6EE63f7D809427CA350e30093F436A0fe35"),
    manager: getAddress("0x54C15B56800235F273bb659aea820c9D3112B3FD"),
    upgradesTimelock: getAddress("0xA531EAE7752DddF966E9959B4dab82793C971BB1"),
    parametersTimelock: getAddress("0x23C50180DF511b0cccf12a2dD0D3203b25f33Ee5"),
    proxyAdmin: getAddress("0x50AAe824607eB17F65dBfaec065e8cC9F210e50E"),
    deploymentBlock: 9375982n,
    tokenSymbol: "veTRUST",
    tokenDecimals: 18,
    nativeCurrency: { name: "Test TRUST", symbol: "tTRUST", decimals: 18 },
    testnet: true,
  },
} as const;

// Mainnet unless the build sets NEXT_PUBLIC_GOVERNANCE_NETWORK=testnet. Next.js inlines
// this value at build time, so each static build targets exactly one deployment.
export const network: keyof typeof deployments =
  process.env.NEXT_PUBLIC_GOVERNANCE_NETWORK === "testnet" ? "testnet" : "mainnet";

export const deployment = deployments[network];

export const governanceChain = defineChain({
  id: deployment.chainId,
  name: deployment.name,
  nativeCurrency: deployment.nativeCurrency,
  rpcUrls: { default: { http: [deployment.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: deployment.explorer } },
  // Canonical Multicall3, deployed at the same address on chains 1155 and 13579.
  contracts: { multicall3: { address: getAddress("0xcA11bde05977b3631167028862bE2a173976CA11") } },
  testnet: deployment.testnet,
});

// Verified creation receipt hashes from the testnet deployment. Import is explicit;
// the browser still fetches and validates these receipts before saving any events.
const testnetFixtureTransactions = [
  "0xa32ba33ec5b63d6fd93d19a4d76e25ddbd84726fca5f5ac60aee47c9d7c50a6a",
  "0x35d2a1e3737d42895b1a8b68f68652f0b26ed9b38345e78541cc5f862e86b530",
  "0x8943d808daaf11e5333089f31a8ae76eae53d62924aad203674af8e0bc5c8d9b",
  "0x51f5146e4dc97f2311f460aa1c34ec1e589b9ba1b692d33164a4a06e15aee99c",
  "0x67f617ca584ed4bfd4738193dfc53d0b9453d58e950ee8beb515c59112356131",
  "0x06eb33cdd6f2ff760771d829afbefb2439ee645b8fcf53af4c70e8047d15c56b",
  "0x56a2ac7ecbf3a25c5b143e1d532ef6439238f17f43daebf225f14f9a7e7e424a",
] as const;

export const fixtureTransactions: readonly `0x${string}`[] = deployment.testnet ? testnetFixtureTransactions : [];
