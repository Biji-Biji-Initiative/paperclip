//! Actual CodexProvider/ProcessSupervisor integration with a stdio-only fixture.
//! Each scenario runs in a fresh test process: no real HOME, CAAM or provider.
use super::*;
use crate::codex_external_auth::{
    self, ExternalAuthReference, ExternalAuthRunBinding, FACTORY_COMPANY_ID,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;

fn reference(now: u64) -> ExternalAuthReference {
    serde_json::from_value(json!({"schema":"paperclip.codex-external-auth.v1",
        "authorityId":"fixture-owner","capabilityId":"fixture-capability",
        "companyId":FACTORY_COMPANY_ID,"profileRef":"fixture@example.invalid",
        "chatgptAccountId":"fixture-account","chatgptPlanType":"team",
        "runId":"fixture-run","environmentLeaseId":"fixture-lease",
        "normalizedSessionId":"fixture-session","runnerInstanceId":"fixture-runner",
        "admittedUntilUnixMs":now+60_000}))
    .unwrap()
}
fn binding() -> ExternalAuthRunBinding<'static> {
    ExternalAuthRunBinding {
        run_id: "fixture-run",
        environment_lease_id: "fixture-lease",
        normalized_session_id: "fixture-session",
        runner_instance_id: "fixture-runner",
    }
}
fn envelope(r: &ExternalAuthReference, now: u64) -> (String, Vec<u8>) {
    let token=format!("{}.{}.synthetic-signature-never-a-real-token",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#),
        URL_SAFE_NO_PAD.encode(json!({"exp":(now+120_000)/1000,
            "https://api.openai.com/auth":{"chatgpt_account_id":"fixture-account","chatgpt_plan_type":"team"}}).to_string()));
    let bytes=json!({"reference":r,"accessToken":token,"accessTokenExpiresAtUnixMs":(now+120_000)/1000*1000}).to_string().into_bytes();
    (token, bytes)
}
fn install(
    bytes: Vec<u8>,
    expected: &ExternalAuthRunBinding<'_>,
) -> Result<ExternalAuthReference, codex_external_auth::ExternalAuthHold> {
    let (read, write) = std::io::pipe().unwrap();
    let pipe = std::fs::File::from(std::os::fd::OwnedFd::from(read));
    pipe.set_permissions(std::fs::Permissions::from_mode(0o600))
        .unwrap();
    let raw = pipe.as_raw_fd();
    std::env::set_var(codex_external_auth::INGRESS_FD_ENV, raw.to_string());
    let sender = std::thread::spawn(move || {
        let mut output = std::fs::File::from(std::os::fd::OwnedFd::from(write));
        let _ = output.write_all(&bytes);
    });
    let result = codex_external_auth::install_trusted_pipe(pipe, expected);
    sender.join().unwrap();
    assert!(
        std::fs::read_link(format!("/proc/self/fd/{raw}")).is_err(),
        "ingress must close before provider spawn"
    );
    result
}
fn scan(path: &Path, needles: &[String]) {
    for entry in std::fs::read_dir(path).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if entry.file_type().unwrap().is_dir() {
            scan(&path, needles)
        } else if entry.file_type().unwrap().is_file() {
            let body = std::fs::read(&path).unwrap();
            for n in needles {
                assert!(
                    !body.windows(n.len()).any(|w| w == n.as_bytes()),
                    "sensitive bytes persisted"
                );
            }
            assert_ne!(path.file_name().unwrap(), "auth.json");
        }
    }
}
fn scenario(name: &str) {
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "codex_provider::external_engine_tests::fixture_child",
            "--nocapture",
        ])
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("FACTORY_EXTERNAL_TEST_CASE", name)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "isolated scenario {} failed: {} {}",
        name,
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}
macro_rules! case {
    ($name:ident) => {
        #[test]
        fn $name() {
            scenario(stringify!($name));
        }
    };
}
case!(success);
case!(resume);
case!(configured_resume);
case!(external_sandbox_config);
case!(external_sandbox_environment);
case!(refresh_pending);
case!(refresh_async);
case!(reflect_raw);
case!(reflect_base64);
case!(early_exit);
case!(silent_exit);
case!(account_missing);
case!(expired_during_turn);
case!(missing_source);
case!(duplicate_consumption);
case!(api_key_denied);
case!(endpoint_denied);
case!(provider_override_denied);
case!(normal_trace_unchanged);
case!(unsafe_regular_file);
case!(non_eof_source_timeout);
case!(foreign_run);
case!(refresh_thread_pending);
case!(malformed_provider_frame);
case!(stored_auth_denied);
case!(project_override_denied);
case!(foreign_reference);
case!(oversize_pipe);
case!(trusted_pipe_without_wire_reference);
case!(incompatible_provider);
case!(reflect_async);
case!(http401_async);
case!(auth_response_timeout);

#[test]
fn fixture_child() {
    let Ok(name) = std::env::var("FACTORY_EXTERNAL_TEST_CASE") else {
        return;
    };
    let root = std::env::temp_dir().join(format!("factory-external-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone());
    for dir in ["home", "codex", "workspace"] {
        std::fs::create_dir(root.join(dir)).unwrap();
        std::fs::set_permissions(root.join(dir), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::env::set_var("HOME", root.join("home"));
    std::env::set_var("CODEX_HOME", root.join("codex"));
    std::env::set_var("PAPERCLIP_PROVIDER_TRACE_PATH", root.join("trace.jsonl"));
    let now = codex_external_auth::unix_ms().unwrap();
    let mut r = reference(now);
    if name == "expired_during_turn" {
        r.admitted_until_unix_ms = now + 10_000;
    }
    let (token, bytes) = envelope(&r, now);
    if name == "unsafe_regular_file" {
        let p = root.join("not-a-pipe");
        std::fs::write(&p, b"not secret").unwrap();
        assert_eq!(
            codex_external_auth::install_trusted_pipe(std::fs::File::open(p).unwrap(), &binding())
                .err()
                .unwrap()
                .0,
            HoldReason::UnsafeSource
        );
        return;
    }
    if name == "non_eof_source_timeout" {
        let (read, _write) = std::io::pipe().unwrap();
        let pipe = std::fs::File::from(std::os::fd::OwnedFd::from(read));
        pipe.set_permissions(std::fs::Permissions::from_mode(0o600))
            .unwrap();
        let start = std::time::Instant::now();
        assert_eq!(
            codex_external_auth::install_trusted_pipe(pipe, &binding())
                .err()
                .unwrap()
                .0,
            HoldReason::SourceTimeout
        );
        assert!(start.elapsed() < Duration::from_secs(3));
        return;
    }
    if name == "oversize_pipe" {
        assert_eq!(
            install(
                vec![b'x'; codex_external_auth::MAX_CAPABILITY_BYTES + 1],
                &binding()
            )
            .err()
            .unwrap()
            .0,
            HoldReason::OversizeCapability
        );
        return;
    }
    if name == "foreign_run" {
        let mut b = binding();
        b.run_id = "another-run";
        assert_eq!(
            install(bytes, &b).err().unwrap().0,
            HoldReason::BindingMismatch
        );
        return;
    }
    if !matches!(name.as_str(), "missing_source" | "normal_trace_unchanged") {
        install(bytes, &binding()).unwrap();
    }
    let fixture = include_str!("../../../tests/fixtures/codex-external-auth-server.py");
    let events = root.join("events");
    let program = root.join("synthetic-provider.py");
    let body = format!(
        "#!/usr/bin/python3\nSCENARIO={}\nEVENTS={}\n{}",
        json!(name),
        json!(events.to_string_lossy()),
        fixture
    );
    std::fs::write(&program, body).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut config: CodexProviderConfig =
        serde_json::from_value(json!({"provider":"codex","driver":"codex_app_server",
        "providerVersion":"codex-app-server-v1","command":program,"args":["app-server"],
        "cwd":root.join("workspace"),"externalAuth":r}))
        .unwrap();
    if matches!(
        name.as_str(),
        "normal_trace_unchanged" | "trusted_pipe_without_wire_reference"
    ) {
        config.external_auth = None;
    }
    if name == "incompatible_provider" {
        config.provider = "opencode".into();
        config.driver = "opencode_server".into();
        config.external_auth = None;
    }
    if name == "configured_resume" {
        config.provider_session_id = Some("thread-fixture".into());
    }
    if name == "external_sandbox_config" {
        config.externally_sandboxed = true;
    }
    if name == "external_sandbox_environment" {
        std::env::set_var("PAPERCLIP_RUNNER_EXTERNAL_SANDBOX", "1");
    }
    if name == "stored_auth_denied" {
        std::fs::write(root.join("codex/auth.json"), b"synthetic-placeholder").unwrap();
    }
    if name == "project_override_denied" {
        std::fs::create_dir(root.join("workspace/.codex")).unwrap();
        std::fs::write(
            root.join("workspace/.codex/config.toml"),
            b"model_provider=\"other\"",
        )
        .unwrap();
    }
    if name == "foreign_reference" {
        config.external_auth.as_mut().unwrap().authority_id = "other-owner".into();
    }
    if name == "api_key_denied" {
        std::env::set_var("OPENAI_API_KEY", "synthetic-forbidden-api-marker");
    }
    if name == "endpoint_denied" {
        std::env::set_var("OPENAI_BASE_URL", "https://never-contact.invalid");
    }
    if name == "provider_override_denied" {
        config.args = vec![
            "-c".into(),
            "model_provider=\"other\"".into(),
            "app-server".into(),
        ];
    }
    let mut spawned = 0;
    let mut reaped = false;
    let started = CodexProvider::start_with_tools_observed(
        &config,
        std::iter::empty(),
        if name == "resume" {
            Some("thread-fixture")
        } else {
            None
        },
        1,
        None,
        None,
        &mut |o| {
            match o {
                ProviderStartupObservation::Spawned { .. } => spawned += 1,
                ProviderStartupObservation::Failed { child_exit, .. } => {
                    reaped = child_exit.is_some()
                }
            };
            Ok(())
        },
    );
    if matches!(
        name.as_str(),
        "missing_source"
            | "api_key_denied"
            | "endpoint_denied"
            | "provider_override_denied"
            | "stored_auth_denied"
            | "project_override_denied"
            | "foreign_reference"
            | "incompatible_provider"
            | "resume"
            | "configured_resume"
            | "external_sandbox_config"
            | "external_sandbox_environment"
    ) {
        let error = started.err().expect("must reject before spawn");
        assert!(error
            .to_string()
            .contains(codex_external_auth::AUTH_HOLD_CODE));
        assert_eq!(spawned, 0);
        assert!(!events.exists());
    } else if matches!(
        name.as_str(),
        "refresh_pending"
            | "refresh_thread_pending"
            | "malformed_provider_frame"
            | "reflect_raw"
            | "reflect_base64"
            | "account_missing"
            | "auth_response_timeout"
            | "early_exit"
            | "silent_exit"
    ) {
        let error = started.err().expect("must hold");
        assert!(!error.to_string().contains(&token));
        assert_eq!(spawned, 1);
        assert!(
            reaped,
            "startup failure must observe direct-child retirement"
        );
        let log = std::fs::read_to_string(&events).unwrap();
        if name != "refresh_thread_pending" {
            assert!(!log.contains("thread/start"));
        }
        assert!(!log.contains("turn/start"));
        if name.starts_with("refresh_") {
            assert!(log.contains("refresh_response_denied"));
        }
    } else {
        let mut provider = started.unwrap();
        if matches!(
            name.as_str(),
            "refresh_async" | "expired_during_turn" | "reflect_async" | "http401_async"
        ) {
            provider
                .request(
                    "turn/start",
                    json!({"threadId":"thread-fixture","input":[]}),
                )
                .unwrap();
            if name == "expired_during_turn" {
                std::thread::sleep(Duration::from_millis(
                    r.admitted_until_unix_ms
                        .saturating_sub(codex_external_auth::unix_ms().unwrap())
                        + 50,
                ));
            }
            let mut error = None;
            for _ in 0..50 {
                match provider.poll() {
                    Err(e) => {
                        error = Some(e);
                        break;
                    }
                    _ => std::thread::sleep(Duration::from_millis(10)),
                }
            }
            assert!(error
                .unwrap()
                .to_string()
                .contains(codex_external_auth::AUTH_HOLD_CODE));
        }
        let _ = provider.retire_failed_startup();
        drop(provider);
        if name == "duplicate_consumption" {
            assert!(CodexProvider::start(&config, None)
                .err()
                .unwrap()
                .to_string()
                .contains("source_already_consumed"));
        }
        let log = std::fs::read_to_string(&events).unwrap();
        if name != "normal_trace_unchanged" {
            assert!(log.starts_with("initialize\ninitialized\naccount/login/start\naccount/read\n"));
            assert!(!log.contains("account/logout"));
            if name == "refresh_async" {
                assert!(log.contains("refresh_response_denied"));
            }
        }
    }
    let trace = std::fs::read_to_string(root.join("trace.jsonl")).unwrap_or_default();
    if name == "normal_trace_unchanged" {
        assert!(trace.contains("rawBase64"));
    } else {
        assert!(!trace.contains("rawBase64"));
        assert!(!trace.contains("sha256:"));
    }
    if name == "stored_auth_denied" {
        std::fs::remove_file(root.join("codex/auth.json")).unwrap();
    }
    scan(
        &root,
        &[
            token.clone(),
            URL_SAFE_NO_PAD.encode(&token),
            base64::engine::general_purpose::STANDARD.encode(&token),
        ],
    );
}
