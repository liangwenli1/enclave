//! 自动化流程：一串步骤，在一个已经跑起来的环境里依次执行。
//!
//! 两类内核走各自的协议，但步骤定义完全一样——同一个流程在火狐环境上也照样跑，
//! 不出现"这个流程在火狐上不能用"这种双轨。
//!
//! Chromium 类只用 DOM 和 Input 两个域定位、点击、输入，**全程不开 `Runtime.enable`**：
//! 那是 CDP 自动化最常见的暴露点（Puppeteer 就栽在这），实验室的采集器开着它是因为采集
//! 本来就是一次性的。只有「提取文本」用一次不 enable 的 `Runtime.evaluate`。
//! 这条是行业共识，不是我们实测出来的——经典探测器在这个内核的无头模式下根本不触发。
//!
//! 解释器和协议是分开的：`run_with` 只认 [`Driver`]，条件、循环、失败策略这些逻辑
//! 都能用一个假的驱动在单测里过一遍，不用起浏览器。

use crate::kernel::Engine;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use tokio_tungstenite::connect_async;

/* ── 流程的形状 ───────────────────────────────────────── */

/// 一步。参数里可以写 `{{变量}}`，执行时换成「提取文本」存下来的值。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Step {
    Open {
        url: String,
    },
    Click {
        selector: String,
    },
    Type {
        selector: String,
        text: String,
    },
    /// Enter / Tab / Escape。
    Press {
        key: String,
    },
    /// 有选择器就滚到那个元素，没有就按像素滚页面。
    Scroll {
        #[serde(default)]
        selector: String,
        #[serde(default)]
        dy: i64,
    },
    WaitFor {
        selector: String,
        #[serde(default = "default_timeout")]
        timeout_ms: u64,
    },
    Sleep {
        ms: u64,
    },
    Extract {
        selector: String,
        var: String,
    },
    /// 条件成立就跳到第 `goto` 步（从 1 数）；`goto` 为 0 表示结束。
    If {
        var: String,
        op: Cond,
        #[serde(default)]
        value: String,
        goto: usize,
    },
    /// 把第 `from` 到第 `to` 步（从 1 数，含两端）重复 `times` 次。
    /// 循环节点放在循环体**之后**：走到它时回头再跑一遍，范围必须整个在它前面。
    Loop {
        from: usize,
        to: usize,
        times: u32,
    },
}

fn default_timeout() -> u64 {
    10_000
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Cond {
    Contains,
    Equals,
    NotEmpty,
}

/// 这一步失败了怎么办。
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum OnFail {
    Retry {
        times: u32,
    },
    Skip,
    #[default]
    Stop,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepDef {
    #[serde(flatten)]
    pub step: Step,
    #[serde(default)]
    pub on_fail: OnFail,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub steps: Vec<StepDef>,
}

/// 一步的结果，给界面看。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepLog {
    /// 从 1 数，和编辑器里一致。
    pub index: usize,
    pub ok: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub ok: bool,
    /// 停在哪一步（从 1 数）。跑完是 None。
    pub failed_at: Option<usize>,
    pub vars: HashMap<String, String>,
    pub log: Vec<StepLog>,
}

/// 一个流程最多执行多少步。条件跳转可以写成死循环，得有个底。
pub const MAX_STEPS: usize = 5_000;

/* ── 解释器 ─────────────────────────────────────────────── */

/// 协议无关的动作。两类内核各实现一份；测试用假的。
#[allow(async_fn_in_trait)] // 只在本 crate 里用，不需要 Send 约束
pub trait Driver {
    async fn navigate(&mut self, url: &str) -> Result<()>;
    async fn click(&mut self, selector: &str) -> Result<()>;
    async fn type_text(&mut self, selector: &str, text: &str) -> Result<()>;
    async fn press(&mut self, key: &str) -> Result<()>;
    async fn scroll(&mut self, selector: &str, dy: i64) -> Result<()>;
    async fn visible(&mut self, selector: &str) -> Result<bool>;
    async fn extract(&mut self, selector: &str) -> Result<String>;
}

/// 把 `{{变量}}` 换成值。没有的变量换成空——留着大括号更像 bug。
pub fn substitute(text: &str, vars: &HashMap<String, String>) -> String {
    let mut out = text.to_string();
    for (k, v) in vars {
        out = out.replace(&format!("{{{{{k}}}}}"), v);
    }
    out
}

/// 一步的执行（不含失败策略）。
async fn execute<D: Driver>(d: &mut D, step: &Step, vars: &HashMap<String, String>) -> Result<()> {
    match step {
        Step::Open { url } => d.navigate(&substitute(url, vars)).await,
        Step::Click { selector } => d.click(selector).await,
        Step::Type { selector, text } => d.type_text(selector, &substitute(text, vars)).await,
        Step::Press { key } => d.press(key).await,
        Step::Scroll { selector, dy } => d.scroll(selector, *dy).await,
        Step::WaitFor {
            selector,
            timeout_ms,
        } => {
            let deadline = tokio::time::Instant::now() + Duration::from_millis(*timeout_ms);
            loop {
                if d.visible(selector).await? {
                    return Ok(());
                }
                if tokio::time::Instant::now() >= deadline {
                    bail!("等了 {} 秒还没出现：{selector}", timeout_ms / 1000);
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        Step::Sleep { ms } => {
            tokio::time::sleep(Duration::from_millis((*ms).min(600_000))).await;
            Ok(())
        }
        // 提取、条件、循环由解释器自己处理，不到这里。
        Step::Extract { .. } | Step::If { .. } | Step::Loop { .. } => Ok(()),
    }
}

fn holds(cond: Cond, actual: &str, expected: &str) -> bool {
    match cond {
        Cond::Contains => actual.contains(expected),
        Cond::Equals => actual == expected,
        Cond::NotEmpty => !actual.trim().is_empty(),
    }
}

/// 跑一个流程。`cancelled` 每一步之前问一次。
pub async fn run_with<D: Driver>(
    d: &mut D,
    wf: &Workflow,
    cancelled: impl Fn() -> bool,
) -> Outcome {
    let mut vars: HashMap<String, String> = HashMap::new();
    let mut log = Vec::new();
    // 循环计数：Loop 所在的位置 → 还剩几次
    let mut loops: HashMap<usize, u32> = HashMap::new();
    let mut pc = 0usize;
    let mut executed = 0usize;

    while pc < wf.steps.len() {
        if cancelled() {
            log.push(StepLog {
                index: pc + 1,
                ok: false,
                message: "已取消".into(),
            });
            return Outcome {
                ok: false,
                failed_at: Some(pc + 1),
                vars,
                log,
            };
        }
        executed += 1;
        if executed > MAX_STEPS {
            log.push(StepLog {
                index: pc + 1,
                ok: false,
                message: format!("超过 {MAX_STEPS} 步，像是死循环，已停止"),
            });
            return Outcome {
                ok: false,
                failed_at: Some(pc + 1),
                vars,
                log,
            };
        }
        let def = &wf.steps[pc];
        let index = pc + 1;

        // 控制流自己走，不经过驱动、也不谈失败策略。
        match &def.step {
            Step::If {
                var,
                op,
                value,
                goto,
            } => {
                let actual = vars.get(var).cloned().unwrap_or_default();
                let yes = holds(*op, &actual, &substitute(value, &vars));
                log.push(StepLog {
                    index,
                    ok: true,
                    message: if yes {
                        format!("条件成立，跳到第 {goto} 步")
                    } else {
                        "条件不成立，继续".into()
                    },
                });
                if yes {
                    if *goto == 0 || *goto > wf.steps.len() {
                        return Outcome {
                            ok: true,
                            failed_at: None,
                            vars,
                            log,
                        };
                    }
                    pc = goto - 1;
                } else {
                    pc += 1;
                }
                continue;
            }
            Step::Loop { from, to, times } => {
                let left = loops.entry(pc).or_insert(*times);
                if *left == 0 || *from == 0 || *to < *from || *to > pc {
                    // 次数用完，或者范围不合法（范围要整个在 Loop 前面，不然跳过去就回不来了），走下一步。
                    loops.remove(&pc);
                    log.push(StepLog {
                        index,
                        ok: true,
                        message: "循环结束".into(),
                    });
                    pc += 1;
                } else {
                    *left -= 1;
                    log.push(StepLog {
                        index,
                        ok: true,
                        message: format!("循环，还剩 {left} 次"),
                    });
                    pc = from - 1;
                }
                continue;
            }
            _ => {}
        }

        // 普通步骤：按失败策略跑。
        let mut tries = 0u32;
        let result = loop {
            let r = match &def.step {
                Step::Extract { selector, var } => match d.extract(selector).await {
                    Ok(text) => {
                        vars.insert(var.clone(), text.trim().to_string());
                        Ok(())
                    }
                    Err(e) => Err(e),
                },
                other => execute(d, other, &vars).await,
            };
            match (&r, def.on_fail) {
                (Err(_), OnFail::Retry { times }) if tries < times => {
                    tries += 1;
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
                _ => break r,
            }
        };
        match result {
            Ok(()) => {
                log.push(StepLog {
                    index,
                    ok: true,
                    message: if tries > 0 {
                        format!("重试 {tries} 次后成功")
                    } else {
                        String::new()
                    },
                });
                pc += 1;
            }
            Err(e) => {
                let why = format!("{e:#}");
                match def.on_fail {
                    OnFail::Skip => {
                        log.push(StepLog {
                            index,
                            ok: false,
                            message: format!("失败，已跳过：{why}"),
                        });
                        pc += 1;
                    }
                    _ => {
                        log.push(StepLog {
                            index,
                            ok: false,
                            message: why,
                        });
                        return Outcome {
                            ok: false,
                            failed_at: Some(index),
                            vars,
                            log,
                        };
                    }
                }
            }
        }
    }
    Outcome {
        ok: true,
        failed_at: None,
        vars,
        log,
    }
}

/// 按内核类挑驱动，跑一个流程。
pub async fn run(
    engine: Engine,
    port: u16,
    wf: &Workflow,
    cancelled: impl Fn() -> bool,
) -> Outcome {
    match engine {
        Engine::Chromium => match Cdp::connect(port).await {
            Ok(mut d) => run_with(&mut d, wf, cancelled).await,
            Err(e) => connect_failed(e),
        },
        Engine::Firefox => match Bidi::connect(port).await {
            Ok(mut d) => {
                let out = run_with(&mut d, wf, cancelled).await;
                d.close().await;
                out
            }
            Err(e) => connect_failed(e),
        },
    }
}

fn connect_failed(e: anyhow::Error) -> Outcome {
    Outcome {
        ok: false,
        failed_at: Some(1),
        vars: HashMap::new(),
        log: vec![StepLog {
            index: 1,
            ok: false,
            message: format!("连不上内核：{e:#}"),
        }],
    }
}

/* ── Chromium 类：DOM + Input 域 ─────────────────────────── */

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub struct Cdp {
    ws: WsStream,
    next: i64,
}

impl Cdp {
    pub async fn connect(port: u16) -> Result<Self> {
        let url = crate::cdp::page_websocket(port).await?;
        let (ws, _) = connect_async(&url).await.context("连不上内核的调试端口")?;
        Ok(Self { ws, next: 1000 })
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next += 1;
        crate::cdp::cdp_rpc(&mut self.ws, self.next, method, params).await
    }

    /// 导航之后 nodeId 全部作废，所以每次都从根重新找。
    async fn node(&mut self, selector: &str) -> Result<i64> {
        let root = self.call("DOM.getDocument", json!({ "depth": 0 })).await?;
        let root = root["root"]["nodeId"].as_i64().context("拿不到文档")?;
        let found = self
            .call(
                "DOM.querySelector",
                json!({ "nodeId": root, "selector": selector }),
            )
            .await?;
        match found["nodeId"].as_i64() {
            Some(id) if id != 0 => Ok(id),
            _ => bail!("页面上没有：{selector}"),
        }
    }

    async fn center(&mut self, node: i64) -> Result<(f64, f64)> {
        let _ = self
            .call("DOM.scrollIntoViewIfNeeded", json!({ "nodeId": node }))
            .await;
        let model = self
            .call("DOM.getBoxModel", json!({ "nodeId": node }))
            .await?;
        let q = model["model"]["content"].as_array().context("元素不可见")?;
        let f = |i: usize| q.get(i).and_then(Value::as_f64).unwrap_or(0.0);
        Ok(((f(0) + f(2)) / 2.0, (f(1) + f(5)) / 2.0))
    }
}

impl Driver for Cdp {
    async fn navigate(&mut self, url: &str) -> Result<()> {
        self.call("Page.navigate", json!({ "url": url })).await?;
        // 等到文档就绪；单次 evaluate，不开 Runtime.enable。
        for _ in 0..100 {
            let r = self
                .call(
                    "Runtime.evaluate",
                    json!({ "expression": "document.readyState", "returnByValue": true }),
                )
                .await?;
            if matches!(
                r["result"]["value"].as_str(),
                Some("interactive") | Some("complete")
            ) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        bail!("页面 20 秒还没加载完")
    }

    async fn click(&mut self, selector: &str) -> Result<()> {
        let node = self.node(selector).await?;
        let (x, y) = self.center(node).await?;
        for kind in ["mouseMoved", "mousePressed", "mouseReleased"] {
            self.call(
                "Input.dispatchMouseEvent",
                json!({ "type": kind, "x": x, "y": y, "button": "left", "clickCount": 1 }),
            )
            .await?;
        }
        Ok(())
    }

    async fn type_text(&mut self, selector: &str, text: &str) -> Result<()> {
        let node = self.node(selector).await?;
        self.call("DOM.focus", json!({ "nodeId": node })).await?;
        self.call("Input.insertText", json!({ "text": text }))
            .await?;
        Ok(())
    }

    async fn press(&mut self, key: &str) -> Result<()> {
        let (name, code, vk) = match key {
            "Enter" => ("Enter", "Enter", 13),
            "Tab" => ("Tab", "Tab", 9),
            "Escape" => ("Escape", "Escape", 27),
            other => bail!("不认识的按键：{other}"),
        };
        for kind in ["keyDown", "keyUp"] {
            self.call(
                "Input.dispatchKeyEvent",
                json!({ "type": kind, "key": name, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk }),
            )
            .await?;
        }
        Ok(())
    }

    async fn scroll(&mut self, selector: &str, dy: i64) -> Result<()> {
        if !selector.is_empty() {
            let node = self.node(selector).await?;
            self.call("DOM.scrollIntoViewIfNeeded", json!({ "nodeId": node }))
                .await?;
            return Ok(());
        }
        self.call(
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseWheel", "x": 100, "y": 100, "deltaX": 0, "deltaY": dy }),
        )
        .await?;
        Ok(())
    }

    async fn visible(&mut self, selector: &str) -> Result<bool> {
        let Ok(node) = self.node(selector).await else {
            return Ok(false);
        };
        Ok(self
            .call("DOM.getBoxModel", json!({ "nodeId": node }))
            .await
            .is_ok_and(|m| m["model"].is_object()))
    }

    async fn extract(&mut self, selector: &str) -> Result<String> {
        let expr = format!(
            "(function(){{const e=document.querySelector({}); return e? (e.value ?? e.textContent ?? '') : null;}})()",
            serde_json::to_string(selector)?
        );
        let r = self
            .call(
                "Runtime.evaluate",
                json!({ "expression": expr, "returnByValue": true }),
            )
            .await?;
        match r["result"]["value"].as_str() {
            Some(text) => Ok(text.to_string()),
            None => bail!("页面上没有：{selector}"),
        }
    }
}

/* ── Firefox 类：WebDriver BiDi ────────────────────────────── */

pub struct Bidi {
    ws: crate::bidi::Socket,
    context: String,
    next: u64,
}

const SANDBOX: &str = "enclave-rpa";

impl Bidi {
    pub async fn connect(port: u16) -> Result<Self> {
        let (mut ws, _) = connect_async(format!("ws://127.0.0.1:{port}/session"))
            .await
            .context("连不上内核的调试端口")?;
        crate::bidi::call(&mut ws, 1, "session.new", json!({ "capabilities": {} })).await?;
        let tree = crate::bidi::call(&mut ws, 2, "browsingContext.getTree", json!({})).await?;
        let context = crate::bidi::pick_context(&tree).context("内核里没有打开的标签")?;
        Ok(Self {
            ws,
            context,
            next: 100,
        })
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next += 1;
        crate::bidi::call(&mut self.ws, self.next, method, params).await
    }

    /// 会话同一时刻只能有一个，跑完要结束，不然实验室采集就进不来了。
    pub async fn close(&mut self) {
        let _ = self.call("session.end", json!({})).await;
        let _ = self.ws.close(None).await;
    }

    async fn shared_id(&mut self, selector: &str) -> Result<String> {
        let ctx = self.context.clone();
        let r = self
            .call(
                "browsingContext.locateNodes",
                json!({ "context": ctx, "locator": { "type": "css", "value": selector } }),
            )
            .await?;
        r["nodes"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|n| n["sharedId"].as_str())
            .map(String::from)
            .with_context(|| format!("页面上没有：{selector}"))
    }

    async fn pointer_click(&mut self, shared: &str) -> Result<()> {
        let ctx = self.context.clone();
        self.call(
            "input.performActions",
            json!({ "context": ctx, "actions": [{ "type": "pointer", "id": "m", "actions": [
                { "type": "pointerMove", "x": 0, "y": 0, "origin": { "type": "element", "element": { "sharedId": shared } } },
                { "type": "pointerDown", "button": 0 }, { "type": "pointerUp", "button": 0 }
            ] }] }),
        )
        .await?;
        Ok(())
    }

    async fn eval(&mut self, expression: &str) -> Result<Value> {
        let ctx = self.context.clone();
        let r = self
            .call(
                "script.evaluate",
                json!({ "expression": expression, "target": { "context": ctx, "sandbox": SANDBOX },
                        "awaitPromise": false, "resultOwnership": "none" }),
            )
            .await?;
        if r["type"] != "success" {
            bail!("页面里的脚本抛了异常");
        }
        Ok(r["result"]["value"].clone())
    }
}

impl Driver for Bidi {
    async fn navigate(&mut self, url: &str) -> Result<()> {
        let ctx = self.context.clone();
        self.call(
            "browsingContext.navigate",
            json!({ "context": ctx, "url": url, "wait": "interactive" }),
        )
        .await?;
        Ok(())
    }

    async fn click(&mut self, selector: &str) -> Result<()> {
        let shared = self.shared_id(selector).await?;
        self.pointer_click(&shared).await
    }

    async fn type_text(&mut self, selector: &str, text: &str) -> Result<()> {
        let shared = self.shared_id(selector).await?;
        self.pointer_click(&shared).await?;
        let keys: Vec<Value> = text
            .chars()
            .flat_map(|c| {
                let s = c.to_string();
                [
                    json!({ "type": "keyDown", "value": s }),
                    json!({ "type": "keyUp", "value": s }),
                ]
            })
            .collect();
        let ctx = self.context.clone();
        self.call(
            "input.performActions",
            json!({ "context": ctx, "actions": [{ "type": "key", "id": "k", "actions": keys }] }),
        )
        .await?;
        Ok(())
    }

    async fn press(&mut self, key: &str) -> Result<()> {
        // WebDriver 的特殊键编码。
        let value = match key {
            "Enter" => "\u{E007}",
            "Tab" => "\u{E004}",
            "Escape" => "\u{E00C}",
            other => bail!("不认识的按键：{other}"),
        };
        let ctx = self.context.clone();
        self.call(
            "input.performActions",
            json!({ "context": ctx, "actions": [{ "type": "key", "id": "k", "actions": [
                { "type": "keyDown", "value": value }, { "type": "keyUp", "value": value } ] }] }),
        )
        .await?;
        Ok(())
    }

    async fn scroll(&mut self, selector: &str, dy: i64) -> Result<()> {
        if !selector.is_empty() {
            let expr = format!(
                "(function(){{const e=document.querySelector({}); if(!e) return false; e.scrollIntoView({{block:'center'}}); return true;}})()",
                serde_json::to_string(selector)?
            );
            if self.eval(&expr).await? != json!(true) {
                bail!("页面上没有：{selector}");
            }
            return Ok(());
        }
        let ctx = self.context.clone();
        self.call(
            "input.performActions",
            json!({ "context": ctx, "actions": [{ "type": "wheel", "id": "w", "actions": [
                { "type": "scroll", "x": 0, "y": 0, "deltaX": 0, "deltaY": dy, "origin": "viewport" } ] }] }),
        )
        .await?;
        Ok(())
    }

    async fn visible(&mut self, selector: &str) -> Result<bool> {
        let expr = format!(
            "(function(){{const e=document.querySelector({}); return !!(e && e.offsetParent !== null);}})()",
            serde_json::to_string(selector)?
        );
        Ok(self.eval(&expr).await? == json!(true))
    }

    async fn extract(&mut self, selector: &str) -> Result<String> {
        let expr = format!(
            "(function(){{const e=document.querySelector({}); return e? (e.value ?? e.textContent ?? '') : null;}})()",
            serde_json::to_string(selector)?
        );
        match self.eval(&expr).await?.as_str() {
            Some(text) => Ok(text.to_string()),
            None => bail!("页面上没有：{selector}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 假驱动：记下做了什么，按选择器决定成不成、提取出什么。
    #[derive(Default)]
    struct Fake {
        did: Vec<String>,
        fail_on: Vec<String>,
        text: HashMap<String, String>,
        /// 第几次 click 之后才不再失败（模拟"再试一次就好"）。
        flaky_until: u32,
        clicks: u32,
    }

    impl Driver for Fake {
        async fn navigate(&mut self, url: &str) -> Result<()> {
            self.did.push(format!("open {url}"));
            Ok(())
        }
        async fn click(&mut self, s: &str) -> Result<()> {
            self.clicks += 1;
            self.did.push(format!("click {s}"));
            // flaky_until 为 0 = 一直失败；否则前几次失败、之后成功。
            let still_failing = self.flaky_until == 0 || self.clicks <= self.flaky_until;
            if self.fail_on.iter().any(|f| f == s) && still_failing {
                bail!("没有 {s}");
            }
            Ok(())
        }
        async fn type_text(&mut self, s: &str, t: &str) -> Result<()> {
            self.did.push(format!("type {s}={t}"));
            Ok(())
        }
        async fn press(&mut self, k: &str) -> Result<()> {
            self.did.push(format!("press {k}"));
            Ok(())
        }
        async fn scroll(&mut self, _: &str, _: i64) -> Result<()> {
            Ok(())
        }
        async fn visible(&mut self, s: &str) -> Result<bool> {
            Ok(self.text.contains_key(s))
        }
        async fn extract(&mut self, s: &str) -> Result<String> {
            self.text
                .get(s)
                .cloned()
                .with_context(|| format!("没有 {s}"))
        }
    }

    fn wf(steps: Vec<StepDef>) -> Workflow {
        Workflow {
            id: "w".into(),
            name: "测试".into(),
            steps,
        }
    }
    fn s(step: Step) -> StepDef {
        StepDef {
            step,
            on_fail: OnFail::Stop,
        }
    }

    #[tokio::test]
    async fn variables_flow_from_extract_into_later_steps() {
        let mut d = Fake::default();
        d.text.insert("#code".into(), "  A1B2 ".into());
        let out = run_with(
            &mut d,
            &wf(vec![
                s(Step::Extract {
                    selector: "#code".into(),
                    var: "code".into(),
                }),
                s(Step::Type {
                    selector: "#in".into(),
                    text: "码是{{code}}".into(),
                }),
                s(Step::Open {
                    url: "https://x/{{code}}".into(),
                }),
            ]),
            || false,
        )
        .await;
        assert!(out.ok, "{:?}", out.log);
        assert_eq!(out.vars["code"], "A1B2", "提取出来要去掉首尾空白");
        assert_eq!(d.did[0], "type #in=码是A1B2");
        assert_eq!(d.did[1], "open https://x/A1B2");
    }

    #[tokio::test]
    async fn a_failing_step_stops_by_default_skips_when_told_and_retries_when_told() {
        // 默认：停在那一步
        let mut d = Fake {
            fail_on: vec!["#no".into()],
            ..Default::default()
        };
        let out = run_with(
            &mut d,
            &wf(vec![
                s(Step::Click {
                    selector: "#no".into(),
                }),
                s(Step::Press {
                    key: "Enter".into(),
                }),
            ]),
            || false,
        )
        .await;
        assert!(!out.ok);
        assert_eq!(out.failed_at, Some(1));
        assert!(
            !d.did.iter().any(|x| x == "press Enter"),
            "停了就不该再往下"
        );

        // 跳过：继续
        let mut d = Fake {
            fail_on: vec!["#no".into()],
            ..Default::default()
        };
        let out = run_with(
            &mut d,
            &wf(vec![
                StepDef {
                    step: Step::Click {
                        selector: "#no".into(),
                    },
                    on_fail: OnFail::Skip,
                },
                s(Step::Press {
                    key: "Enter".into(),
                }),
            ]),
            || false,
        )
        .await;
        assert!(out.ok);
        assert!(!out.log[0].ok && out.log[0].message.contains("已跳过"));
        assert!(d.did.iter().any(|x| x == "press Enter"));

        // 重试：第二次就好了
        let mut d = Fake {
            fail_on: vec!["#flaky".into()],
            flaky_until: 1,
            ..Default::default()
        };
        let out = run_with(
            &mut d,
            &wf(vec![StepDef {
                step: Step::Click {
                    selector: "#flaky".into(),
                },
                on_fail: OnFail::Retry { times: 3 },
            }]),
            || false,
        )
        .await;
        assert!(out.ok, "{:?}", out.log);
        assert_eq!(d.clicks, 2);
        assert!(out.log[0].message.contains("重试 1 次"));
    }

    #[tokio::test]
    async fn if_jumps_and_loop_repeats_a_range() {
        let mut d = Fake::default();
        d.text.insert("#status".into(), "已登录".into());
        // 1 提取 → 2 如果包含"已登录"跳到 4 → 3 点登录（不该执行）→ 4 按 Tab → 5 循环 4..4 两次
        let out = run_with(
            &mut d,
            &wf(vec![
                s(Step::Extract {
                    selector: "#status".into(),
                    var: "st".into(),
                }),
                s(Step::If {
                    var: "st".into(),
                    op: Cond::Contains,
                    value: "已登录".into(),
                    goto: 4,
                }),
                s(Step::Click {
                    selector: "#login".into(),
                }),
                s(Step::Press { key: "Tab".into() }),
                s(Step::Loop {
                    from: 4,
                    to: 4,
                    times: 2,
                }),
            ]),
            || false,
        )
        .await;
        assert!(out.ok, "{:?}", out.log);
        assert!(
            !d.did.iter().any(|x| x == "click #login"),
            "条件成立就该跳过登录"
        );
        // 第 4 步自然跑一次，Loop 再让它跑两次 → 一共 3 次
        assert_eq!(d.did.iter().filter(|x| *x == "press Tab").count(), 3);

        // 范围写在 Loop 后面是不合法的：不循环，直接走过去，也不报错卡住
        let mut d = Fake::default();
        let out = run_with(
            &mut d,
            &wf(vec![
                s(Step::Loop {
                    from: 2,
                    to: 2,
                    times: 5,
                }),
                s(Step::Press { key: "Tab".into() }),
            ]),
            || false,
        )
        .await;
        assert!(out.ok);
        assert_eq!(
            d.did.iter().filter(|x| *x == "press Tab").count(),
            1,
            "范围在后面就当没有循环"
        );
    }

    #[tokio::test]
    async fn a_jump_that_never_ends_is_cut_off() {
        let mut d = Fake::default();
        d.text.insert("#x".into(), "yes".into());
        // 1 提取 → 2 非空就跳回 1：死循环
        let out = run_with(
            &mut d,
            &wf(vec![
                s(Step::Extract {
                    selector: "#x".into(),
                    var: "v".into(),
                }),
                s(Step::If {
                    var: "v".into(),
                    op: Cond::NotEmpty,
                    value: String::new(),
                    goto: 1,
                }),
            ]),
            || false,
        )
        .await;
        assert!(!out.ok);
        assert!(out.log.last().unwrap().message.contains("死循环"));
    }

    #[tokio::test]
    async fn cancel_is_honoured_between_steps() {
        let mut d = Fake::default();
        let calls = std::cell::Cell::new(0);
        let out = run_with(
            &mut d,
            &wf(vec![
                s(Step::Press { key: "Tab".into() }),
                s(Step::Press { key: "Tab".into() }),
                s(Step::Press { key: "Tab".into() }),
            ]),
            || {
                calls.set(calls.get() + 1);
                calls.get() > 2
            },
        )
        .await;
        assert!(!out.ok);
        assert_eq!(d.did.len(), 2, "第三步之前被取消");
        assert!(out.log.last().unwrap().message.contains("已取消"));
    }

    #[test]
    fn steps_serialize_the_way_the_editor_writes_them() {
        let json = r##"{"id":"w1","name":"登录","steps":[
            {"type":"open","url":"https://a"},
            {"type":"click","selector":"#b","onFail":{"mode":"retry","times":2}},
            {"type":"waitFor","selector":"#c"},
            {"type":"if","var":"v","op":"contains","value":"x","goto":0},
            {"type":"loop","from":1,"to":2,"times":3}
        ]}"##;
        let wf: Workflow = serde_json::from_str(json).unwrap();
        assert_eq!(wf.steps.len(), 5);
        assert_eq!(wf.steps[1].on_fail, OnFail::Retry { times: 2 });
        assert_eq!(wf.steps[0].on_fail, OnFail::Stop, "不写就是停");
        assert!(
            matches!(
                wf.steps[2].step,
                Step::WaitFor {
                    timeout_ms: 10_000,
                    ..
                }
            ),
            "默认等 10 秒"
        );
    }
}
