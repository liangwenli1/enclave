import { useMemo } from "react";
import { ridges } from "@/lib/glyph";

/**
 * 环境的"指纹章"：由指纹种子算出来的一圈圈断弧。种子不变它就不变，
 * 几十个环境排在一起时靠它一眼认出哪个是哪个。复制出来的环境种子不同，章也不同。
 */
export function EnvGlyph({
  seed,
  size = 30,
  className,
}: {
  seed: string;
  size?: number;
  className?: string;
}) {
  const path = useMemo(() => ridges(Number.parseInt(seed, 10) || 1, size), [seed, size]);
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className={className ?? "flex-none text-accent-text"}
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={size > 40 ? 2.2 : 1.5}
        strokeLinecap="round"
      />
    </svg>
  );
}
