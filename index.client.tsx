import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PluginSyncItem, PluginSyncScreen } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: "main", title: "插件同步", Component: PluginSyncScreen });
  client.addSidebarHeaderItem({ id: "main", title: "插件同步", Component: PluginSyncItem });
  return () => {};
}
