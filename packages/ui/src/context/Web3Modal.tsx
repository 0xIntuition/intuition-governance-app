import { createConfig, http } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { deployment, intuitionTestnet } from "@/governance/deployment";

const projectId = process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID;
export const config = createConfig({
  chains: [intuitionTestnet],
  ssr: true,
  transports: { [intuitionTestnet.id]: http(deployment.rpcUrl, { retryCount: 2, retryDelay: 1500 }) },
  connectors: [injected(), ...(projectId ? [walletConnect({ projectId, showQrModal: true })] : [])],
});
