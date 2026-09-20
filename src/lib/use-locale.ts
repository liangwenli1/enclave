import { t, type Locale } from "@/lib/i18n";
import { useEnclave } from "@/lib/store";

/** 当前界面语言。放在这里而不是 shell.tsx，免得组件文件混着导出非组件。 */
export function useLocale(): Locale {
  return useEnclave((s) => s.settings.locale);
}

export { t };
