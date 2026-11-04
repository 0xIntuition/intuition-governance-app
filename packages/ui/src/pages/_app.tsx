import type { AppProps } from "next/app";
import Head from "next/head";
import { RootContextProvider } from "@/context";
import "@aragon/ods/index.css";
import "@/pages/globals.css";
import "@/governance/governance.css";

export default function GovernanceApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>Intuition governance</title>
        <meta name="description" content="Follow proposals and veto with veTRUST on Intuition testnet." />
      </Head>
      <RootContextProvider>
        <Component {...pageProps} />
      </RootContextProvider>
    </>
  );
}
