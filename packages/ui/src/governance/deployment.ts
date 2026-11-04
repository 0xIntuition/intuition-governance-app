import { defineChain, getAddress } from "viem";

// Source: intuition-contracts-v2-governance/deployments.md and config/13579.json,
// 2026-11-04, governance commit 8434b5ce3a232364392c4bc3f5efbfdeefcc6d57.
// Keep the superseded testnet routes out of this configuration.
export const deployment = {
  chainId: 13579,
  name: "Intuition testnet",
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://testnet.rpc.intuition.systems/http",
  explorer: "https://intuition-testnet.explorer.caldera.xyz",
  dao: getAddress("0x866DBeF7fcfC703FBce7eb0292912f1A9D81EC99"),
  plugin: getAddress("0x61818dCD98276a426b6B95bDCB9E9FCC2235ED46"),
  adapter: getAddress("0x66591cdB76D6feC57A056A53faD3d35f850354df"),
  trustBonding: getAddress("0xc72c348dD5574C10245066846cbA6ce98C3282fc"),
  manager: getAddress("0x54C15B56800235F273bb659aea820c9D3112B3FD"),
  upgradesTimelock: getAddress("0xA531EAE7752DddF966E9959B4dab82793C971BB1"),
  parametersTimelock: getAddress("0x23C50180DF511b0cccf12a2dD0D3203b25f33Ee5"),
  proxyAdmin: getAddress("0x50AAe824607eB17F65dBfaec065e8cC9F210e50E"),
  deploymentBlock: 9375982n,
  tokenSymbol: "veTRUST",
  tokenDecimals: 18,
} as const;

export const intuitionTestnet = defineChain({
  id: deployment.chainId,
  name: deployment.name,
  nativeCurrency: { name: "Test TRUST", symbol: "tTRUST", decimals: 18 },
  rpcUrls: { default: { http: [deployment.rpcUrl] } },
  blockExplorers: { default: { name: "Blockscout", url: deployment.explorer } },
  testnet: true,
});

// Verified creation receipt hashes from the current deployment. Import is explicit;
// the browser still fetches and validates these receipts before saving any events.
export const fixtureTransactions = [
  "0xa32ba33ec5b63d6fd93d19a4d76e25ddbd84726fca5f5ac60aee47c9d7c50a6a",
  "0x35d2a1e3737d42895b1a8b68f68652f0b26ed9b38345e78541cc5f862e86b530",
  "0x8943d808daaf11e5333089f31a8ae76eae53d62924aad203674af8e0bc5c8d9b",
  "0x51f5146e4dc97f2311f460aa1c34ec1e589b9ba1b692d33164a4a06e15aee99c",
  "0x67f617ca584ed4bfd4738193dfc53d0b9453d58e950ee8beb515c59112356131",
  "0x06eb33cdd6f2ff760771d829afbefb2439ee645b8fcf53af4c70e8047d15c56b",
  "0x56a2ac7ecbf3a25c5b143e1d532ef6439238f17f43daebf225f14f9a7e7e424a",
] as const;
