import { deployment } from "@/governance/deployment";
import type { IconType } from "@aragon/ods";
export type PluginItem = {
  id: string;
  folderName: string;
  title: string;
  icon?: IconType;
  pluginAddress: string;
  hiddenIfNotSigner?: boolean;
  hideFromMenu?: boolean;
};
export const plugins: PluginItem[] = [
  {
    id: "community-proposals",
    folderName: "optimistic-proposals",
    title: "Proposals",
    pluginAddress: deployment.plugin,
  },
];
