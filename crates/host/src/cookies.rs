//! 登录态（Cookie）的导出和导入。
//!
//! 不能直接拷 Cookie 库文件：Chromium 在 Windows 和 macOS 上用本机密钥加密它，换台电脑解不开。
//! 所以走调试协议把 Cookie 取出来、再放回去——两类内核各有自己的说法，取出来的东西统一成一种形状。
//!
//! 实测（容器里，真内核）：这样导出再导入到一个全新的用户目录，登录态还在，HttpOnly 的 Cookie 也带得过去。
//! 带不走的是 localStorage 和 IndexedDB：少数把登录令牌放在那里的站点，换电脑之后要重新登录。

use crate::kernel::Engine;
use anyhow::{anyhow, bail, Result};
use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use std::io::{Read, Write};

/// 一包 Cookie。版本号留着，以后加别的东西（localStorage 之类）时好认。
#[derive(Debug)]
pub struct Jar {
    pub cookies: Vec<Value>,
}

impl Jar {
    /// 压缩之后的样子。Cookie 是高度重复的文本，压下来通常只有几分之一。
    pub fn pack(&self) -> Result<Vec<u8>> {
        let text = serde_json::to_vec(&json!({ "v": 1, "cookies": self.cookies }))?;
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(&text)?;
        Ok(enc.finish()?)
    }

    pub fn unpack(packed: &[u8]) -> Result<Self> {
        // 解压之前先设个上限：别让一小段密文膨胀成几个 G。
        let mut out = Vec::new();
        ZlibDecoder::new(packed)
            .take(32 << 20)
            .read_to_end(&mut out)?;
        let value: Value = serde_json::from_slice(&out)?;
        if value["v"] != 1 {
            bail!("不认识的登录态格式");
        }
        Ok(Self {
            cookies: value["cookies"].as_array().cloned().unwrap_or_default(),
        })
    }
}

/// 从跑着的浏览器里把 Cookie 取出来。
pub async fn export(engine: Engine, port: u16) -> Result<Jar> {
    let cookies = match engine {
        Engine::Chromium => crate::cdp::get_cookies(port).await?,
        Engine::Firefox => crate::bidi::get_cookies(port).await?,
    };
    Ok(Jar { cookies })
}

/// 把 Cookie 放回浏览器里。返回放进去几条。
pub async fn import(engine: Engine, port: u16, jar: &Jar) -> Result<usize> {
    if jar.cookies.is_empty() {
        return Ok(0);
    }
    match engine {
        Engine::Chromium => crate::cdp::set_cookies(port, &jar.cookies).await,
        Engine::Firefox => crate::bidi::set_cookies(port, &jar.cookies).await,
    }
}

/// Firefox 那边的 Cookie 长得不一样（值裹了一层、字段名也不同）。统一成 Chromium 的形状存起来，
/// 放回去的时候再翻回去——这样同一份登录态换一类内核也认得。
pub fn from_firefox(c: &Value) -> Value {
    let text = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let value = c
        .pointer("/value/value")
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| text("value"));
    let mut out = json!({
        "name": text("name"), "value": value, "domain": text("domain"), "path": text("path"),
        "httpOnly": c.get("httpOnly").and_then(Value::as_bool).unwrap_or(false),
        "secure": c.get("secure").and_then(Value::as_bool).unwrap_or(false),
    });
    if let Some(expiry) = c.get("expiry").and_then(Value::as_f64) {
        out["expires"] = json!(expiry);
    }
    if let Some(same) = c.get("sameSite").and_then(Value::as_str) {
        // BiDi 报的是小写，Chromium 用的是首字母大写。
        let mut chars = same.chars();
        if let Some(first) = chars.next() {
            out["sameSite"] = json!(format!("{}{}", first.to_uppercase(), chars.as_str()));
        }
    }
    out
}

pub fn to_firefox(c: &Value) -> Result<Value> {
    let text = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let (name, domain) = (text("name"), text("domain"));
    if name.is_empty() || domain.is_empty() {
        bail!("这条 Cookie 没有名字或者域名");
    }
    let mut out = json!({
        "name": name,
        "value": { "type": "string", "value": text("value") },
        "domain": domain,
        "path": if text("path").is_empty() { "/".to_string() } else { text("path") },
        "httpOnly": c.get("httpOnly").and_then(Value::as_bool).unwrap_or(false),
        "secure": c.get("secure").and_then(Value::as_bool).unwrap_or(false),
    });
    if let Some(expires) = c.get("expires").and_then(Value::as_f64) {
        // 会话 Cookie（-1）不带过期时间；别的取整到秒。
        if expires > 0.0 {
            out["expiry"] = json!(expires as i64);
        }
    }
    if let Some(same) = c.get("sameSite").and_then(Value::as_str) {
        out["sameSite"] = json!(same.to_lowercase());
    }
    Ok(out)
}

/// 放回去之前先看一眼：域名和名字都得有，不然内核会整批拒绝。
pub fn usable(c: &Value) -> bool {
    c.get("name")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
        && c.get("domain")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
}

pub fn count_check(jar: &Jar) -> Result<()> {
    if jar.cookies.len() > 20_000 {
        return Err(anyhow!(
            "这个环境的 Cookie 太多了（{} 条）",
            jar.cookies.len()
        ));
    }
    Ok(())
}

/// 在已经起来的环境里打开一个网址。批量执行时用：起来之后直接到目标页面。
pub async fn open_url(engine: Engine, port: u16, url: &str) -> Result<()> {
    match engine {
        Engine::Chromium => crate::cdp::open_url(port, url).await,
        Engine::Firefox => crate::bidi::open_url(port, url).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_jar_survives_the_round_trip_and_gets_much_smaller() {
        let cookies: Vec<Value> = (0..200)
            .map(|i| json!({
                "name": format!("sid_{i}"), "value": "a-fairly-long-session-token-value-0123456789",
                "domain": ".shop.example", "path": "/", "httpOnly": true, "secure": true, "expires": 1.79e9
            }))
            .collect();
        let jar = Jar {
            cookies: cookies.clone(),
        };
        let packed = jar.pack().unwrap();
        let plain = serde_json::to_vec(&json!({ "v": 1, "cookies": cookies })).unwrap();
        assert!(
            packed.len() * 5 < plain.len(),
            "压缩之后应该小很多：{} vs {}",
            packed.len(),
            plain.len()
        );
        assert_eq!(Jar::unpack(&packed).unwrap().cookies, cookies);
        // 不是我们的格式、或者坏掉的数据，不能当成空 Cookie 悄悄放过。
        assert!(Jar::unpack(b"not zlib").is_err());
        let wrong = {
            let mut e = ZlibEncoder::new(Vec::new(), Compression::default());
            e.write_all(br#"{"v":2,"cookies":[]}"#).unwrap();
            e.finish().unwrap()
        };
        assert!(Jar::unpack(&wrong).is_err());
    }

    #[test]
    fn firefox_cookies_translate_both_ways() {
        // BiDi 实际回的形状（值裹了一层，字段叫 expiry，sameSite 小写）。
        let from_browser = json!({
            "name": "sid", "value": { "type": "string", "value": "secret-session-42" },
            "domain": "shop.example", "path": "/", "httpOnly": true, "secure": false,
            "expiry": 1790101052u64, "sameSite": "lax", "size": 20
        });
        let common = from_firefox(&from_browser);
        assert_eq!(common["value"], "secret-session-42");
        assert_eq!(common["httpOnly"], true);
        assert_eq!(common["sameSite"], "Lax");
        assert_eq!(common["expires"].as_f64(), Some(1_790_101_052.0));

        let back = to_firefox(&common).unwrap();
        assert_eq!(back["value"]["value"], "secret-session-42");
        assert_eq!(back["expiry"], 1790101052i64);
        assert_eq!(back["sameSite"], "lax");
        assert_eq!(back["path"], "/");

        // Chromium 存的会话 Cookie（expires = -1）不该给 Firefox 一个过期时间。
        let session =
            json!({"name": "t", "value": "v", "domain": "x.example", "path": "", "expires": -1.0});
        let out = to_firefox(&session).unwrap();
        assert!(out.get("expiry").is_none());
        assert_eq!(out["path"], "/");
        // 缺名字或域名的放不回去。
        assert!(to_firefox(&json!({"value": "v", "domain": "x.example"})).is_err());
        assert!(!usable(&json!({"name": "", "domain": "x.example"})));
        assert!(usable(&common));
    }
}
