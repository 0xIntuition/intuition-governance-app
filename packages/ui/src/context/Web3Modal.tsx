import { createConfig, http } from "wagmi";
import type { Transport } from "viem";
import { injected, walletConnect } from "wagmi/connectors";
import { deployment, governanceChain } from "@/governance/deployment";

const projectId = process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID;
// Each build targets one deployment, so only the selected chain needs a transport.
const transports = {
  [governanceChain.id]: http(deployment.rpcUrl, { retryCount: 2, retryDelay: 1500 }),
} as Record<typeof governanceChain.id, Transport>;
export const config = createConfig({
  chains: [governanceChain],
  ssr: true,
  transports,
  connectors: [injected(), ...(projectId ? [walletConnect({ projectId, showQrModal: true })] : [])],
});
