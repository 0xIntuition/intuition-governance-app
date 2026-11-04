import { useRouter } from "next/router";
import GovernanceScreen from "@/governance/screen";
import Link from "next/link";

export default function PluginPage() {
  const router = useRouter();
  if (!router.isReady) return null;
  if (router.query.id !== "community-proposals")
    return (
      <main className="governance">
        <h1>Page unavailable</h1>
        <p>This deployment has one governance plugin.</p>
        <Link href="/">View governance</Link>
      </main>
    );
  return <GovernanceScreen />;
}
