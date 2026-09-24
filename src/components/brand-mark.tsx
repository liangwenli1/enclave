import { ridges } from "@/lib/glyph";

// 标志就是一枚指纹章（种子 12345，4 圈）：和官网、应用图标是同一个图形。
const MARK = ridges(12345, 26, 4);

export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 26 26"
      aria-hidden="true"
      className={className ?? "flex-none text-accent-text"}
    >
      <path d={MARK} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}
