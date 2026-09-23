//! 地区预设：出口国家 → 浏览器语言。
//!
//! 时区跟着代理出口走的时候，语言也得跟着走：时区在东京、语言却是 en-US，是风控最常看的不一致之一。
//! 表只有一份，和工作台读的是同一个文件（`src/lib/regions.json`），编译时打进来。

use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Debug, Deserialize)]
pub struct Region {
    pub country: String,
    pub name: String,
    /// navigator.language
    pub locale: String,
    /// navigator.languages，也是 Accept-Language 的顺序
    pub languages: Vec<String>,
    pub timezones: Vec<String>,
}

const TABLE: &str = include_str!("../../../src/lib/regions.json");

pub fn regions() -> &'static [Region] {
    static PARSED: OnceLock<Vec<Region>> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(TABLE).expect("regions.json"))
}

/// 两位国家代码（大小写不论）对应的预设。表里没有的国家返回 None：那就不动语言，只对齐时区。
pub fn of_country(country: &str) -> Option<&'static Region> {
    let code = country.trim().to_ascii_uppercase();
    regions().iter().find(|r| r.country == code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// 这张表两边共用，坏一条，工作台的下拉框和启动参数会一起坏。
    #[test]
    fn every_region_is_well_formed() {
        let mut countries = HashSet::new();
        let mut zones = HashSet::new();
        assert!(regions().len() >= 40);
        for r in regions() {
            assert!(
                r.country.len() == 2 && r.country.bytes().all(|b| b.is_ascii_uppercase()),
                "{}",
                r.country
            );
            assert!(countries.insert(&r.country), "{} 重复了", r.country);
            assert!(!r.name.is_empty());
            assert_eq!(
                r.languages.first(),
                Some(&r.locale),
                "{}：languages 的第一个必须就是 locale",
                r.country
            );
            let unique: HashSet<_> = r.languages.iter().collect();
            assert_eq!(
                unique.len(),
                r.languages.len(),
                "{} 的语言有重复",
                r.country
            );
            for tag in &r.languages {
                // 会原样进命令行：只能是 BCP 47 里最朴素的那种形状。
                assert!(
                    (2..=5).contains(&tag.len())
                        && tag.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-'),
                    "{tag}"
                );
            }
            assert!(!r.timezones.is_empty());
            for tz in &r.timezones {
                assert!(tz.contains('/'), "{tz}");
                // 一个时区只归一个国家，不然按时区反查地区就有歧义。
                assert!(zones.insert(tz), "{tz} 出现在两个国家里");
            }
        }
    }

    #[test]
    fn lookup_ignores_case_and_unknown_countries_change_nothing() {
        assert_eq!(of_country("jp").unwrap().locale, "ja");
        assert_eq!(of_country(" DE ").unwrap().languages[0], "de-DE");
        assert!(of_country("XX").is_none());
        assert!(of_country("United States").is_none());
    }
}
