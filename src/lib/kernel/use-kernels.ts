import { useEffect, useState } from "react";
import { getKernelView, type KernelEntry } from "@/lib/kernel/host-api";

/** 给「选内核版本」的下拉框用：这台机器能用哪些版本、哪个是默认。问一次就够，不轮询。 */
export function useKernels(): { kernels: KernelEntry[]; defaultVersion: string | null } {
  const [state, setState] = useState<{ kernels: KernelEntry[]; defaultVersion: string | null }>({
    kernels: [],
    defaultVersion: null,
  });
  useEffect(() => {
    void getKernelView().then((view) =>
      setState({ kernels: view.kernels, defaultVersion: view.defaultVersion }),
    );
  }, []);
  return state;
}

/** 下拉框里一项的文字。没下载的要标出来，否则选了才发现启动不了。 */
export function kernelOptionLabel(kernel: KernelEntry): string {
  const notes = [
    kernel.withdrawn ? "已下架" : null,
    kernel.record.channel === "stable" ? null : "预览",
    kernel.status.state === "admitted" ? null : "未下载",
  ].filter(Boolean);
  return notes.length ? `${kernel.record.version}（${notes.join(" · ")}）` : kernel.record.version;
}
