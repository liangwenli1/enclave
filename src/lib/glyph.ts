/**
 * 指纹章：由指纹种子画几圈断弧，种子不变图形不变。
 *
 * 这个算法在工作台（enclave 仓库 src/lib/glyph.ts）和官网（enclave-www 仓库 web/lib/glyph.ts）
 * 各有一份——两个仓库是有意解耦的，合不成一个文件。两边的测试用同一组黄金向量钉死输出：
 * 任何一边改了算法，另一边的章就对不上，测试会先叫。
 */
export function ridges(seed: number, size: number): string {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const c = size / 2;
  const rings = 5;
  const step = (c - 2) / (rings + 0.4);
  let d = "";
  for (let i = 1; i <= rings; i += 1) {
    const r = step * i + 1;
    let from = next() * Math.PI * 2;
    const parts = 1 + Math.floor(next() * 3);
    for (let p = 0; p < parts; p += 1) {
      const sweep = ((0.5 + next() * 1.4) * Math.PI * 1.6) / parts;
      const to = from + sweep;
      const pt = (ang: number) =>
        `${(c + r * Math.cos(ang)).toFixed(2)} ${(c + r * Math.sin(ang)).toFixed(2)}`;
      d += `M${pt(from)}A${r.toFixed(2)} ${r.toFixed(2)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${pt(to)}`;
      from = to + 0.35 + next() * 0.5;
    }
  }
  return d;
}
