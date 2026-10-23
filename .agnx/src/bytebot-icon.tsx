// 场景：Bytebot 面板图标 — 上游 bytebot_square_light.svg 的蚂蚁轮廓（简化路径）。
import type { ReactElement } from "react";
import Svg, { Path, Circle } from "react-native-svg";

export function BytebotIcon(props: {
  color?: string;
  size?: number;
}): ReactElement {
  const size = props.size ?? 22;
  const color = props.color ?? "#fafafa";
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* 立方体外壳：呼应上游 logo 的等距立方 */}
      <Path
        d="M12 2.6 20.4 7v10L12 21.4 3.6 17V7L12 2.6Z"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="round"
      />
      <Path
        d="M3.6 7 12 11.5 20.4 7M12 11.5v9.9"
        stroke={color}
        strokeWidth={1.3}
        strokeLinejoin="round"
        opacity={0.5}
      />
      <Circle cx={12} cy={11.5} r={1.7} fill={color} />
    </Svg>
  );
}
