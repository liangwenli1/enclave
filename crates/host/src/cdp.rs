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
    let canvas = raw.get("canvasSample").and_then(|v| v.as_str()).unwrap_or("");
    Ok(LabSnapshot {
        user_agent: s(&raw, "userAgent"),
        platform: s(&raw, "platform"),
        vendor: s(&raw, "vendor"),
        language: s(&raw, "language"),
        languages: raw
            .get("languages")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default(),
        hardware_concurrency: n(&raw, "hardwareConcurrency"),
        device_memory: raw.get("deviceMemory").and_then(|v| v.as_f64()),
        max_touch_points: n(&raw, "maxTouchPoints"),
        hardware: Hardware {
            screen_w: nn(&raw, "hardware", "screenW"),
            screen_h: nn(&raw, "hardware", "screenH"),
            color_depth: nn(&raw, "hardware", "colorDepth"),
            dpr: nn(&raw, "hardware", "dpr"),
        },
        timezone: s(&raw, "timezone"),
        locale: s(&raw, "locale"),
        webdriver: raw.get("webdriver").and_then(|v| v.as_bool()),
        canvas_hash: sha256_str(canvas),
        webgl_vendor: s(&raw, "webglVendor"),
        webgl_renderer: s(&raw, "webglRenderer"),
        webrtc_ips: Vec::new(),
        collected_at: crate::kernel::now_ms(),
        source: "cdp".into(),
    })
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn n(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
fn nn(v: &Value, a: &str, b: &str) -> f64 {
    v.get(a).and_then(|x| x.get(b)).and_then(|x| x.as_f64()).unwrap_or(0.0)
}

async fn page_websocket(port: u16) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()?;
    let listed: Vec<Target> = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .await?
        .json()
        .await?;
    if let Some(page) = listed.iter().find(|t| t.kind.as_deref() == Some("page") && t.ws.is_some()) {
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
        .find(|t| t.ws.is_some() && t.url.as_deref().map(|u| u.contains(&target_id)).unwrap_or(false))
        .or_else(|| again.iter().find(|t| t.kind.as_deref() == Some("page") && t.ws.is_some()))
    {
        return Ok(page.ws.clone().unwrap());
    }
    bail!("no page target after createTarget");
}

async fn create_target(browser_ws: &str) -> Result<String> {
    let (mut ws, _) = connect_async(browser_ws).await?;
    ws.send(Message::Text(
        json!({ "id": 1, "method": "Target.createTarget", "params": { "url": "about:blank" } }).to_string(),
    ))
    .await?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: Value = serde_json::from_str(&t)?;
                if v.get("id").and_then(|x| x.as_i64()) == Some(1) {
                    let id = v.pointer("/result/targetId").and_then(|x| x.as_str()).unwrap_or("").to_string();
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
    Ok(result.pointer("/result/value").cloned().unwrap_or(Value::Object(Default::default())))
}

async fn cdp_rpc(
    ws: &mut tokio_tungstenite::WebSocketStream<impl tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>,
    id: i64,
    method: &str,
    params: Value,
) -> Result<Value> {
    ws.send(Message::Text(json!({ "id": id, "method": method, "params": params }).to_string()))
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
