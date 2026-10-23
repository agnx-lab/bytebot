// 场景：Bytebot Sub App 常量（AppId / 命令 / 面板 / ensure / 默认端口）。
export const BYTEBOT_APP_ID = "com.agnx.bytebot";
export const BYTEBOT_PANEL_ID = "bytebot.main";
export const BYTEBOT_OPEN_COMMAND_ID = "bytebot.open";

/** 短跑 sidecar：复用或拉起上游 packages/bytebot-ui 的 Express + Next server。 */
export const BYTEBOT_ENSURE_UI_TOOL_REL = ".agnx/tools/ensure-bytebot-ui.mjs";

export const DEFAULT_BYTEBOT_PORT = 8103;

/** Agnx 主守护进程端口，子应用永不占用。 */
export const AGNX_DAEMON_PORT = 6767;
