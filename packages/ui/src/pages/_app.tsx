import type { AppProps } from "next/app";
import Head from "next/head";
import { RootContextProvider } from "@/context";
import { PUB_APP_DESCRIPTION } from "@/constants";
import "@aragon/ods/index.css";
import "@/pages/globals.css";
import "@/governance/governance.css";

export default function GovernanceApp({ Component, pageProps }: AppProps) {
  return (
    <>
      <Head>
        <title>Intuition governance</title>
        <meta name="description" content={`${PUB_APP_DESCRIPTION}.`} />
      </Head>
      <RootContextProvider>
        <Component {...pageProps} />
      </RootContextProvider>
    </>
  );
}
