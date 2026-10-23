// 场景：Bytebot Sub App 入口 — 薄壳 + ensure + iframe。
import type { WorkspaceAppHostApi, WorkspaceAppModule } from "@agnx-lab/app-sdk";
import { BytebotIcon } from "./bytebot-icon";
import {
  BYTEBOT_APP_ID,
  BYTEBOT_ENSURE_UI_TOOL_REL,
  BYTEBOT_OPEN_COMMAND_ID,
  BYTEBOT_PANEL_ID,
} from "./constants";
import { bindBytebot, BytebotPanel } from "./panel";

export const appId = BYTEBOT_APP_ID;

function openBytebotTab(
  host: WorkspaceAppHostApi,
  context?: {
    serverId?: string;
    workspaceId?: string;
    currentPathname?: string | null;
  },
): void {
  host.openMiniAppTab({
    appId: BYTEBOT_APP_ID,
    panelId: BYTEBOT_PANEL_ID,
    serverId: context?.serverId,
    workspaceId: context?.workspaceId,
    currentPathname: context?.currentPathname,
  });
}

export function activate(host: WorkspaceAppHostApi): void {
  bindBytebot(host);

  host.registerMiniApp({
    id: BYTEBOT_PANEL_ID,
    appId: BYTEBOT_APP_ID,
    title: "Bytebot",
    icon: BytebotIcon,
    component: BytebotPanel,
    iframeShortcutCapture: true,
    isolation: {
      mode: "iframe",
      sidecarTools: [BYTEBOT_ENSURE_UI_TOOL_REL],
      note: "Tab iframe 加载本仓 packages/bytebot-ui 受管 Next server；ensure 短跑 sidecar",
    },
  });

  host.registerCommand({
    id: BYTEBOT_OPEN_COMMAND_ID,
    appId: BYTEBOT_APP_ID,
    title: "Bytebot",
    keywords: ["bytebot", "desktop agent", "桌面智能体", "computer use", "虚拟桌面"],
    icon: BytebotIcon,
    sidebarAction: {
      defaultVisible: true,
      label: "Bytebot",
      order: 61,
    },
    run: (context) => {
      openBytebotTab(host, context);
    },
  });
}

const moduleExport: WorkspaceAppModule = {
  appId: BYTEBOT_APP_ID,
  activate,
};

export default moduleExport;

export { BYTEBOT_APP_ID, BYTEBOT_OPEN_COMMAND_ID, BYTEBOT_PANEL_ID } from "./constants";
export { BytebotPanel } from "./panel";
