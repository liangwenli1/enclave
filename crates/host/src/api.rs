//! 给脚本用的本机 API（`/api/v1/*`）的权限模型。
//!
//! 它不是第二个服务：同一个 Host、同一个端口，只是换了一套凭据和一个更窄的权限面。
//!   - 工作台令牌 → `/v1/*`，什么都能做。
//!   - API 令牌   → `/api/v1/*`，能做什么由档位决定。
//!
//! 档位是工作台验过许可证签名之后告诉 Host 的；Host 自己不验签。
//! 这和"额度在客户端强制"是同一个信任模型，没有额外放宽。
use crate::kernel::{FingerprintProfile, SearchProvider};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ApiLevel {
    /// 免费档：不能开
    #[default]
    Off,
    /// 只读：列出环境、看运行状态和调试端口
    Discover,
    /// 还能启动和停止环境
    Full,
}

/// 启动一个环境需要的全部参数。工作台启动和脚本启动用的是同一份结构。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSpec {
    pub profile: FingerprintProfile,
    #[serde(default)]
    pub extra_flags: Vec<String>,
    #[serde(default)]
    pub allow_no_sandbox: bool,
    #[serde(default)]
    pub allow_preview_channel: bool,
    pub proxy_server: Option<String>,
    pub search_engine: Option<String>,
    pub search_provider: Option<SearchProvider>,
}

/// 工作台推过来的一个环境：名字给脚本看，spec 用来启动。
/// **只放内存**：spec 里有带密码的代理地址，落盘就等于绕过了保险箱。
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    pub spec: StartSpec,
}

/// 这个档位能不能做这件事。
pub fn allows(level: ApiLevel, method: &str, path: &str) -> bool {
    let read_only = method == "GET";
    match level {
        ApiLevel::Off => false,
        ApiLevel::Discover => read_only && path.starts_with("/api/v1/"),
        ApiLevel::Full => path.starts_with("/api/v1/"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_allows_nothing() {
        assert!(!allows(ApiLevel::Off, "GET", "/api/v1/environments"));
        assert!(!allows(ApiLevel::Off, "POST", "/api/v1/environments/x/start"));
    }

    #[test]
    fn discover_is_read_only() {
        assert!(allows(ApiLevel::Discover, "GET", "/api/v1/environments"));
        assert!(allows(ApiLevel::Discover, "GET", "/api/v1/environments/env_1"));
        assert!(!allows(ApiLevel::Discover, "POST", "/api/v1/environments/env_1/start"));
        assert!(!allows(ApiLevel::Discover, "POST", "/api/v1/environments/env_1/stop"));
    }

    #[test]
    fn full_can_start_and_stop() {
        assert!(allows(ApiLevel::Full, "POST", "/api/v1/environments/env_1/start"));
        assert!(allows(ApiLevel::Full, "POST", "/api/v1/environments/env_1/stop"));
    }

    #[test]
    fn api_token_never_reaches_workbench_routes() {
        // /v1/* 是工作台的路径，API 档位再高也不放行。
        for level in [ApiLevel::Discover, ApiLevel::Full] {
            assert!(!allows(level, "GET", "/v1/kernel"));
            assert!(!allows(level, "POST", "/v1/environments/start"));
            assert!(!allows(level, "POST", "/v1/api/config"));
        }
    }

    #[test]
    fn level_parses_from_licence_strings() {
        assert_eq!(serde_json::from_str::<ApiLevel>("\"off\"").unwrap(), ApiLevel::Off);
        assert_eq!(serde_json::from_str::<ApiLevel>("\"discover\"").unwrap(), ApiLevel::Discover);
        assert_eq!(serde_json::from_str::<ApiLevel>("\"full\"").unwrap(), ApiLevel::Full);
    }
}
