//! Opt-in, one-consumption ChatGPT external authentication. No refresh operation.
//!
//! This module owns sensitive memory, not the account lifecycle. The trusted
//! parent supplies a private pipe. Run/provider configuration contains ONLY the
//! authority reference. The pipe is consumed and closed before a provider spawns.
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::sensitive_memory::Sensitive;
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const INGRESS_FD_ENV: &str = "PAPERCLIP_CODEX_EXTERNAL_AUTH_FD";
pub const AUTH_HOLD_CODE: &str = "codex_external_auth_operator_required";
pub const FACTORY_COMPANY_ID: &str = "740ad7ee-0c28-4e07-b9d1-ca7b35da820d";
pub const MAX_CAPABILITY_BYTES: usize = 32 * 1024;
pub const MAX_ACCESS_BYTES: usize = 16 * 1024;
pub const MAX_ADMISSION_MS: u64 = 300_000;
const READ_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldReason {
    MissingSource,
    UnsafeSource,
    SourceAlreadyConsumed,
    MalformedCapability,
    OversizeCapability,
    SourceTimeout,
    ForeignAuthority,
    BindingMismatch,
    ExpiredCapability,
    IncompatibleProvider,
    ConflictingAuthentication,
    UnsafeConfiguration,
    RefreshRequired,
    AuthenticationRejected,
    IdentityUnverified,
    ProviderReflection,
    ProviderProtocol,
    ProviderExited,
    RecoveryNotPermitted,
}
impl HoldReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MissingSource => "missing_source",
            Self::UnsafeSource => "unsafe_source",
            Self::SourceAlreadyConsumed => "source_already_consumed",
            Self::MalformedCapability => "malformed_capability",
            Self::OversizeCapability => "oversize_capability",
            Self::SourceTimeout => "source_timeout",
            Self::ForeignAuthority => "foreign_authority",
            Self::BindingMismatch => "binding_mismatch",
            Self::ExpiredCapability => "expired_capability",
            Self::IncompatibleProvider => "incompatible_provider",
            Self::ConflictingAuthentication => "conflicting_authentication",
            Self::UnsafeConfiguration => "unsafe_configuration",
            Self::RefreshRequired => "refresh_required",
            Self::AuthenticationRejected => "authentication_rejected",
            Self::IdentityUnverified => "identity_unverified",
            Self::ProviderReflection => "provider_reflection",
            Self::ProviderProtocol => "provider_protocol",
            Self::ProviderExited => "provider_exited",
            Self::RecoveryNotPermitted => "recovery_not_permitted",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExternalAuthHold(pub HoldReason);
impl fmt::Display for ExternalAuthHold {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{AUTH_HOLD_CODE}:{}", self.0.as_str())
    }
}
impl std::error::Error for ExternalAuthHold {}
type Result<T> = std::result::Result<T, ExternalAuthHold>;
fn hold(reason: HoldReason) -> ExternalAuthHold {
    ExternalAuthHold(reason)
}

/// Nonsecret identity supplied by a reviewed authority selection. This is not
/// itself an authorization token, broker URL, executable, or profile path.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalAuthReference {
    pub schema: String,
    pub authority_id: String,
    pub capability_id: String,
    pub company_id: String,
    pub profile_ref: String,
    pub chatgpt_account_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chatgpt_plan_type: Option<String>,
    pub run_id: String,
    pub environment_lease_id: String,
    pub normalized_session_id: String,
    pub runner_instance_id: String,
    pub admitted_until_unix_ms: u64,
}

#[derive(Clone, Debug)]
pub struct ExternalAuthRunBinding<'a> {
    pub run_id: &'a str,
    pub environment_lease_id: &'a str,
    pub normalized_session_id: &'a str,
    pub runner_instance_id: &'a str,
}
fn identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:@+".contains(&c))
}
pub fn unix_ms() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .ok_or_else(|| hold(HoldReason::ExpiredCapability))
}
impl ExternalAuthReference {
    pub fn validate(&self) -> Result<()> {
        if self.schema != "paperclip.codex-external-auth.v1"
            || self.company_id != FACTORY_COMPANY_ID
            || !identifier(&self.authority_id, 128)
            || !identifier(&self.capability_id, 128)
            || !identifier(&self.profile_ref, 254)
            || !identifier(&self.chatgpt_account_id, 128)
            || !identifier(&self.run_id, 128)
            || !identifier(&self.environment_lease_id, 128)
            || !identifier(&self.normalized_session_id, 128)
            || !identifier(&self.runner_instance_id, 128)
            || !matches!(self.chatgpt_plan_type.as_deref(), Some("team" | "business"))
        {
            return Err(hold(HoldReason::ForeignAuthority));
        }
        Ok(())
    }
    pub fn assert_run(&self, expected: &ExternalAuthRunBinding<'_>) -> Result<()> {
        self.validate()?;
        if self.run_id != expected.run_id
            || self.environment_lease_id != expected.environment_lease_id
            || self.normalized_session_id != expected.normalized_session_id
            || self.runner_instance_id != expected.runner_instance_id
        {
            return Err(hold(HoldReason::BindingMismatch));
        }
        Ok(())
    }
}

// Intentionally neither Debug, Clone nor Serialize. This value cannot enter a
// provider configuration, diagnostic, durable PRP payload, or general log.
struct AccessMaterial(Sensitive<String>);
impl<'de> Deserialize<'de> for AccessMaterial {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(d).map(|s| Self(Sensitive::new(s)))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityEnvelope {
    reference: ExternalAuthReference,
    access_token: AccessMaterial,
    access_token_expires_at_unix_ms: u64,
}

/// Sensitive in-memory guard, never serializable or debuggable. A monotonic
/// deadline prevents a backwards wall-clock step from extending admission.
pub struct ExternalAuthGuard {
    reference: ExternalAuthReference,
    access: AccessMaterial,
    reflections: Vec<Sensitive<String>>,
    deadline: Instant,
    hold: Option<HoldReason>,
}
impl ExternalAuthGuard {
    fn from_bytes(bytes: &[u8], now: u64) -> Result<Self> {
        if bytes.len() > MAX_CAPABILITY_BYTES {
            return Err(hold(HoldReason::OversizeCapability));
        }
        let envelope: CapabilityEnvelope =
            serde_json::from_slice(bytes).map_err(|_| hold(HoldReason::MalformedCapability))?;
        envelope.reference.validate()?;
        let until = envelope.reference.admitted_until_unix_ms;
        if until <= now
            || until.saturating_sub(now) > MAX_ADMISSION_MS
            || envelope.access_token_expires_at_unix_ms < until.saturating_add(5_000)
        {
            return Err(hold(HoldReason::ExpiredCapability));
        }
        let token = envelope.access_token.0.as_str();
        if !(32..=MAX_ACCESS_BYTES).contains(&token.len())
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            return Err(hold(HoldReason::MalformedCapability));
        }
        let segments: Vec<&str> = token.split('.').collect();
        if segments.len() != 3 || segments.iter().any(|s| s.is_empty()) {
            return Err(hold(HoldReason::MalformedCapability));
        }
        // Consistency/expiry check only, NOT issuer/signature/entitlement proof.
        // The protected authority owns validation; Codex validates real access.
        let claims_bytes = Sensitive::new(
            URL_SAFE_NO_PAD
                .decode(segments[1])
                .map_err(|_| hold(HoldReason::MalformedCapability))?,
        );
        let claims: Value = serde_json::from_slice(&claims_bytes)
            .map_err(|_| hold(HoldReason::MalformedCapability))?;
        let jwt_exp = claims
            .get("exp")
            .and_then(Value::as_u64)
            .and_then(|v| v.checked_mul(1000))
            .ok_or_else(|| hold(HoldReason::MalformedCapability))?;
        if jwt_exp < envelope.access_token_expires_at_unix_ms || jwt_exp < until {
            return Err(hold(HoldReason::ExpiredCapability));
        }
        if claims
            .pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id")
            .and_then(Value::as_str)
            != Some(envelope.reference.chatgpt_account_id.as_str())
        {
            return Err(hold(HoldReason::BindingMismatch));
        }
        if let Some(plan) = &envelope.reference.chatgpt_plan_type {
            if claims
                .pointer("/https:~1~1api.openai.com~1auth/chatgpt_plan_type")
                .and_then(Value::as_str)
                != Some(plan.as_str())
            {
                return Err(hold(HoldReason::BindingMismatch));
            }
        }
        let reflections = vec![
            Sensitive::new(token.to_owned()),
            Sensitive::new(STANDARD.encode(token)),
            Sensitive::new(STANDARD_NO_PAD.encode(token)),
            Sensitive::new(URL_SAFE.encode(token)),
            Sensitive::new(URL_SAFE_NO_PAD.encode(token)),
            Sensitive::new(token.bytes().map(|b| format!("{b:02x}")).collect()),
            Sensitive::new(token.bytes().map(|b| format!("{b:02X}")).collect()),
            Sensitive::new(token.bytes().map(|b| format!("%{b:02X}")).collect()),
            Sensitive::new(token.bytes().map(|b| format!("%{b:02x}")).collect()),
        ];
        Ok(Self {
            reference: envelope.reference,
            access: envelope.access_token,
            reflections,
            deadline: Instant::now() + Duration::from_millis(until - now),
            hold: None,
        })
    }
    pub fn reference(&self) -> &ExternalAuthReference {
        &self.reference
    }
    pub fn check_live(&self) -> Result<()> {
        if let Some(reason) = self.hold {
            return Err(hold(reason));
        }
        if Instant::now() >= self.deadline || unix_ms()? >= self.reference.admitted_until_unix_ms {
            return Err(hold(HoldReason::ExpiredCapability));
        }
        Ok(())
    }
    pub fn latch(&mut self, reason: HoldReason) -> ExternalAuthHold {
        let reason = *self.hold.get_or_insert(reason);
        hold(reason)
    }
    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
    fn sensitive(&self, value: &Value) -> bool {
        match value {
            Value::String(s) => self
                .reflections
                .iter()
                .any(|needle| s.contains(needle.as_str())),
            Value::Array(a) => a.iter().any(|v| self.sensitive(v)),
            Value::Object(m) => m.iter().any(|(k, v)| {
                matches!(
                    k.as_str(),
                    "accessToken"
                        | "access_token"
                        | "refreshToken"
                        | "refresh_token"
                        | "idToken"
                        | "id_token"
                ) || self
                    .reflections
                    .iter()
                    .any(|needle| k.contains(needle.as_str()))
                    || self.sensitive(v)
            }),
            _ => false,
        }
    }
    /// BEFORE trace/pending queues/events/errors. Authentication callbacks are
    /// control messages, never model tool calls. Generic errors lose raw details.
    pub fn inspect_inbound(&self, line: &str) -> Result<Inbound> {
        let mut value: Value =
            serde_json::from_str(line).map_err(|_| hold(HoldReason::ProviderProtocol))?;
        if !value.is_object() {
            return Err(hold(HoldReason::ProviderProtocol));
        }
        if self.sensitive(&value) {
            return Err(hold(HoldReason::ProviderReflection));
        }
        if value.get("method").and_then(Value::as_str) == Some("account/chatgptAuthTokens/refresh")
        {
            let id = value
                .get("id")
                .cloned()
                .filter(safe_rpc_id)
                .ok_or_else(|| hold(HoldReason::ProviderProtocol))?;
            return Ok(Inbound::RefreshDenied(id));
        }
        self.check_live()?;
        if let Some(method) = value.get("method").and_then(Value::as_str) {
            if method == "account/login/completed"
                && value.pointer("/params/success") == Some(&Value::Bool(false))
            {
                return Err(hold(HoldReason::AuthenticationRejected));
            }
            if method == "account/updated"
                && value.pointer("/params/authMode").and_then(Value::as_str)
                    != Some("chatgptAuthTokens")
            {
                return Err(hold(HoldReason::IdentityUnverified));
            }
            if method == "account/updated" {
                for path in ["/params/chatgptAccountId", "/params/accountId"] {
                    if value.pointer(path).is_some_and(|actual|
                        actual.as_str() != Some(self.reference.chatgpt_account_id.as_str()))
                    {
                        return Err(hold(HoldReason::IdentityUnverified));
                    }
                }
                if let Some(plan) = self.reference.chatgpt_plan_type.as_deref() {
                    for path in ["/params/chatgptPlanType", "/params/planType"] {
                        if value.pointer(path).is_some_and(|actual| actual.as_str() != Some(plan)) {
                            return Err(hold(HoldReason::IdentityUnverified));
                        }
                    }
                }
            }
            if matches!(
                method,
                "warning" | "configWarning" | "log" | "account/login/completed" | "account/updated"
            ) {
                return Ok(Inbound::Discard);
            }
        }
        if [
            "/params/error/httpStatusCode",
            "/params/turn/error/httpStatusCode",
            "/params/error/status",
            "/error/data/httpStatusCode",
        ]
        .iter()
        .any(|path| value.pointer(path).and_then(Value::as_i64) == Some(401))
            || value.pointer("/params/error/code").and_then(Value::as_i64) == Some(401)
            || value
                .pointer("/params/error/statusCode")
                .and_then(Value::as_i64)
                == Some(401)
            || value
                .pointer("/params/turn/error/code")
                .and_then(Value::as_i64)
                == Some(401)
        {
            return Err(hold(HoldReason::AuthenticationRejected));
        }
        if value.get("error").is_some() {
            let status = value.pointer("/error/code").and_then(Value::as_i64);
            if status == Some(401)
                || value
                    .pointer("/error/data/statusCode")
                    .and_then(Value::as_i64)
                    == Some(401)
            {
                return Err(hold(HoldReason::AuthenticationRejected));
            }
            value["error"] = json!({"code": status.unwrap_or(-32000), "message": "external provider rejected request; details withheld"});
        }
        Ok(Inbound::Message(value.to_string()))
    }
    /// Only this private wire type serializes the access material, directly into
    /// a bounded provider stdin write. It must never pass ProviderTraceSink.
    pub(crate) fn login_request(&self, id: u64) -> ExternalLoginRequest<'_> {
        ExternalLoginRequest {
            id,
            method: "account/login/start",
            params: ExternalLoginParams {
                login_type: "chatgptAuthTokens",
                access_token: self.access.0.as_str(),
                chatgpt_account_id: &self.reference.chatgpt_account_id,
                chatgpt_plan_type: self.reference.chatgpt_plan_type.as_deref(),
            },
        }
    }
    pub(crate) fn verify_account(&self, account: &Value) -> Result<()> {
        if account.pointer("/account/type").and_then(Value::as_str) != Some("chatgpt") {
            return Err(hold(HoldReason::IdentityUnverified));
        }
        if let Some(plan) = &self.reference.chatgpt_plan_type {
            if account.pointer("/account/planType").and_then(Value::as_str) != Some(plan.as_str()) {
                return Err(hold(HoldReason::IdentityUnverified));
            }
        }
        self.check_live()
    }
}
fn safe_rpc_id(value: &Value) -> bool {
    value.as_i64().is_some()
        || value.as_u64().is_some()
        || value.as_str().is_some_and(|s| identifier(s, 128))
}
pub enum Inbound {
    Message(String),
    Discard,
    RefreshDenied(Value),
}
#[derive(Serialize)]
pub(crate) struct ExternalLoginRequest<'a> {
    id: u64,
    method: &'static str,
    params: ExternalLoginParams<'a>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalLoginParams<'a> {
    #[serde(rename = "type")]
    login_type: &'static str,
    access_token: &'a str,
    chatgpt_account_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    chatgpt_plan_type: Option<&'a str>,
}

struct InstalledIngress {
    reference: ExternalAuthReference,
    guard: Option<ExternalAuthGuard>,
}
static INGRESS: OnceLock<Mutex<InstalledIngress>> = OnceLock::new();

/// Called by the trusted runner executable once, BEFORE it connects/executes.
/// File is an owned anonymous pipe descriptor. EOF is mandatory. The descriptor
/// is CLOEXEC/nonblocking and dropped before this returns, on success or error.
#[cfg(target_os = "linux")]
pub fn install_trusted_pipe(
    mut pipe: File,
    binding: &ExternalAuthRunBinding<'_>,
) -> Result<ExternalAuthReference> {
    use rustix::fs::{fcntl_getfl, fcntl_setfl, OFlags};
    use rustix::io::{fcntl_setfd, FdFlags};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    if INGRESS.get().is_some() {
        return Err(hold(HoldReason::SourceAlreadyConsumed));
    }
    fcntl_setfd(&pipe, FdFlags::CLOEXEC).map_err(|_| hold(HoldReason::UnsafeSource))?;
    let descriptor_target = std::fs::read_link(format!("/proc/self/fd/{}", pipe.as_raw_fd()))
        .map_err(|_| hold(HoldReason::UnsafeSource))?;
    if !descriptor_target.to_string_lossy().starts_with("pipe:[") {
        return Err(hold(HoldReason::UnsafeSource));
    }
    let metadata = pipe
        .metadata()
        .map_err(|_| hold(HoldReason::UnsafeSource))?;
    let self_uid = std::fs::metadata("/proc/self")
        .map_err(|_| hold(HoldReason::UnsafeSource))?
        .uid();
    if !metadata.file_type().is_fifo() || metadata.uid() != self_uid || metadata.mode() & 0o077 != 0
    {
        return Err(hold(HoldReason::UnsafeSource));
    }
    let flags = fcntl_getfl(&pipe).map_err(|_| hold(HoldReason::UnsafeSource))?;
    if flags.contains(OFlags::WRONLY) || flags.contains(OFlags::RDWR) {
        return Err(hold(HoldReason::UnsafeSource));
    }
    fcntl_setfl(&pipe, flags | OFlags::NONBLOCK).map_err(|_| hold(HoldReason::UnsafeSource))?;
    let deadline = Instant::now() + READ_TIMEOUT;
    let mut bytes = Sensitive::new(Vec::new());
    let mut buffer = Sensitive::new([0u8; 2048]);
    loop {
        if Instant::now() >= deadline {
            return Err(hold(HoldReason::SourceTimeout));
        }
        match pipe.read(buffer.as_mut()) {
            Ok(0) => {
                if Instant::now() >= deadline {
                    return Err(hold(HoldReason::SourceTimeout));
                }
                break;
            }
            Ok(n) => {
                if bytes.len().saturating_add(n) > MAX_CAPABILITY_BYTES {
                    return Err(hold(HoldReason::OversizeCapability));
                }
                bytes.extend_from_slice(&buffer[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(hold(HoldReason::SourceTimeout));
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            Err(_) => return Err(hold(HoldReason::UnsafeSource)),
        }
        if Instant::now() >= deadline {
            return Err(hold(HoldReason::SourceTimeout));
        }
    }
    drop(pipe);
    let guard = ExternalAuthGuard::from_bytes(&bytes, unix_ms()?)?;
    guard.reference.assert_run(binding)?;
    let reference = guard.reference.clone();
    INGRESS
        .set(Mutex::new(InstalledIngress {
            reference: reference.clone(),
            guard: Some(guard),
        }))
        .map_err(|_| hold(HoldReason::SourceAlreadyConsumed))?;
    Ok(reference)
}
#[cfg(not(target_os = "linux"))]
pub fn install_trusted_pipe(
    _pipe: File,
    _binding: &ExternalAuthRunBinding<'_>,
) -> Result<ExternalAuthReference> {
    Err(hold(HoldReason::UnsafeSource))
}
pub fn selected() -> bool {
    INGRESS.get().is_some()
}
pub fn assert_selected_run(
    binding: &ExternalAuthRunBinding<'_>,
    provider: Option<&str>,
) -> Result<()> {
    if let Some(slot) = INGRESS.get() {
        if provider.is_some_and(|p| p != "codex") {
            return Err(hold(HoldReason::IncompatibleProvider));
        }
        let slot = slot.lock().map_err(|_| hold(HoldReason::UnsafeSource))?;
        slot.reference.assert_run(binding)?;
    }
    Ok(())
}
pub(crate) fn consume_for_provider(
    reference: Option<&ExternalAuthReference>,
) -> Result<Option<ExternalAuthGuard>> {
    // The authenticated worker delivers the reference inside its one-shot pipe.
    // It is intentionally absent from run.prepare/config. An optional wire
    // reference may narrow that selection, but never supplies authority itself.
    let Some(slot) = INGRESS.get() else {
        return if reference.is_some() {
            Err(hold(HoldReason::MissingSource))
        } else {
            Ok(None)
        };
    };
    let mut installed = slot.lock().map_err(|_| hold(HoldReason::UnsafeSource))?;
    if let Some(reference) = reference {
        reference.validate()?;
        if &installed.reference != reference {
            return Err(hold(HoldReason::BindingMismatch));
        }
    }
    let guard = installed
        .guard
        .take()
        .ok_or_else(|| hold(HoldReason::SourceAlreadyConsumed))?;
    guard.check_live()?;
    Ok(Some(guard))
}

/// Applied only when external mode is explicitly selected. The parent still
/// owns policy/endpoint eligibility; this is the final provider launch backstop.
pub fn validate_external_launch(provider: &str, driver: &str, args: &[String]) -> Result<()> {
    if provider != "codex" || driver != "codex_app_server" {
        return Err(hold(HoldReason::IncompatibleProvider));
    }
    for key in [
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_API_BASE",
        "CODEX_BASE_URL",
        "OPENROUTER_API_KEY",
        "ANTHROPIC_API_KEY",
        "XAI_API_KEY",
        "PAPERCLIP_CODEX_PROVIDERS",
        "PAPERCLIP_OPENCODE_PROVIDERS",
        "CODEX_APP_SERVER_LOGIN_ISSUER",
        "CODEX_LOGIN_ISSUER",
        "CODEX_APP_SERVER_BASE_URL",
        "OPENAI_API_HOST",
        "LD_PRELOAD",
        "NODE_OPTIONS",
    ] {
        if std::env::var_os(key).is_some_and(|v| !v.is_empty()) {
            return Err(hold(HoldReason::ConflictingAuthentication));
        }
    }
    validate_private_provider_home()?;
    // Only the existing reviewed security arguments are accepted. Unknown
    // config namespaces cannot introduce providers, auth helpers or endpoints.
    let mut i = 0;
    let mut app_server = false;
    while i < args.len() {
        let arg = &args[i];
        if arg == "app-server" && !app_server {
            app_server = true;
            i += 1;
            continue;
        }
        if arg == "--listen" && args.get(i + 1).map(String::as_str) == Some("stdio://") {
            i += 2;
            continue;
        }
        if arg == "--disable" && args.get(i + 1).map(String::as_str) == Some("image_generation") {
            i += 2;
            continue;
        }
        if arg == "-c" || arg == "--config" {
            let value = args
                .get(i + 1)
                .ok_or_else(|| hold(HoldReason::UnsafeConfiguration))?;
            let document = value
                .parse::<toml_edit::DocumentMut>()
                .map_err(|_| hold(HoldReason::UnsafeConfiguration))?;
            if document.len() != 1 {
                return Err(hold(HoldReason::UnsafeConfiguration));
            }
            let key = document.iter().next().map(|(key, _)| key).unwrap_or("");
            if !matches!(
                key,
                "default_permissions" | "permissions" | "shell_environment_policy"
            ) {
                return Err(hold(HoldReason::UnsafeConfiguration));
            }
            // The trusted parent must restrict permissions. Here, reject an
            // auth-capable shell env even inside an otherwise permitted table.
            for denied in [
                "API_KEY",
                "AUTH_TOKEN",
                "OAUTH_TOKEN",
                "auth.json",
                "model_provider",
                "base_url",
                "CODEX_HOME",
                "LD_PRELOAD",
                "BASH_ENV",
            ] {
                if value.contains(denied) && key == "shell_environment_policy" {
                    return Err(hold(HoldReason::UnsafeConfiguration));
                }
            }
            i += 2;
            continue;
        }
        return Err(hold(HoldReason::UnsafeConfiguration));
    }
    if !app_server {
        return Err(hold(HoldReason::UnsafeConfiguration));
    }
    Ok(())
}

/// Refuse host/native credentials and project auth configuration before Codex
/// can inspect them during initialize. No credential file is opened or copied.
fn validate_private_provider_home() -> Result<()> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    use std::path::{Component, Path};
    for key in ["HOME", "CODEX_HOME"] {
        let raw = std::env::var_os(key).ok_or_else(|| hold(HoldReason::UnsafeConfiguration))?;
        let path = Path::new(&raw);
        if !path.is_absolute()
            || path == Path::new("/")
            || path
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        {
            return Err(hold(HoldReason::UnsafeConfiguration));
        }
        let mut walked = std::path::PathBuf::new();
        for component in path.components() {
            walked.push(component.as_os_str());
            if std::fs::symlink_metadata(&walked)
                .map_err(|_| hold(HoldReason::UnsafeConfiguration))?
                .file_type()
                .is_symlink()
            {
                return Err(hold(HoldReason::UnsafeConfiguration));
            }
        }
        let meta = std::fs::metadata(path).map_err(|_| hold(HoldReason::UnsafeConfiguration))?;
        if !meta.is_dir() {
            return Err(hold(HoldReason::UnsafeConfiguration));
        }
        #[cfg(unix)]
        if meta.mode() & 0o077 != 0 {
            return Err(hold(HoldReason::UnsafeConfiguration));
        }
        #[cfg(target_os = "linux")]
        if meta.uid()
            != std::fs::metadata("/proc/self")
                .map_err(|_| hold(HoldReason::UnsafeConfiguration))?
                .uid()
        {
            return Err(hold(HoldReason::UnsafeConfiguration));
        }
        for name in [
            "auth.json",
            "auth-refresh.json",
            "config.toml",
            ".codex/auth.json",
            ".codex/config.toml",
        ] {
            match std::fs::symlink_metadata(path.join(name)) {
                Ok(_) => return Err(hold(HoldReason::ConflictingAuthentication)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(hold(HoldReason::UnsafeConfiguration)),
            }
        }
    }
    Ok(())
}

pub fn validate_project_auth_absent(cwd: &std::path::Path) -> Result<()> {
    if !cwd.is_absolute() {
        return Err(hold(HoldReason::UnsafeConfiguration));
    }
    for directory in cwd.ancestors() {
        for name in [".codex/config.toml", ".codex/auth.json"] {
            match std::fs::symlink_metadata(directory.join(name)) {
                Ok(_) => return Err(hold(HoldReason::ConflictingAuthentication)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(hold(HoldReason::UnsafeConfiguration)),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "codex_external_auth_tests.rs"]
mod tests;
