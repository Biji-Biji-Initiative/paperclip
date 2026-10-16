//! Cold Factory Claude capability intake; no credentials are obtained here.
//! Input is an exclusively owned anonymous pipe delivered by the trusted parent.
use crate::sensitive_memory::Sensitive;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::File;
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::fd::OwnedFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const INGRESS_FD_ENV: &str = "PAPERCLIP_CLAUDE_EXTERNAL_AUTH_FD";
pub const MAX_BYTES: usize = 16 * 1024;
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
const COMPANY: &str = "740ad7ee-0c28-4e07-b9d1-ca7b35da820d";
const READ_DEADLINE: Duration = Duration::from_secs(2);
pub const BOOTSTRAP_FLAG: &str = "--factory-claude-access-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    Source,
    Timeout,
    Malformed,
    Foreign,
    Expired,
    Consumed,
    Configuration,
    ConflictingProvider,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaudeHold(pub Reason);
impl fmt::Display for ClaudeHold {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let code = match self.0 {
            Reason::Source => "unsafe_source",
            Reason::Timeout => "source_timeout",
            Reason::Malformed => "malformed_capability",
            Reason::Foreign => "binding_mismatch",
            Reason::Expired => "expired_capability",
            Reason::Consumed => "source_already_consumed",
            Reason::Configuration => "unsafe_configuration",
            Reason::ConflictingProvider => "conflicting_provider",
        };
        write!(f, "factory_claude_access_unverified:{code}")
    }
}
impl std::error::Error for ClaudeHold {}
type Result<T> = std::result::Result<T, ClaudeHold>;
fn fail<T>(reason: Reason) -> Result<T> {
    Err(ClaudeHold(reason))
}
fn now_ms() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .ok_or(ClaudeHold(Reason::Expired))
}
fn stable(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:@+-".contains(&b))
}
fn plan(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn canonical(path: &Path) -> bool {
    path.to_str().is_some_and(|s| {
        s.starts_with('/')
            && s != "/"
            && s.len() <= 4096
            && !s.ends_with('/')
            && !s.contains("//")
            && !s.split('/').any(|p| matches!(p, "." | ".."))
            && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
    })
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaudeReference {
    pub schema: String,
    pub provider: String,
    pub authority_id: String,
    pub admission_id: String,
    pub capability_id: String,
    pub company_id: String,
    pub profile_ref: String,
    pub run_id: String,
    pub environment_lease_id: String,
    pub normalized_session_id: String,
    pub runner_instance_id: String,
    pub worker_plan_sha256: String,
    pub admitted_until_unix_ms: u64,
}
pub struct ActualRun<'a> {
    pub run_id: &'a str,
    pub environment_lease_id: &'a str,
    pub normalized_session_id: &'a str,
    pub runner_instance_id: &'a str,
    // From a worker-generated startup argv selector, never provider/task JSON.
    pub worker_plan_sha256: &'a str,
}
impl ClaudeReference {
    fn validate(&self, actual: &ActualRun<'_>, now: u64) -> Result<()> {
        if self.schema != "factory.claude-setup-token-reference.v1"
            || self.provider != "claude"
            || self.company_id != COMPANY
            || !identifier(&self.authority_id, 128)
            || !identifier(&self.profile_ref, 254)
            || ![
                &self.admission_id,
                &self.capability_id,
                &self.run_id,
                &self.environment_lease_id,
                &self.normalized_session_id,
                &self.runner_instance_id,
            ]
            .iter()
            .all(|s| stable(s))
            || !plan(&self.worker_plan_sha256)
            || !plan(actual.worker_plan_sha256)
            || self.run_id != actual.run_id
            || self.environment_lease_id != actual.environment_lease_id
            || self.normalized_session_id != actual.normalized_session_id
            || self.runner_instance_id != actual.runner_instance_id
            || self.worker_plan_sha256 != actual.worker_plan_sha256
        {
            return fail(Reason::Foreign);
        }
        if self.admitted_until_unix_ms > MAX_SAFE_INTEGER
            || self.admitted_until_unix_ms <= now
            || self.admitted_until_unix_ms - now > 300_000
        {
            return fail(Reason::Expired);
        }
        Ok(())
    }
}
// Neither Clone, Debug nor Serialize: private host bytes cannot enter config.
struct Access(Sensitive<String>);
impl<'de> Deserialize<'de> for Access {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        String::deserialize(d).map(|s| Self(Sensitive::new(s)))
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    reference: ClaudeReference,
    access_token: Access,
    access_token_expires_at_unix_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FactoryBinding {
    pub admission_id: String,
    pub capability_id: String,
    pub worker_plan_sha256: String,
    pub run_id: String,
    pub normalized_session_id: String,
    pub environment_lease_id: String,
    pub runner_instance_id: String,
    pub deadline_at_ms: u64,
}
impl From<&ClaudeReference> for FactoryBinding {
    fn from(r: &ClaudeReference) -> Self {
        Self {
            admission_id: r.admission_id.clone(),
            capability_id: r.capability_id.clone(),
            worker_plan_sha256: r.worker_plan_sha256.clone(),
            run_id: r.run_id.clone(),
            normalized_session_id: r.normalized_session_id.clone(),
            environment_lease_id: r.environment_lease_id.clone(),
            runner_instance_id: r.runner_instance_id.clone(),
            deadline_at_ms: r.admitted_until_unix_ms,
        }
    }
}
struct Capability {
    reference: ClaudeReference,
    access: Access,
    deadline: Instant,
}
pub struct ClaudeIngress {
    capability: Option<Capability>,
}
/// Public authority only. It cannot recreate the consumed private capability.
#[derive(Clone)]
pub struct FactoryAuthority {
    reference: ClaudeReference,
    deadline: Instant,
}
impl FactoryAuthority {
    #[cfg(test)]
    pub(crate) fn expired_for_test(mut self) -> Self {
        self.deadline = Instant::now();
        self
    }
    pub fn assert_live(&self, actual: &ActualRun<'_>) -> Result<()> {
        self.reference.validate(actual, now_ms()?)?;
        if Instant::now() >= self.deadline {
            return fail(Reason::Expired);
        }
        Ok(())
    }
}
pub struct SidecarFrames {
    pub binding: FactoryBinding,
    pub metadata: Vec<u8>,
    // No Debug/Clone and no public accessor to these bytes in actual integration.
    pub(crate) private: Sensitive<Vec<u8>>,
    deadline: Instant,
}
/// Consumed by the parent-owned one-shot spawn wrapper, never cloneable config.
pub struct SidecarSources {
    pub binding: FactoryBinding,
    pub metadata: OwnedFd,
    pub access: OwnedFd,
    pub(crate) deadline: Instant,
}
impl SidecarSources {
    pub fn check_live(&self) -> Result<()> {
        if Instant::now() >= self.deadline || now_ms()? >= self.binding.deadline_at_ms {
            return fail(Reason::Expired);
        }
        Ok(())
    }
}
impl SidecarFrames {
    pub fn check_live(&self) -> Result<()> {
        if Instant::now() >= self.deadline || now_ms()? >= self.binding.deadline_at_ms {
            return fail(Reason::Expired);
        }
        Ok(())
    }
    pub fn into_sources(self) -> Result<SidecarSources> {
        use std::io::Write;
        use std::net::Shutdown;
        self.check_live()?;
        let deadline = self.deadline.min(Instant::now() + READ_DEADLINE);
        let make_source = |bytes: &[u8]| -> Result<OwnedFd> {
            let (read, mut write) = UnixStream::pair().map_err(|_| ClaudeHold(Reason::Source))?;
            write
                .set_nonblocking(true)
                .map_err(|_| ClaudeHold(Reason::Source))?;
            let mut offset = 0;
            while offset < bytes.len() {
                if Instant::now() >= deadline {
                    return fail(Reason::Timeout);
                }
                match write.write(&bytes[offset..]) {
                    Ok(0) => return fail(Reason::Source),
                    Ok(n) => offset += n,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => return fail(Reason::Source),
                }
            }
            write
                .shutdown(Shutdown::Write)
                .map_err(|_| ClaudeHold(Reason::Source))?;
            rustix::io::fcntl_dupfd_cloexec(&read, 5).map_err(|_| ClaudeHold(Reason::Source))
        };
        let metadata = make_source(&self.metadata)?;
        let access = make_source(&self.private)?;
        self.check_live()?;
        if Instant::now() >= deadline {
            return fail(Reason::Timeout);
        }
        Ok(SidecarSources {
            binding: self.binding,
            metadata,
            access,
            deadline: self.deadline,
        })
    }
}

impl ClaudeIngress {
    pub fn authority(&self) -> Result<FactoryAuthority> {
        let cap = self
            .capability
            .as_ref()
            .ok_or(ClaudeHold(Reason::Consumed))?;
        Ok(FactoryAuthority {
            reference: cap.reference.clone(),
            deadline: cap.deadline,
        })
    }
    pub fn reference(&self) -> Result<&ClaudeReference> {
        self.capability
            .as_ref()
            .map(|cap| &cap.reference)
            .ok_or(ClaudeHold(Reason::Consumed))
    }
    pub fn from_owned_pipe(mut pipe: File, actual: &ActualRun<'_>) -> Result<Self> {
        use rustix::fs::{fcntl_getfl, fcntl_setfl, OFlags};
        use rustix::io::{fcntl_setfd, FdFlags};
        fcntl_setfd(&pipe, FdFlags::CLOEXEC).map_err(|_| ClaudeHold(Reason::Source))?;
        let target = std::fs::read_link(format!("/proc/self/fd/{}", pipe.as_raw_fd()))
            .map_err(|_| ClaudeHold(Reason::Source))?;
        let meta = pipe.metadata().map_err(|_| ClaudeHold(Reason::Source))?;
        let uid = std::fs::metadata("/proc/self")
            .map_err(|_| ClaudeHold(Reason::Source))?
            .uid();
        if !target.to_string_lossy().starts_with("pipe:[")
            || !meta.file_type().is_fifo()
            || meta.uid() != uid
            || meta.mode() & 0o077 != 0
        {
            return fail(Reason::Source);
        }
        let flags = fcntl_getfl(&pipe).map_err(|_| ClaudeHold(Reason::Source))?;
        if flags.intersects(OFlags::WRONLY | OFlags::RDWR) {
            return fail(Reason::Source);
        }
        fcntl_setfl(&pipe, flags | OFlags::NONBLOCK).map_err(|_| ClaudeHold(Reason::Source))?;
        let deadline = Instant::now() + READ_DEADLINE;
        let mut bytes = Sensitive::new(Vec::new());
        let mut buffer = Sensitive::new([0u8; 2048]);
        loop {
            if Instant::now() >= deadline {
                return fail(Reason::Timeout);
            }
            match pipe.read(buffer.as_mut()) {
                Ok(0) => {
                    if Instant::now() >= deadline {
                        return fail(Reason::Timeout);
                    }
                    break;
                }
                Ok(n) => {
                    if bytes.len() + n > MAX_BYTES {
                        return fail(Reason::Malformed);
                    }
                    bytes.extend_from_slice(&buffer[..n]);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2))
                }
                Err(_) => return fail(Reason::Source),
            }
        }
        drop(pipe);
        Self::from_bytes(&bytes, actual)
    }
    fn from_bytes(bytes: &[u8], actual: &ActualRun<'_>) -> Result<Self> {
        if bytes.is_empty() || bytes.len() > MAX_BYTES {
            return fail(Reason::Malformed);
        }
        let started = Instant::now();
        let now = now_ms()?;
        let envelope: Envelope =
            serde_json::from_slice(bytes).map_err(|_| ClaudeHold(Reason::Malformed))?;
        envelope.reference.validate(actual, now)?;
        let until = envelope.reference.admitted_until_unix_ms;
        if envelope.access_token_expires_at_unix_ms > MAX_SAFE_INTEGER
            || envelope.access_token_expires_at_unix_ms < until + 5_000
        {
            return fail(Reason::Expired);
        }
        let token = envelope.access_token.0.as_str();
        if !(32..=4096).contains(&token.len())
            || !token.strip_prefix("sk-ant-oat01-").is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            })
        {
            return fail(Reason::Malformed);
        }
        Ok(Self {
            capability: Some(Capability {
                reference: envelope.reference,
                access: envelope.access_token,
                deadline: started + Duration::from_millis(until - now),
            }),
        })
    }
    pub fn consume_for_sidecar(
        &mut self,
        actual: &ActualRun<'_>,
        runtime: &Path,
        workspace: &Path,
    ) -> Result<SidecarFrames> {
        // Failed projection consumes this handoff too; no config repair/replay.
        let cap = self.capability.take().ok_or(ClaudeHold(Reason::Consumed))?;
        cap.reference.validate(actual, now_ms()?)?;
        if Instant::now() >= cap.deadline {
            return fail(Reason::Expired);
        }
        if !canonical(runtime) || !canonical(workspace) {
            return fail(Reason::Configuration);
        }
        let binding = FactoryBinding::from(&cap.reference);
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Metadata<'a> {
            schema: &'static str,
            provider: &'static str,
            #[serde(flatten)]
            binding: &'a FactoryBinding,
            runtime_directory: &'a Path,
            working_directory: &'a Path,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Private<'a> {
            schema: &'static str,
            provider: &'static str,
            admission_id: &'a str,
            capability_id: &'a str,
            worker_plan_sha256: &'a str,
            run_id: &'a str,
            normalized_session_id: &'a str,
            environment_lease_id: &'a str,
            runner_instance_id: &'a str,
            expires_at_ms: u64,
            access_token: &'a str,
        }
        let metadata = serde_json::to_vec(&Metadata {
            schema: "paperclip.factory-claude-sidecar.v1",
            provider: "claude",
            binding: &binding,
            runtime_directory: runtime,
            working_directory: workspace,
        })
        .map_err(|_| ClaudeHold(Reason::Malformed))?;
        let private = Sensitive::new(
            serde_json::to_vec(&Private {
                schema: "paperclip.factory-claude-access.v1",
                provider: "claude",
                admission_id: &binding.admission_id,
                capability_id: &binding.capability_id,
                worker_plan_sha256: &binding.worker_plan_sha256,
                run_id: &binding.run_id,
                normalized_session_id: &binding.normalized_session_id,
                environment_lease_id: &binding.environment_lease_id,
                runner_instance_id: &binding.runner_instance_id,
                expires_at_ms: binding.deadline_at_ms,
                access_token: cap.access.0.as_str(),
            })
            .map_err(|_| ClaudeHold(Reason::Malformed))?,
        );
        if metadata.len() > MAX_BYTES || private.len() > MAX_BYTES {
            return fail(Reason::Malformed);
        }
        let frames = SidecarFrames {
            binding,
            metadata,
            private,
            deadline: cap.deadline,
        };
        frames.check_live()?;
        Ok(frames)
    }
}

/// Pure startup selection check; empty-but-present variables still select and
/// must later fail numeric intake. Both selected is always an error.
pub fn validate_mutual_exclusion(codex: bool, claude: bool) -> Result<()> {
    if codex && claude {
        return fail(Reason::ConflictingProvider);
    }
    Ok(())
}
pub fn worker_plan_from_startup_args(args: &[String], required: bool) -> Result<Option<String>> {
    const FLAG: &str = "--factory-worker-plan-sha256";
    if args.iter().any(|arg| arg.starts_with(&format!("{FLAG}="))) {
        return fail(Reason::Configuration);
    }
    let indexes = args
        .iter()
        .enumerate()
        .filter(|(_, arg)| arg.as_str() == FLAG)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if indexes.is_empty() && !required {
        return Ok(None);
    }
    if indexes.len() != 1 {
        return fail(Reason::Configuration);
    }
    let value = args
        .get(indexes[0] + 1)
        .filter(|s| plan(s))
        .ok_or(ClaudeHold(Reason::Configuration))?;
    Ok(Some(value.clone()))
}
pub fn validate_provider_selection(
    agent: &str,
    permission: &str,
    bootstrap_flag: bool,
    cold: bool,
) -> Result<()> {
    if agent != "claude" || permission != "approve-paperclip" || !bootstrap_flag || !cold {
        return fail(Reason::Configuration);
    }
    Ok(())
}
pub fn validate_private_home_and_environment() -> Result<()> {
    for key in [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "OPENAI_API_KEY",
        "CODEX_API_KEY",
        "OPENROUTER_API_KEY",
        "XAI_API_KEY",
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "NODE_OPTIONS",
        "LD_PRELOAD",
    ] {
        if std::env::var_os(key).is_some_and(|v| !v.is_empty()) {
            return fail(Reason::Configuration);
        }
    }
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or(ClaudeHold(Reason::Configuration))?;
    if !canonical(&home) {
        return fail(Reason::Configuration);
    }
    let mut walked = PathBuf::new();
    for component in home.components() {
        walked.push(component);
        if std::fs::symlink_metadata(&walked)
            .map_err(|_| ClaudeHold(Reason::Configuration))?
            .file_type()
            .is_symlink()
        {
            return fail(Reason::Configuration);
        }
    }
    let metadata = std::fs::metadata(&home).map_err(|_| ClaudeHold(Reason::Configuration))?;
    let uid = std::fs::metadata("/proc/self")
        .map_err(|_| ClaudeHold(Reason::Configuration))?
        .uid();
    if !metadata.is_dir() || metadata.mode() & 0o077 != 0 || metadata.uid() != uid {
        return fail(Reason::Configuration);
    }
    for name in [".claude", ".claude.json", ".credentials.json"] {
        match std::fs::symlink_metadata(home.join(name)) {
            Ok(_) => return fail(Reason::Configuration),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return fail(Reason::Configuration),
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "claude_external_auth_tests.rs"]
mod tests;

#[cfg(test)]
pub(crate) fn synthetic_ingress(actual: &ActualRun<'_>) -> ClaudeIngress {
    let until = now_ms().expect("fixture wall clock") + 60_000;
    let value = serde_json::json!({"reference": {
        "schema":"factory.claude-setup-token-reference.v1", "provider":"claude",
        "authorityId":"synthetic-authority", "admissionId":"admission", "capabilityId":"capability",
        "companyId": COMPANY, "profileRef":"caam:claude:synthetic", "runId":actual.run_id,
        "environmentLeaseId":actual.environment_lease_id, "normalizedSessionId":actual.normalized_session_id,
        "runnerInstanceId":actual.runner_instance_id, "workerPlanSha256":actual.worker_plan_sha256,
        "admittedUntilUnixMs":until}, "accessToken":"sk-ant-oat01-SYNTHETIC_INFERENCE_ONLY_0123456789",
        "accessTokenExpiresAtUnixMs":until+5_000});
    ClaudeIngress::from_bytes(&serde_json::to_vec(&value).unwrap(), actual)
        .expect("synthetic capability")
}
