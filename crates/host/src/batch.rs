//! 批量执行：选一批环境，一次对它们做同一件事。
//!
//! 排队的规矩由服务器定：同时运行数是账号下所有电脑合计的，超了服务器会拒。
//! 所以这里不自己发明配额，而是**把"额度满了"当成"等一下再来"**——
//! 这恰恰就是队列该有的行为。真正的失败（内核哈希对不上、代理连不上）不重试，直接记下来。
//!
//! 不做定时。Host 是工作台的随行进程，关掉应用它就没了；
//! 在这种形态下提供"定时任务"是骗人的——要做得先决定常驻后台，那是另一件事。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

/// 一个环境在这一批里的状态。
#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Waiting,
    Running,
    Done,
    Failed,
    Skipped,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub env_id: String,
    pub state: State,
    /// 失败时的原因码和人话。
    pub code: String,
    pub message: String,
    /// 重试过几次。
    pub tries: u32,
}

#[derive(Clone, Serialize)]
pub struct Run {
    pub id: String,
    pub action: String,
    pub items: Vec<Item>,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub cancelled: bool,
}

impl Run {
    pub fn counts(&self) -> (usize, usize, usize) {
        let done = self.items.iter().filter(|i| i.state == State::Done).count();
        let failed = self
            .items
            .iter()
            .filter(|i| i.state == State::Failed)
            .count();
        (done, failed, self.items.len())
    }
}

/// 最近几次批量执行。只留在内存里：它是"刚才那一批怎么样了"，不是账本——
/// 账本是服务器上的操作日志，启动和被拒都已经记在那里。
#[derive(Default)]
pub struct Runs {
    inner: Mutex<HashMap<String, Run>>,
    order: Mutex<Vec<String>>,
}

/// 最多留几次。再多就不是"刚才那一批"了。
const KEEP: usize = 10;

impl Runs {
    pub fn start(&self, id: &str, action: &str, env_ids: &[String], now: u64) {
        let run = Run {
            id: id.to_string(),
            action: action.to_string(),
            items: env_ids
                .iter()
                .map(|env_id| Item {
                    env_id: env_id.clone(),
                    state: State::Waiting,
                    code: String::new(),
                    message: String::new(),
                    tries: 0,
                })
                .collect(),
            started_at: now,
            finished_at: None,
            cancelled: false,
        };
        self.inner.lock().unwrap().insert(id.to_string(), run);
        let mut order = self.order.lock().unwrap();
        order.push(id.to_string());
        while order.len() > KEEP {
            let old = order.remove(0);
            self.inner.lock().unwrap().remove(&old);
        }
    }

    pub fn update(&self, run_id: &str, env_id: &str, f: impl FnOnce(&mut Item)) {
        if let Some(run) = self.inner.lock().unwrap().get_mut(run_id) {
            if let Some(item) = run.items.iter_mut().find(|i| i.env_id == env_id) {
                f(item);
            }
        }
    }

    pub fn finish(&self, run_id: &str, now: u64) {
        if let Some(run) = self.inner.lock().unwrap().get_mut(run_id) {
            run.finished_at = Some(now);
        }
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        match self.inner.lock().unwrap().get_mut(run_id) {
            Some(run) if run.finished_at.is_none() => {
                run.cancelled = true;
                // 还没轮到的直接标成跳过，界面立刻看得出来。
                for item in run.items.iter_mut() {
                    if item.state == State::Waiting {
                        item.state = State::Skipped;
                    }
                }
                true
            }
            _ => false,
        }
    }

    /// 和 `cancelled` 一样，只是名字说明白了：它是同步的，解释器每一步之前都会问。
    pub fn cancelled_sync(&self, run_id: &str) -> bool {
        self.cancelled(run_id)
    }

    pub fn cancelled(&self, run_id: &str) -> bool {
        self.inner
            .lock()
            .unwrap()
            .get(run_id)
            .is_some_and(|r| r.cancelled)
    }

    /// 最近的在前。
    pub fn list(&self) -> Vec<Run> {
        let inner = self.inner.lock().unwrap();
        self.order
            .lock()
            .unwrap()
            .iter()
            .rev()
            .filter_map(|id| inner.get(id).cloned())
            .collect()
    }
}

/* ── 同一个出口别扎堆 ──────────────────────────────────────────
   同一个代理（同一个出口 IP）上同时冒出十个登录，风控立刻就来了。
   所以批量启动时，同一个代理最多几个在手上、两次之间至少隔多久。
   不绑代理的环境走本机网络，各自独立，不受这条限制。 */

/// 一个出口同时最多几个。
pub const PER_PROXY_LIMIT: usize = 2;
/// 同一个出口两次启动之间至少隔多久（秒）。
pub const PER_PROXY_GAP: u64 = 30;

#[derive(Default)]
pub struct Gate {
    /// 代理 id → (手上几个, 上一次是什么时候)
    inner: Mutex<HashMap<String, (usize, u64)>>,
}

impl Gate {
    /// 现在能不能轮到这个代理上的环境。不能的话返回还要等几秒。
    pub fn admit(&self, proxy_id: Option<&str>, now_ms: u64) -> Result<(), u64> {
        let Some(proxy) = proxy_id else {
            return Ok(()); // 不绑代理：走本机网络，各自独立。
        };
        let mut inner = self.inner.lock().unwrap();
        let (running, last) = inner.get(proxy).copied().unwrap_or((0, 0));
        if running >= PER_PROXY_LIMIT {
            return Err(3);
        }
        let waited = now_ms.saturating_sub(last) / 1000;
        if last > 0 && waited < PER_PROXY_GAP {
            return Err(PER_PROXY_GAP - waited);
        }
        inner.insert(proxy.to_string(), (running + 1, now_ms));
        Ok(())
    }

    /// 这个环境启动完了（成功或失败都算），把位子让出来。
    pub fn release(&self, proxy_id: Option<&str>) {
        let Some(proxy) = proxy_id else { return };
        let mut inner = self.inner.lock().unwrap();
        if let Some((running, last)) = inner.get(proxy).copied() {
            inner.insert(proxy.to_string(), (running.saturating_sub(1), last));
        }
    }
}

/// 这个原因码值不值得等一会儿再试。
///
/// 额度满了、环境正被另一台电脑开着、暂时连不上服务器——都是"等一下"；
/// 内核文件对不上、代理连不上、环境不存在——是真的错，重试多少次都一样。
pub fn worth_retrying(code: &str) -> bool {
    matches!(
        code,
        "PLAN_CONCURRENT_LIMIT" | "PROFILE_LOCKED" | "CLOUD_UNREACHABLE" | "LEASE_UNAVAILABLE"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_transient_failures_are_retried() {
        for code in [
            "PLAN_CONCURRENT_LIMIT",
            "PROFILE_LOCKED",
            "CLOUD_UNREACHABLE",
            "LEASE_UNAVAILABLE",
        ] {
            assert!(worth_retrying(code), "{code} 该等一下再试");
        }
        // 这些重试多少次都是同一个结果，重试只会拖长整批的时间。
        for code in [
            "KERNEL_HASH_MISMATCH",
            "KERNEL_CHANNEL_BLOCKED",
            "PROXY_UNREACHABLE",
            "PROXY_PASSWORD_MISSING",
            "VAULT_LOCKED",
            "PLAN_ENV_LIMIT",
            "ROLE_FORBIDDEN",
            "BAD_ENV_ID",
            "",
        ] {
            assert!(!worth_retrying(code), "{code} 不该重试");
        }
    }

    #[test]
    fn a_cancelled_run_skips_whatever_had_not_started() {
        let runs = Runs::default();
        let ids: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        runs.start("r1", "start", &ids, 1);
        runs.update("r1", "a", |i| i.state = State::Done);
        runs.update("r1", "b", |i| i.state = State::Running);

        assert!(runs.cancel("r1"));
        let run = runs.list().into_iter().next().unwrap();
        let state = |env: &str| run.items.iter().find(|i| i.env_id == env).unwrap().state;
        assert!(state("a") == State::Done, "做完的不动");
        assert!(state("b") == State::Running, "正在跑的不动");
        assert!(state("c") == State::Skipped, "还没轮到的标成跳过");
        assert!(runs.cancelled("r1"));
    }

    #[test]
    fn one_exit_ip_is_not_flooded() {
        let gate = Gate::default();
        // t(秒) 换成毫秒，读起来就是"第几秒"。
        let t = |sec: u64| 1_000_000 + sec * 1000;

        assert!(gate.admit(Some("p"), t(0)).is_ok(), "第一个直接放行");
        assert!(gate.admit(Some("p"), t(10)).is_err(), "才过 10 秒，间隔不够");
        assert!(gate.admit(Some("p"), t(30)).is_ok(), "隔够 30 秒，第二个放行");
        assert!(gate.admit(Some("p"), t(90)).is_err(), "手上已经两个了");

        gate.release(Some("p"));
        assert!(gate.admit(Some("p"), t(35)).is_err(), "位子有了，但离上次才 5 秒");
        assert!(gate.admit(Some("p"), t(60)).is_ok(), "位子有了、间隔也够");

        // 别的代理各算各的。
        assert!(gate.admit(Some("q"), t(0)).is_ok());
        // 不绑代理的走本机网络，永远放行。
        for _ in 0..5 {
            assert!(gate.admit(None, t(0)).is_ok());
        }
    }

    /// 界面按 camelCase 读这些字段。少一个 rename_all，那一列就是空的——
    /// 而且不会报错、不会有异常，只是安静地什么都不显示。
    #[test]
    fn items_go_out_in_the_shape_the_ui_reads() {
        let item = Item {
            env_id: "env_1".into(),
            state: State::Failed,
            code: "PROXY_UNREACHABLE".into(),
            message: "代理无法连接".into(),
            tries: 2,
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"envId\":\"env_1\""), "界面读的是 envId：{json}");
        assert!(!json.contains("env_id"), "别再发 env_id：{json}");
        assert!(json.contains("\"state\":\"failed\""), "状态是小写的：{json}");
    }

    #[test]
    fn only_the_last_few_runs_are_kept() {
        let runs = Runs::default();
        for i in 0..15 {
            runs.start(&format!("r{i}"), "start", &["a".to_string()], i as u64);
        }
        let list = runs.list();
        assert_eq!(list.len(), KEEP);
        assert_eq!(list[0].id, "r14", "最近的在前");
    }
}
