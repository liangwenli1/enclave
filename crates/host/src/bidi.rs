//! Firefox 类内核的调试协议：WebDriver BiDi（W3C 标准，一条 WebSocket 上来回发 JSON）。
//!
//! 只用来做一件事：在内核窗口里跑一遍采集脚本。脚本跑在一个单独的沙箱域里，
//! 页面自己的脚本看不到它、也改不了它读到的值。
//! 实测：连着会话的时候，页面自己看到的 `navigator.webdriver` 仍然是 false。

use crate::cdp::{snapshot_from, LabSnapshot, COLLECT_JS};
use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message};

pub(crate) type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub(crate) async fn call(ws: &mut Socket, id: u64, method: &str, params: Value) -> Result<Value> {
    ws.send(Message::Text(
        json!({ "id": id, "method": method, "params": params }).to_string(),
    ))
    .await?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        let next = tokio::time::timeout(Duration::from_secs(10), ws.next()).await;
        let Ok(Some(Ok(Message::Text(text)))) = next else {
            if matches!(next, Ok(Some(Ok(_)))) {
                continue;
            }
            break;
        };
        let msg: Value = serde_json::from_str(&text)?;
        // 事件没有 id，不是我们等的那一条。
        if msg.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if msg["type"] == "error" {
            bail!("{method}: {}", msg["message"].as_str().unwrap_or("error"));
        }
        return Ok(msg["result"].clone());
    }
    bail!("{method} 没有应答")
}

/// 从一堆标签里挑一个来采：优先已经打开了网页的，没有就用第一个。
pub(crate) fn pick_context(tree: &Value) -> Option<String> {
    let contexts = tree["contexts"].as_array()?;
    contexts
        .iter()
        .find(|c| c["url"].as_str().is_some_and(|u| u.starts_with("http")))
        .or(contexts.first())
        .and_then(|c| c["context"].as_str())
        .map(String::from)
}

/// 开一个会话做点事，做完就结束——同一时刻只允许一个会话，不能占着。
async fn with_session<T, F>(port: u16, work: F) -> Result<T>
where
    F: AsyncFnOnce(&mut Socket) -> Result<T>,
{
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/session"))
        .await
        .context("连不上内核的调试端口")?;
    call(&mut ws, 1, "session.new", json!({ "capabilities": {} })).await?;
    let out = work(&mut ws).await;
    let _ = call(&mut ws, 900, "session.end", json!({})).await;
    let _ = ws.close(None).await;
    out
}

/// 取出全部 Cookie，翻成和 Chromium 一样的形状存起来。
pub async fn get_cookies(port: u16) -> Result<Vec<Value>> {
    with_session(port, async |ws| {
        let res = call(ws, 2, "storage.getCookies", json!({})).await?;
        Ok(res["cookies"]
            .as_array()
            .map(|a| a.iter().map(crate::cookies::from_firefox).collect())
            .unwrap_or_default())
    })
    .await
}

/// 放回去。BiDi 一次只收一条，错的那条跳过，不因为一条坏的丢掉整包。
pub async fn set_cookies(port: u16, cookies: &[Value]) -> Result<usize> {
    with_session(port, async |ws| {
        let mut done = 0usize;
        for (i, c) in cookies.iter().enumerate() {
            let Ok(cookie) = crate::cookies::to_firefox(c) else {
                continue;
            };
            if call(
                ws,
                10 + i as u64,
                "storage.setCookie",
                json!({ "cookie": cookie }),
            )
            .await
            .is_ok()
            {
                done += 1;
            }
        }
        Ok(done)
    })
    .await
}

pub async fn collect(port: u16) -> Result<LabSnapshot> {
    let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/session"))
        .await
        .context("连不上内核的调试端口")?;
    // 同一时刻只能有一个会话。采完就结束它，不占着。
    call(&mut ws, 1, "session.new", json!({ "capabilities": {} })).await?;
    let result = async {
        let tree = call(&mut ws, 2, "browsingContext.getTree", json!({})).await?;
        let context = pick_context(&tree).context("内核里没有打开的标签")?;
        // BiDi 回的是它自己的序列化格式；让脚本先转成一段 JSON 文字，拿回来再解，最省事也最不容易错。
        let evaluated = call(
            &mut ws,
            3,
            "script.evaluate",
            json!({
                "expression": format!("JSON.stringify({COLLECT_JS})"),
                "target": { "context": context, "sandbox": "enclave-lab" },
                "awaitPromise": false,
                "resultOwnership": "none",
            }),
        )
        .await?;
        if evaluated["type"] != "success" {
            bail!("采集脚本在内核里抛了异常");
        }
        let text = evaluated["result"]["value"]
            .as_str()
            .context("采集脚本没有返回内容")?;
        Ok(snapshot_from(&serde_json::from_str(text)?))
    }
    .await;
    let _ = call(&mut ws, 4, "session.end", json!({})).await;
    let _ = ws.close(None).await;
    result
}

/// 让第一个标签页打开一个网址。
pub async fn open_url(port: u16, url: &str) -> Result<()> {
    with_session(port, async |ws| {
        let tree = call(ws, 2, "browsingContext.getTree", json!({})).await?;
        let context = tree["contexts"][0]["context"]
            .as_str()
            .context("这个窗口里没有标签页")?
            .to_string();
        call(
            ws,
            3,
            "browsingContext.navigate",
            json!({ "context": context, "url": url, "wait": "none" }),
        )
        .await?;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_a_tab_that_has_a_real_page_open() {
        let tree = json!({ "contexts": [
            { "context": "a", "url": "about:blank" },
            { "context": "b", "url": "https://shop.example/" },
        ]});
        assert_eq!(pick_context(&tree).as_deref(), Some("b"));
        let blank = json!({ "contexts": [{ "context": "a", "url": "about:newtab" }] });
        assert_eq!(pick_context(&blank).as_deref(), Some("a"));
        assert_eq!(pick_context(&json!({ "contexts": [] })), None);
    }
}
