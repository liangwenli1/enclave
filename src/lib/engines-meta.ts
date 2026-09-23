/**
 * 两类内核各自是什么、能做什么。界面上所有按类区分的文字都从这里取，
 * 能力一栏写的是实测结果（docs/enclave-final-delivery.md §4.15），不是上游的宣传。
 */
import type { EngineClass } from "@/lib/kernel/host-api";

export const ENGINE_CLASSES: EngineClass[] = ["chromium", "firefox"];

export const ENGINE_META: Record<
  EngineClass,
  { label: string; build: string; license: string; summary: string }
> = {
  chromium: {
    label: "Chromium 类",
    build: "fingerprint-chromium",
    license: "Ungoogled Chromium，BSD-3-Clause",
    summary: "和 Chrome 同源，兼容性最好，体积小。屏幕分辨率和缩放来自这台电脑，改不了。",
  },
  firefox: {
    label: "Firefox 类",
    build: "Camoufox",
    license: "Mozilla Firefox，MPL-2.0",
    summary:
      "屏幕、缩放、显卡字符串都能按环境给。包大（解压后约 1.2 GB），单窗口内存约 640 MB，上游仍是 beta。",
  },
};
