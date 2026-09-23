import { useEffect, useState } from "react";
import { getKernelView, type EngineClass, type KernelEntry } from "@/lib/kernel/host-api";

type Kernels = { kernels: KernelEntry[]; defaultVersions: Record<EngineClass, string | null> };

/** 给「选内核」的下拉框用：这台机器上每一类有哪些版本、各自的默认是哪个。问一次就够，不轮询。 */
export function useKernels(): Kernels {
  const [state, setState] = useState<Kernels>({
    kernels: [],
    defaultVersions: { chromium: null, firefox: null },
  });
  useEffect(() => {
    void getKernelView().then((view) =>
      setState({ kernels: view.kernels, defaultVersions: view.defaultVersions }),
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
  return notes.length ? `${kernel.record.version}（${notes.join("，")}）` : kernel.record.version;
}
