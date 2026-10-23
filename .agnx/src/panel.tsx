// 场景：Bytebot 薄壳面板 — host.guest.mount 嵌入受管 bytebot-ui（Express + Next 自定义 server）。
// 首帧即品牌遮罩（消灭空 host 黑屏）；mount 时 bootOverlay:false，由面板独自持有遮罩。
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactElement,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  WorkspaceAppBrandLogoLoaderPanelProps,
  WorkspaceAppHostApi,
} from "@agnx-lab/app-sdk";
import {
  BYTEBOT_APP_ID,
  BYTEBOT_ENSURE_UI_TOOL_REL,
  DEFAULT_BYTEBOT_PORT,
} from "./constants";
import { bindBytebotHost, requireBoundHost } from "./host-bind";

const WEB_ROOT_STYLE: CSSProperties = {
  flex: "1 1 0%",
  alignSelf: "stretch",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  backgroundColor: "transparent",
};

const GUEST_HOST_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
  width: "100%",
  height: "100%",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  position: "relative",
};

const BOOT_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 2,
  display: "flex",
  flexDirection: "column",
  background: "rgb(9, 9, 11)",
};

const ERROR_LAYER_STYLE: CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 3,
  display: "flex",
  flexDirection: "column",
  background: "rgba(9,9,11,0.88)",
};

const ERROR_FALLBACK_STYLE: CSSProperties = {
  ...ERROR_LAYER_STYLE,
  alignItems: "center",
  justifyContent: "center",
  color: "#a1a1aa",
  padding: 24,
  textAlign: "center",
};

const RETAIN_REASON = "bytebot-open";

const styles = StyleSheet.create((theme) => ({
  fallback: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    backgroundColor: "transparent",
  },
  fallbackText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

export function bindBytebot(host: WorkspaceAppHostApi): void {
  bindBytebotHost(host);
}

function getHost(): WorkspaceAppHostApi {
  return requireBoundHost();
}

function canUseGuestSurface(): boolean {
  return typeof document !== "undefined" && getHost().platform.isWeb;
}

export function BytebotPanel(_props: {
  appId: string;
  panelId: string;
  entityId: string;
}): ReactElement {
  const guestHostRef = useRef<HTMLDivElement | null>(null);
  /** 首帧即 true：在 mount 之前盖住空 host，避免黑屏。 */
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = getHost();
    host.background?.requestRetain?.({
      appId: BYTEBOT_APP_ID,
      active: true,
      reason: RETAIN_REASON,
    });
    return () => {
      host.background?.requestRetain?.({
        appId: BYTEBOT_APP_ID,
        active: false,
        reason: RETAIN_REASON,
      });
    };
  }, []);

  useEffect(() => {
    if (!canUseGuestSurface()) {
      setBooting(false);
      setError("当前平台暂不支持嵌入 Bytebot，请使用 Agnx 桌面端。");
      return;
    }

    let cancelled = false;
    let unmountGuest: (() => void) | null = null;
    const host = getHost();

    if (!host.guest?.mount) {
      setBooting(false);
      setError("宿主未提供 host.guest（需升级 Agnx 并重新扫描子应用）");
      return;
    }

    unmountGuest = host.guest.mount({
      container: guestHostRef.current as HTMLDivElement,
      ensureTool: BYTEBOT_ENSURE_UI_TOOL_REL,
      ensureArgs: ["--port", String(DEFAULT_BYTEBOT_PORT)],
      // 首次冷启动要等 Next 自定义 server 起 Express；给足超时。
      timeoutMs: 180_000,
      bootOverlay: false,
      onReady: () => {
        if (!cancelled) {
          setError(null);
          // 稍留一帧给上游首屏，再撤面板遮罩。
          window.setTimeout(() => {
            if (!cancelled) {
              setBooting(false);
            }
          }, 280);
        }
      },
      onError: (detail) => {
        if (!cancelled) {
          setBooting(false);
          setError(`${detail.code}: ${detail.message}`);
        }
      },
    });

    return () => {
      cancelled = true;
      unmountGuest?.();
    };
  }, []);

  if (!canUseGuestSurface()) {
    return (
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>{error ?? "加载中…"}</Text>
      </View>
    );
  }

  const BrandPanel = getHost().ui?.BrandLogoLoaderPanel as
    | ComponentType<WorkspaceAppBrandLogoLoaderPanelProps>
    | undefined;

  return (
    <div style={WEB_ROOT_STYLE} data-testid="workspace-mini-app-bytebot-root">
      <div
        ref={guestHostRef}
        data-agnx-guest-surface-host="true"
        style={GUEST_HOST_STYLE}
      />
      {booting && !error && BrandPanel ? (
        <div data-agnx-guest-boot-overlay="true" style={BOOT_LAYER_STYLE} role="status">
          <BrandPanel
            title="正在启动 Bytebot…"
            description="正在准备嵌入面"
            testID="bytebot-boot-overlay"
          />
        </div>
      ) : null}
      {booting && !error && !BrandPanel ? (
        <div
          data-agnx-guest-boot-overlay="true"
          style={{ ...BOOT_LAYER_STYLE, ...ERROR_FALLBACK_STYLE }}
          role="status"
        >
          正在启动 Bytebot…
        </div>
      ) : null}
      {error && BrandPanel ? (
        <div style={ERROR_LAYER_STYLE} role="alert">
          <BrandPanel
            title={error}
            description="Bytebot 的 Web UI 需要先构建：packages/shared 与 packages/bytebot-ui 执行 npm install 后 next build。"
            testID="bytebot-mount-error"
          />
        </div>
      ) : null}
      {error && !BrandPanel ? (
        <div style={ERROR_FALLBACK_STYLE} role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
