import type { GetStaticPaths, GetStaticProps } from "next";
import GovernanceScreen from "@/governance/screen";

// The static export pre-renders the deployment's only plugin page. Any other ID is a 404,
// so the page renders the governance screen directly. Waiting for `router.isReady` would
// pre-render an empty page that then mismatches the first client render.
export const getStaticPaths: GetStaticPaths = async () => ({
  paths: [{ params: { id: "community-proposals" } }],
  fallback: false,
});

export const getStaticProps: GetStaticProps = async () => ({ props: {} });

export default function PluginPage() {
  return <GovernanceScreen />;
}
