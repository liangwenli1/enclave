use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

use crate::kernel::sha256_str;

const COLLECT: &str = include_str!("collect.js");

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabSnapshot {
    pub user_agent: String,
    pub platform: String,
    pub vendor: String,
    pub language: String,
    pub languages: Vec<String>,
    pub hardware_concurrency: f64,
    pub device_memory: Option<f64>,
    pub max_touch_points: f64,
    pub hardware: Hardware,
    pub timezone: String,
    pub locale: String,
    pub webdriver: Option<bool>,
    pub canvas_hash: String,
    pub webgl_vendor: String,
    pub webgl_renderer: String,
    pub webrtc_ips: Vec<String>,
    pub collected_at: u64,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub screen_w: f64,
    pub screen_h: f64,
    pub color_depth: f64,
    pub dpr: f64,
    /// 浏览器窗口的外框。真机上它不可能比屏幕大。
    pub outer_w: f64,
    pub outer_h: f64,
}

#[derive(Deserialize)]
struct Target {
    #[serde(rename = "type")]
    kind: Option<String>,
    #[serde(rename = "webSocketDebuggerUrl")]
    ws: Option<String>,
    url: Option<String>,
}

pub async fn collect(port: u16) -> Result<LabSnapshot> {
    let ws_url = page_websocket(port).await?;
    let raw = evaluate(&ws_url, COLLECT).await?;
    Ok(snapshot_from(&raw))
}

/// 采集脚本。两类内核在窗口里跑的是同一段 JS，只是送进去的协议不一样。
pub const COLLECT_JS: &str = COLLECT;

/// 采集脚本的返回值 → 快照。
pub fn snapshot_from(raw: &Value) -> LabSnapshot {
    let raw = raw.clone();
    let canvas = raw
        .get("canvasSample")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    LabSnapshot {
        user_agent: s(&raw, "userAgent"),
        platform: s(&raw, "platform"),
        vendor: s(&raw, "vendor"),
        language: s(&raw, "language"),
        languages: raw
            .get("languages")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        hardware_concurrency: n(&raw, "hardwareConcurrency"),
        device_memory: raw.get("deviceMemory").and_then(|v| v.as_f64()),
        max_touch_points: n(&raw, "maxTouchPoints"),
        hardware: Hardware {
            screen_w: nn(&raw, "hardware", "screenW"),
            screen_h: nn(&raw, "hardware", "screenH"),
            color_depth: nn(&raw, "hardware", "colorDepth"),
            dpr: nn(&raw, "hardware", "dpr"),
            outer_w: nn(&raw, "hardware", "outerW"),
            outer_h: nn(&raw, "hardware", "outerH"),
        },
        timezone: s(&raw, "timezone"),
        locale: s(&raw, "locale"),
        webdriver: raw.get("webdriver").and_then(|v| v.as_bool()),
        canvas_hash: sha256_str(canvas),
        webgl_vendor: s(&raw, "webglVendor"),
        webgl_renderer: s(&raw, "webglRenderer"),
        webrtc_ips: Vec::new(),
        collected_at: crate::kernel::now_ms(),
        // 来自内核窗口（不管走的是 CDP 还是 BiDi），区别于工作台自己页面上的对照组。
        source: "kernel".into(),
    }
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn n(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
fn nn(v: &Value, a: &str, b: &str) -> f64 {
    v.get(a)
        .and_then(|x| x.get(b))
        .and_then(|x| x.as_f64())
        .unwrap_or(0.0)
}

/// 浏览器那一层的连接（不是某个标签页）：Cookie 是整个浏览器的，不属于哪一页。
async fn browser_websocket(port: u16) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()?;
    let version: Value = client
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .await?
        .json()
        .await?;
    version
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .map(String::from)
        .context("no debugger websocket")
}

/// 取出这个浏览器里的全部 Cookie（含 HttpOnly 的——网页脚本读不到，调试协议读得到）。
pub async fn get_cookies(port: u16) -> Result<Vec<Value>> {
    let ws = browser_websocket(port).await?;
    let (mut socket, _) = connect_async(&ws).await?;
    let res = cdp_rpc(&mut socket, 1, "Storage.getCookies", json!({})).await?;
    let _ = socket.close(None).await;
    // cdp_rpc 回的已经是 result 里面那一层。
    Ok(res
        .get("cookies")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

/// 放回去。一次全给，内核自己去重。
pub async fn set_cookies(port: u16, cookies: &[Value]) -> Result<usize> {
    let usable: Vec<&Value> = cookies
        .iter()
        .filter(|c| crate::cookies::usable(c))
        .collect();
    if usable.is_empty() {
        return Ok(0);
    }
    let ws = browser_websocket(port).await?;
    let (mut socket, _) = connect_async(&ws).await?;
    let res = cdp_rpc(
        &mut socket,
        1,
        "Storage.setCookies",
        json!({ "cookies": usable }),
    )
    .await;
    let _ = socket.close(None).await;
    res?;
    Ok(usable.len())
}

pub(crate) async fn page_websocket(port: u16) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()?;
    let listed: Vec<Target> = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await?
        .json()
        .await?;
    if let Some(page) = listed
        .iter()
        .find(|t| t.kind.as_deref() == Some("page") && t.ws.is_some())
    {
        return Ok(page.ws.clone().unwrap());
    }
    let version: Value = client
        .get(format!("http://127.0.0.1:{port}/json/version"))
        .send()
        .await?
        .json()
        .await?;
    let browser_ws = version
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .context("no debugger websocket")?
        .to_string();
    let target_id = create_target(&browser_ws).await?;
    let again: Vec<Target> = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await?
        .json()
        .await?;
    if let Some(page) = again
        .iter()
        .find(|t| {
            t.ws.is_some()
                && t.url
                    .as_deref()
                    .map(|u| u.contains(&target_id))
                    .unwrap_or(false)
        })
        .or_else(|| {
            again
                .iter()
                .find(|t| t.kind.as_deref() == Some("page") && t.ws.is_some())
        })
    {
        return Ok(page.ws.clone().unwrap());
    }
    bail!("no page target after createTarget");
}

async fn create_target(browser_ws: &str) -> Result<String> {
    let (mut ws, _) = connect_async(browser_ws).await?;
    ws.send(Message::Text(
        json!({ "id": 1, "method": "Target.createTarget", "params": { "url": "about:blank" } })
            .to_string(),
    ))
    .await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: Value = serde_json::from_str(&t)?;
                if v.get("id").and_then(|x| x.as_i64()) == Some(1) {
                    let id = v
                        .pointer("/result/targetId")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let _ = ws.close(None).await;
                    return Ok(id);
                }
            }
            Ok(Some(Ok(_))) => continue,
            _ => break,
        }
    }
    let _ = ws.close(None).await;
    bail!("createTarget timeout");
}

async fn evaluate(ws_url: &str, expression: &str) -> Result<Value> {
    let (mut ws, _) = connect_async(ws_url).await?;
    cdp_rpc(&mut ws, 1, "Runtime.enable", json!({})).await?;
    let result = cdp_rpc(
        &mut ws,
        2,
        "Runtime.evaluate",
        json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
    )
    .await?;
    let _ = ws.close(None).await;
    Ok(result
        .pointer("/result/value")
        .cloned()
        .unwrap_or(Value::Object(Default::default())))
}

pub(crate) async fn cdp_rpc(
    ws: &mut tokio_tungstenite::WebSocketStream<
        impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
    >,
    id: i64,
    method: &str,
    params: Value,
) -> Result<Value> {
    ws.send(Message::Text(
        json!({ "id": id, "method": method, "params": params }).to_string(),
    ))
    .await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_secs(8), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: Value = serde_json::from_str(&t)?;
                if v.get("id").and_then(|x| x.as_i64()) == Some(id) {
                    return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                }
            }
            Ok(Some(Ok(_))) => continue,
            _ => bail!("cdp timeout {method}"),
        }
    }
    bail!("cdp timeout {method}")
}


/// 让当前标签页打开一个网址。
pub async fn open_url(port: u16, url: &str) -> Result<()> {
    let ws_url = page_websocket(port).await?;
    let (mut ws, _) = connect_async(&ws_url)
        .await
        .context("连不上内核的调试端口")?;
    cdp_rpc(&mut ws, 1, "Page.navigate", json!({ "url": url })).await?;
    let _ = ws.close(None).await;
    Ok(())
}

/// 把定位覆盖成代理出口所在地。走的是内核的 Emulation 域，不是往页面里注 JS——
/// 注 JS 会被 `Object.getOwnPropertyDescriptor` 和 `Function.prototype.toString` 查出来，这条不会。
pub async fn set_geolocation(port: u16, lat: f64, lon: f64) -> Result<()> {
    // Emulation 是按页面生效的域：发到浏览器级的连接上，那边收下了但不作用于页面。
    let ws_url = page_websocket(port).await?;
    let (mut ws, _) = connect_async(&ws_url)
        .await
        .context("连不上内核的调试端口")?;
    // 精度给 50 米：真实设备不会给出一个整数。
    cdp_rpc(
        &mut ws,
        1,
        "Emulation.setGeolocationOverride",
        json!({ "latitude": lat, "longitude": lon, "accuracy": 50 }),
    )
    .await?;
    let _ = ws.close(None).await;
    Ok(())
}

/// 把定位功能关掉：网页问位置时直接被拒，和用户点了"拒绝"一样。
///
/// 走浏览器级的权限设置，所以对所有标签页都算数——不像 Emulation 那样只管一个页面。
pub async fn block_geolocation(port: u16) -> Result<()> {
    let ws_url = browser_websocket(port).await?;
    let (mut ws, _) = connect_async(&ws_url)
        .await
        .context("连不上内核的调试端口")?;
    let out = cdp_rpc(
        &mut ws,
        1,
        "Browser.setPermission",
        json!({
            "permission": { "name": "geolocation" },
            "setting": "denied",
        }),
    )
    .await;
    let _ = ws.close(None).await;
    out.map(|_| ())
}

/* ── 新标签页的定位：在它跑第一行 JS 之前就设好 ──────────────────────────
   `Emulation.setGeolocationOverride` 是按页面生效的域，所以用户新开的标签页不会继承。
   这里保持一条连接，让内核把每个新页面**暂停**着交给我们（`waitForDebuggerOnStart`），
   设完坐标再放行——页面的第一行 JS 之前定位就已经是对的，没有时间差。

   这件事有个必须守住的底线：**不管中间出什么错，都要放行**。
   漏放一次，用户的那个标签页就永远卡在那里。所以下面每条路径的结尾都是 `run_if_waiting`；
   连接整个断掉也没事——内核会自动放掉所有等着的页面。 */

/// 新页面挂上来之后要做的事。
#[derive(Clone, Copy)]
pub enum GeoRule {
    /// 设成这个坐标。
    At(f64, f64),
    /// 什么都不设：用户选了"用真实位置"。这时候根本不需要监督。
    None,
}

/// 盯着这个浏览器，新开的标签页一挂上来就把定位设好再放行。
/// 返回的任务句柄由调用方保管：环境停掉时取消它，连接随之断开。
pub fn supervise_new_tabs(port: u16, rule: GeoRule) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(why) = watch_targets(port, rule).await {
            // 监督不了不影响用户用浏览器，只是新标签页的定位没跟上。留一行，别无声无息。
            eprintln!("新标签页的定位没盯住（端口 {port}）：{why:#}");
        }
    })
}

/// 一个新页面挂上来之后要发的两条命令。
///
/// 拆出来是为了能测：`release` 必须存在、必须排在最后。
/// 这条漏了，用户每开一个新标签页都会停在第一行 JS 之前——白屏，而且看不出为什么。
struct Attach {
    /// 设坐标。尽力而为，失败不影响下一条。
    geo: Option<Value>,
    /// 放行。无论上面成没成，这条一定要发出去。
    release: Value,
}

fn attach_plan(event: &Value, rule: GeoRule, next_id: &mut i64) -> Option<Attach> {
    if event["method"] != "Target.attachedToTarget" {
        return None;
    }
    let session = event["params"]["sessionId"].as_str()?;
    let mut cmd = |method: &str, params: Value| {
        *next_id += 1;
        json!({ "id": *next_id, "sessionId": session, "method": method, "params": params })
    };
    let geo = match rule {
        GeoRule::At(lat, lon) => Some(cmd(
            "Emulation.setGeolocationOverride",
            json!({ "latitude": lat, "longitude": lon, "accuracy": 50 }),
        )),
        GeoRule::None => None,
    };
    Some(Attach {
        geo,
        release: cmd("Runtime.runIfWaitingForDebugger", json!({})),
    })
}

async fn watch_targets(port: u16, rule: GeoRule) -> Result<()> {
    let ws_url = browser_websocket(port).await?;
    let (mut ws, _) = connect_async(&ws_url)
        .await
        .context("连不上内核的调试端口")?;
    ws.send(Message::Text(
        json!({
            "id": 1, "method": "Target.setAutoAttach",
            "params": { "autoAttach": true, "waitForDebuggerOnStart": true, "flatten": true },
        })
        .to_string(),
    ))
    .await?;

    let mut next_id = 100i64;
    while let Some(msg) = ws.next().await {
        let Ok(Message::Text(text)) = msg else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(plan) = attach_plan(&event, rule, &mut next_id) else {
            continue;
        };
        if let Some(geo) = plan.geo {
            // 设不上也要往下走：卡住一个标签页比定位不准严重得多。
            let _ = ws.send(Message::Text(geo.to_string())).await;
        }
        ws.send(Message::Text(plan.release.to_string())).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attached(session: &str) -> Value {
        json!({
            "method": "Target.attachedToTarget",
            "params": { "sessionId": session, "waitingForDebugger": true,
                        "targetInfo": { "type": "page", "url": "about:blank" } },
        })
    }

    /// 这条是这个文件里最重要的一条测试。
    ///
    /// 新标签页是被"暂停在第一行 JS 之前"挂上来的，只有 runIfWaitingForDebugger 能让它继续。
    /// 不管定位要不要设、设没设上，放行都必须发出去，而且必须排在最后。
    #[test]
    fn a_paused_tab_is_always_released() {
        for rule in [GeoRule::At(35.68, 139.76), GeoRule::None] {
            let mut id = 100;
            let plan = attach_plan(&attached("S1"), rule, &mut id).expect("这是一次挂载");
            assert_eq!(plan.release["method"], "Runtime.runIfWaitingForDebugger");
            assert_eq!(plan.release["sessionId"], "S1", "得放行这一页，不是别的页");
            // 放行的 id 比设坐标的大，就是说它排在后面。
            if let Some(geo) = &plan.geo {
                assert!(
                    plan.release["id"].as_i64() > geo["id"].as_i64(),
                    "先设坐标再放行"
                );
            }
        }
    }

    #[test]
    fn geolocation_is_set_only_when_asked() {
        let mut id = 100;
        let plan = attach_plan(&attached("S1"), GeoRule::At(35.68, 139.76), &mut id).unwrap();
        let geo = plan.geo.expect("要求了坐标就得设");
        assert_eq!(geo["method"], "Emulation.setGeolocationOverride");
        assert_eq!(geo["sessionId"], "S1", "定位是按页设的，session 不能串");
        assert_eq!(geo["params"]["latitude"], 35.68);
        assert_eq!(geo["params"]["longitude"], 139.76);

        let mut id = 100;
        let plan = attach_plan(&attached("S1"), GeoRule::None, &mut id).unwrap();
        assert!(plan.geo.is_none(), "没要求就别动它的定位");
    }

    #[test]
    fn other_traffic_is_left_alone() {
        let mut id = 100;
        // 调试端口上什么都有：命令的回包、别的事件。只认挂载。
        for noise in [
            json!({ "id": 7, "result": {} }),
            json!({ "method": "Target.targetCreated", "params": { "targetInfo": {} } }),
            json!({ "method": "Target.attachedToTarget", "params": { "targetInfo": {} } }),
        ] {
            assert!(attach_plan(&noise, GeoRule::At(1.0, 2.0), &mut id).is_none());
        }
        assert_eq!(id, 100, "什么都没发，id 不该往前走");
    }

    #[test]
    fn each_tab_gets_its_own_command_ids() {
        let mut id = 100;
        let first = attach_plan(&attached("S1"), GeoRule::At(1.0, 2.0), &mut id).unwrap();
        let second = attach_plan(&attached("S2"), GeoRule::At(1.0, 2.0), &mut id).unwrap();
        // id 撞了的话，内核的回包分不清是谁的。
        assert!(second.release["id"].as_i64() > first.release["id"].as_i64());
    }
}
