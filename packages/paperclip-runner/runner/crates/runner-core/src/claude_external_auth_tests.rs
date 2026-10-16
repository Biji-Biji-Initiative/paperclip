use super::*;
use serde_json::{json, Value};
use std::io::Write;
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicU64, Ordering};
static NONCE: AtomicU64 = AtomicU64::new(0);
const PLAN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
fn actual() -> ActualRun<'static> {
    ActualRun {
        run_id: "run",
        environment_lease_id: "lease",
        normalized_session_id: "session",
        runner_instance_id: "runner",
        worker_plan_sha256: PLAN,
    }
}
fn envelope() -> Value {
    let until = now_ms().unwrap() + 60_000;
    json!({"reference": {"schema":"factory.claude-setup-token-reference.v1","provider":"claude",
        "authorityId":"fixture-authority","admissionId":"admission","capabilityId":"capability","companyId":COMPANY,
        "profileRef":"caam:claude:fixture","runId":"run","environmentLeaseId":"lease","normalizedSessionId":"session",
        "runnerInstanceId":"runner","workerPlanSha256":PLAN,"admittedUntilUnixMs":until},
        "accessToken":"sk-ant-oat01-SYNTHETIC_INFERENCE_ONLY_0123456789", "accessTokenExpiresAtUnixMs":until+5_000})
}
fn ingress(value: &Value) -> Result<ClaudeIngress> {
    ClaudeIngress::from_bytes(&serde_json::to_vec(value).unwrap(), &actual())
}
fn assert_reason(result: Result<ClaudeIngress>, reason: Reason) {
    assert_eq!(result.err().unwrap(), ClaudeHold(reason));
}
fn pipe_file() -> (File, std::io::PipeWriter) {
    let (read, write) = std::io::pipe().unwrap();
    let owned: OwnedFd = read.into();
    (File::from(owned), write)
}
#[test]
fn projects_distinct_closed_frames_and_caps_source_expiry() {
    let source = envelope();
    let mut owner = ingress(&source).unwrap();
    let frames = owner
        .consume_for_sidecar(
            &actual(),
            Path::new("/runtime/native"),
            Path::new("/workspace/proposal"),
        )
        .unwrap();
    let public: Value = serde_json::from_slice(&frames.metadata).unwrap();
    let private: Value = serde_json::from_slice(&frames.private).unwrap();
    assert_eq!(public.as_object().unwrap().len(), 12);
    assert_eq!(private.as_object().unwrap().len(), 11);
    assert_eq!(public["schema"], "paperclip.factory-claude-sidecar.v1");
    assert_eq!(private["schema"], "paperclip.factory-claude-access.v1");
    assert_eq!(
        private["expiresAtMs"],
        source["reference"]["admittedUntilUnixMs"]
    );
    assert_ne!(private["expiresAtMs"], source["accessTokenExpiresAtUnixMs"]);
    assert_eq!(private["accessToken"], source["accessToken"]);
    for key in [
        "companyId",
        "authorityId",
        "profileRef",
        "accessTokenExpiresAtUnixMs",
        "accessToken",
    ] {
        assert!(public.get(key).is_none());
    }
    assert!(private.get("deadlineAtMs").is_none());
    assert_eq!(
        owner
            .consume_for_sidecar(
                &actual(),
                Path::new("/runtime/native"),
                Path::new("/workspace/proposal")
            )
            .err()
            .unwrap(),
        ClaudeHold(Reason::Consumed)
    );
}
#[test]
fn validates_every_actual_identity_and_independent_plan_anchor() {
    for field in [
        "companyId",
        "runId",
        "environmentLeaseId",
        "normalizedSessionId",
        "runnerInstanceId",
        "workerPlanSha256",
    ] {
        let mut value = envelope();
        value["reference"][field] = json!(if field == "workerPlanSha256" {
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        } else {
            "foreign"
        });
        assert_reason(ingress(&value), Reason::Foreign);
    }
    let mut expected = actual();
    expected.worker_plan_sha256 = "";
    assert_reason(
        ClaudeIngress::from_bytes(&serde_json::to_vec(&envelope()).unwrap(), &expected),
        Reason::Foreign,
    );
}
#[test]
fn projected_sources_are_independent_cloexec_above4_and_end_at_eof() {
    let mut owner = ingress(&envelope()).unwrap();
    let frames = owner
        .consume_for_sidecar(
            &actual(),
            Path::new("/runtime/native"),
            Path::new("/workspace/proposal"),
        )
        .unwrap();
    let sources = frames.into_sources().unwrap();
    sources.check_live().unwrap();
    assert!(sources.metadata.as_raw_fd() >= 5 && sources.access.as_raw_fd() >= 5);
    assert_ne!(sources.metadata.as_raw_fd(), sources.access.as_raw_fd());
    for fd in [&sources.metadata, &sources.access] {
        assert!(rustix::io::fcntl_getfd(fd)
            .unwrap()
            .contains(rustix::io::FdFlags::CLOEXEC));
    }
    let mut metadata = String::new();
    let mut private = String::new();
    File::from(sources.metadata)
        .read_to_string(&mut metadata)
        .unwrap();
    File::from(sources.access)
        .read_to_string(&mut private)
        .unwrap();
    assert!(serde_json::from_str::<Value>(&metadata)
        .unwrap()
        .get("accessToken")
        .is_none());
    assert!(serde_json::from_str::<Value>(&private)
        .unwrap()
        .get("accessToken")
        .is_some());
}

#[test]
fn public_authority_survives_consumption_but_cannot_authorize_rotation_or_expiry() {
    let mut owner = ingress(&envelope()).unwrap();
    let mut authority = owner.authority().unwrap();
    owner
        .consume_for_sidecar(
            &actual(),
            Path::new("/runtime/native"),
            Path::new("/workspace"),
        )
        .unwrap();
    authority.assert_live(&actual()).unwrap();
    let mut foreign = actual();
    foreign.environment_lease_id = "foreign";
    assert_eq!(
        authority.assert_live(&foreign),
        Err(ClaudeHold(Reason::Foreign))
    );
    authority.deadline = Instant::now();
    assert_eq!(
        authority.assert_live(&actual()),
        Err(ClaudeHold(Reason::Expired))
    );
    assert_eq!(
        owner.reference().err().unwrap(),
        ClaudeHold(Reason::Consumed)
    );
}
#[test]
fn rejects_foreign_provider_and_reference_schema() {
    for (field, value) in [
        ("provider", "codex"),
        ("schema", "paperclip.codex-external-auth.v1"),
        ("admissionId", "../admission"),
        ("authorityId", "unsafe authority"),
    ] {
        let mut source = envelope();
        source["reference"][field] = json!(value);
        assert_reason(ingress(&source), Reason::Foreign);
    }
}
#[test]
fn rejects_non_inference_prefix_and_malformed_tokens() {
    for token in [
        "sk-ant-api03-SYNTHETIC_FORBIDDEN_0123456789",
        "sk-ant-oat02-SYNTHETIC_FORBIDDEN_0123456789",
        "sk-ant-oat01-short",
        "sk-ant-oat01-SYNTHETIC_WITH_NEWLINE_0123456789\n",
    ] {
        let mut source = envelope();
        source["accessToken"] = json!(token);
        assert_reason(ingress(&source), Reason::Malformed);
    }
    let mut source = envelope();
    source["accessToken"] = json!(format!("sk-ant-oat01-{}", "x".repeat(4096)));
    assert_reason(ingress(&source), Reason::Malformed);
}
#[test]
fn closed_schemas_reject_refresh_and_account_fields() {
    for nested in [true, false] {
        for field in [
            "refreshToken",
            "idToken",
            "chatgptAccountId",
            "chatgptPlanType",
        ] {
            let mut source = envelope();
            if nested {
                source["reference"][field] = json!("forbidden");
            } else {
                source[field] = json!("forbidden");
            }
            assert_reason(ingress(&source), Reason::Malformed);
        }
    }
}
#[test]
fn duplicate_keys_are_not_silently_accepted() {
    let source = serde_json::to_string(&envelope()).unwrap();
    let duplicate = format!(
        "{},\"accessToken\":\"second\"}}",
        &source[..source.len() - 1]
    );
    assert_reason(
        ClaudeIngress::from_bytes(duplicate.as_bytes(), &actual()),
        Reason::Malformed,
    );
}
#[test]
fn deadlines_are_json_safe_bounded_and_have_source_expiry_margin() {
    for deadline in [
        0,
        now_ms().unwrap() - 1,
        now_ms().unwrap() + 301_000,
        MAX_SAFE_INTEGER + 1,
    ] {
        let mut source = envelope();
        source["reference"]["admittedUntilUnixMs"] = json!(deadline);
        assert_reason(ingress(&source), Reason::Expired);
    }
    let mut source = envelope();
    source["accessTokenExpiresAtUnixMs"] =
        json!(source["reference"]["admittedUntilUnixMs"].as_u64().unwrap() + 4999);
    assert_reason(ingress(&source), Reason::Expired);
    source["accessTokenExpiresAtUnixMs"] = json!(MAX_SAFE_INTEGER + 1);
    assert_reason(ingress(&source), Reason::Expired);
    source = envelope();
    source["reference"]["admittedUntilUnixMs"] = Value::Bool(true);
    assert_reason(ingress(&source), Reason::Malformed);
}
#[test]
fn failed_projection_consumes_instead_of_replaying() {
    for path in [
        "/",
        "/runtime/../other",
        "/runtime//other",
        "/runtime/./other",
        "/runtime/trailing/",
    ] {
        let mut owner = ingress(&envelope()).unwrap();
        assert_eq!(
            owner
                .consume_for_sidecar(&actual(), Path::new(path), Path::new("/workspace/proposal"))
                .err()
                .unwrap(),
            ClaudeHold(Reason::Configuration)
        );
        assert_eq!(
            owner
                .consume_for_sidecar(
                    &actual(),
                    Path::new("/runtime/valid"),
                    Path::new("/workspace/proposal")
                )
                .err()
                .unwrap(),
            ClaudeHold(Reason::Consumed)
        );
    }
}
#[test]
fn actual_owned_anonymous_pipe_requires_eof_and_closes() {
    let (read, mut write) = pipe_file();
    let raw = read.as_raw_fd();
    write
        .write_all(&serde_json::to_vec(&envelope()).unwrap())
        .unwrap();
    drop(write);
    let mut owner = ClaudeIngress::from_owned_pipe(read, &actual()).unwrap();
    assert!(!Path::new(&format!("/proc/self/fd/{raw}")).exists());
    owner
        .consume_for_sidecar(
            &actual(),
            Path::new("/runtime/native"),
            Path::new("/workspace/proposal"),
        )
        .unwrap();
}
#[test]
fn missing_eof_times_out_in_bounded_read() {
    let (read, mut write) = pipe_file();
    write
        .write_all(&serde_json::to_vec(&envelope()).unwrap())
        .unwrap();
    let started = Instant::now();
    assert_reason(
        ClaudeIngress::from_owned_pipe(read, &actual()),
        Reason::Timeout,
    );
    assert!(started.elapsed() >= READ_DEADLINE && started.elapsed() < Duration::from_secs(10));
    drop(write);
}
#[test]
fn bounded_source_and_regular_file_refusal() {
    assert_reason(
        ClaudeIngress::from_owned_pipe(File::open("/dev/null").unwrap(), &actual()),
        Reason::Source,
    );
    let (read, mut write) = pipe_file();
    let writer = std::thread::spawn(move || {
        let _ = write.write_all(&vec![b'x'; MAX_BYTES + 1]);
    });
    assert_reason(
        ClaudeIngress::from_owned_pipe(read, &actual()),
        Reason::Malformed,
    );
    writer.join().unwrap();
}
#[test]
fn selection_requires_claude_verified_bootstrap_and_cold_mode() {
    validate_mutual_exclusion(false, true).unwrap();
    assert_eq!(
        validate_mutual_exclusion(true, true),
        Err(ClaudeHold(Reason::ConflictingProvider))
    );
    validate_provider_selection("claude", "approve-paperclip", true, true).unwrap();
    for (agent, permission, flag, cold) in [
        ("codex", "approve-paperclip", true, true),
        ("claude", "auto", true, true),
        ("claude", "approve-paperclip", false, true),
        ("claude", "approve-paperclip", true, false),
    ] {
        assert_eq!(
            validate_provider_selection(agent, permission, flag, cold),
            Err(ClaudeHold(Reason::Configuration))
        );
    }
}
#[test]
fn worker_added_plan_selector_is_required_exact_and_not_duplicated() {
    const FLAG: &str = "--factory-worker-plan-sha256";
    assert_eq!(worker_plan_from_startup_args(&[], false).unwrap(), None);
    assert!(worker_plan_from_startup_args(&[], true).is_err());
    assert_eq!(
        worker_plan_from_startup_args(&[FLAG.into(), PLAN.into()], true).unwrap(),
        Some(PLAN.into())
    );
    for args in [
        vec![format!("{FLAG}={PLAN}")],
        vec![FLAG.into()],
        vec![FLAG.into(), PLAN.into(), FLAG.into(), PLAN.into()],
        vec![FLAG.into(), "A".repeat(64)],
    ] {
        assert!(worker_plan_from_startup_args(&args, true).is_err());
    }
}
#[test]
fn private_home_refuses_native_auth_and_api_fallback() {
    let previous_home = std::env::var_os("HOME");
    let home = std::env::temp_dir().join(format!(
        "claude-home-fixture-{}-{}",
        std::process::id(),
        NONCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir(&home).unwrap();
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::env::set_var("HOME", &home);
    validate_private_home_and_environment().unwrap();
    for key in [
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CONFIG_DIR",
        "NODE_OPTIONS",
    ] {
        let previous = std::env::var_os(key);
        std::env::set_var(key, "synthetic-forbidden-marker");
        assert_eq!(
            validate_private_home_and_environment(),
            Err(ClaudeHold(Reason::Configuration))
        );
        if let Some(value) = previous {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }
    std::fs::write(home.join(".claude.json"), "synthetic-unused-file").unwrap();
    assert_eq!(
        validate_private_home_and_environment(),
        Err(ClaudeHold(Reason::Configuration))
    );
    std::fs::remove_file(home.join(".claude.json")).unwrap();
    std::fs::remove_dir(&home).unwrap();
    if let Some(value) = previous_home {
        std::env::set_var("HOME", value);
    } else {
        std::env::remove_var("HOME");
    }
}
