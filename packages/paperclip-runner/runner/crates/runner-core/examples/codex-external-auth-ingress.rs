//! Provider-free executable fixture for the real inherited-FD boundary.
//! This example never launches Codex, calls an owner, or contacts a provider.
use paperclip_runner_core::codex_external_auth::{install_trusted_pipe, ExternalAuthRunBinding};
#[path = "../src/bin/support/external_auth_fd.rs"]
mod external_auth_fd;
fn main() {
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        if std::env::args().skip(1).collect::<Vec<_>>() != ["--synthetic-only"] {
            return Err("synthetic-only fixture flag required".into());
        }
        let pipe = external_auth_fd::take_selected()?.ok_or("synthetic pipe required")?;
        let reference = install_trusted_pipe(
            pipe,
            &ExternalAuthRunBinding {
                run_id: "synthetic-run",
                environment_lease_id: "synthetic-lease",
                normalized_session_id: "synthetic-session",
                runner_instance_id: "synthetic-runner",
            },
        )?;
        if reference.authority_id != "synthetic-authority"
            || reference.profile_ref != "fixture@example.invalid"
        {
            return Err("only the generated synthetic authority is accepted".into());
        }
        println!(
            "{}",
            serde_json::json!({"result":"pass","scope":"synthetic_ingress_only","providerSpawned":false,"accountAuthenticationProved":false})
        );
        Ok(())
    })();
    if result.is_err() {
        eprintln!("synthetic_ingress_failed");
        std::process::exit(1);
    }
}
