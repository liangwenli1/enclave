/**
 * 地区预设：一个国家 ↔ 它的时区 + 浏览器语言。
 *
 * 时区和语言必须成对：时区在东京、语言却是 en-US，是风控最常看的不一致之一。
 * 这张表只有一份（regions.json），工作台和本机服务读的是同一个文件——
 * 「跟着代理出口走」时由本机服务按出口国家查它，界面上手选地区时由这里查它。
 */
import table from "./regions.json" with { type: "json" };

export type Region = {
  /** ISO 3166-1 两位国家代码 */
  country: string;
  name: string;
  /** navigator.language */
  locale: string;
  /** navigator.languages，也是 Accept-Language 的顺序 */
  languages: string[];
  /** 第一个是默认 */
  timezones: string[];
};

export const REGIONS: Region[] = table;

export function regionOfCountry(country: string | undefined | null): Region | undefined {
  const code = (country ?? "").trim().toUpperCase();
  return REGIONS.find((r) => r.country === code);
}

export function regionOfTimezone(timezone: string): Region | undefined {
  return REGIONS.find((r) => r.timezones.includes(timezone));
}

/** 语言的主标签：de-DE → de，ja → ja。比较「是不是同一种语言」用它。 */
export function primaryLanguage(tag: string): string {
  return (tag.split("-")[0] ?? "").toLowerCase();
}
