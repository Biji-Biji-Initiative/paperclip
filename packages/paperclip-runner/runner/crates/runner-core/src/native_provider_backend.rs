use std::path::PathBuf;

use serde_json::Value;

use crate::acpx_provider_backend::{AcpxCommandExecutor, ACPX_PROVIDER_STATE_FILE};
use crate::durable::{
    Command, CommandExecution, CommandExecutor, DurableRunnerConfig, DurableRunnerError,
    PolledEvent, TerminalDeliveryReconciliation,
};
use crate::managed_provider_backend::{
    ManagedProviderCommandExecutor, MANAGED_PROVIDER_STATE_FILE,
};
use crate::provider_backend::{CodexCommandExecutor, CODEX_PROVIDER_STATE_FILE};
use crate::subscription_auth_hold::{self, ProtectedSubscription, SubscriptionAuthHold};

enum SelectedExecutor {
    LocalFacade(CodexCommandExecutor),
    Acpx(AcpxCommandExecutor),
    Managed(ManagedProviderCommandExecutor),
}

impl SelectedExecutor {
    fn record_subscription_auth_hold(&mut self, hold: SubscriptionAuthHold) -> Result<(), DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.record_subscription_auth_hold(hold),
            Self::Acpx(executor) => executor.record_subscription_auth_hold(hold),
            Self::Managed(_) => Err(DurableRunnerError::invalid("subscription hold provider mismatch")),
        }
    }
}

impl CommandExecutor for SelectedExecutor {
    fn can_reconcile_result_delivery(&mut self) -> Result<bool, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.can_reconcile_result_delivery(),
            Self::Acpx(executor) => executor.can_reconcile_result_delivery(),
            Self::Managed(executor) => executor.can_reconcile_result_delivery(),
        }
    }

    fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.retained_events(),
            Self::Acpx(executor) => executor.retained_events(),
            Self::Managed(executor) => executor.retained_events(),
        }
    }
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.execute(command),
            Self::Acpx(executor) => executor.execute(command),
            Self::Managed(executor) => executor.execute(command),
        }
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.poll_events(),
            Self::Acpx(executor) => executor.poll_events(),
            Self::Managed(executor) => executor.poll_events(),
        }
    }

    fn rotate_authority(&mut self, config: &DurableRunnerConfig) {
        match self {
            Self::LocalFacade(executor) => executor.rotate_authority(config),
            Self::Acpx(executor) => executor.rotate_authority(config),
            Self::Managed(executor) => executor.rotate_authority(config),
        }
    }

    fn maintain_backpressured_provider(&mut self) -> Result<(), DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.maintain_backpressured_provider(),
            Self::Acpx(executor) => executor.maintain_backpressured_provider(),
            Self::Managed(executor) => executor.maintain_backpressured_provider(),
        }
    }

    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.acknowledge_events(count),
            Self::Acpx(executor) => executor.acknowledge_events(count),
            Self::Managed(executor) => executor.acknowledge_events(count),
        }
    }

    fn reconcile_terminal_delivery(
        &mut self,
    ) -> Result<TerminalDeliveryReconciliation, DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.reconcile_terminal_delivery(),
            Self::Acpx(executor) => executor.reconcile_terminal_delivery(),
            Self::Managed(executor) => executor.reconcile_terminal_delivery(),
        }
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        match self {
            Self::LocalFacade(executor) => executor.shutdown(),
            Self::Acpx(executor) => executor.shutdown(),
            Self::Managed(executor) => executor.shutdown(),
        }
    }
}

/// Selects one durable provider implementation for the lifetime of a runner.
/// Recovery selection comes only from mutually exclusive private state files;
/// fresh selection comes only from the controller's run.prepare descriptor.
pub struct NativeProviderCommandExecutor {
    state_dir: PathBuf,
    config: DurableRunnerConfig,
    selected: Option<SelectedExecutor>,
    recovery_checked: bool,
    factory_claude: Option<crate::claude_external_auth::ClaudeIngress>,
    factory_authority: Option<crate::claude_external_auth::FactoryAuthority>,
    factory_plan: Option<String>,
    subscription_hold: Option<SubscriptionAuthHold>,
}

impl NativeProviderCommandExecutor {
    fn protected_subscription(&self) -> Option<ProtectedSubscription> {
        if self.factory_authority.is_some() { Some(ProtectedSubscription::Claude) }
        else { crate::codex_external_auth::selected().then_some(ProtectedSubscription::Codex) }
    }

    fn project_subscription_error(&self, error: DurableRunnerError) -> DurableRunnerError {
        let selected = self.protected_subscription();
        if selected.is_none() || error.subscription_hold().is_some() { return error; }
        subscription_auth_hold::native_error(selected, error, "Protected native operation failed")
    }

    fn record_subscription_auth_hold(&mut self, hold: SubscriptionAuthHold) -> Result<(), DurableRunnerError> {
        let hold = *self.subscription_hold.get_or_insert(hold);
        // No select_recovery: a lost/expired capability never grants authority
        // over a persisted process or a different executor's files.
        if let Some(executor) = self.selected.as_mut() { executor.record_subscription_auth_hold(hold)?; }
        Ok(())
    }

    pub fn with_runner_config(state_dir: impl Into<PathBuf>, config: &DurableRunnerConfig) -> Self {
        Self {
            state_dir: state_dir.into(),
            config: config.clone(),
            selected: None,
            recovery_checked: false,
            factory_claude: None,
            factory_authority: None,
            factory_plan: None,
            subscription_hold: None,
        }
    }

    pub fn with_factory_claude(
        state_dir: impl Into<PathBuf>,
        config: &DurableRunnerConfig,
        ingress: crate::claude_external_auth::ClaudeIngress,
        plan: String,
    ) -> Result<Self, DurableRunnerError> {
        let authority = ingress
            .authority()
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        let mut executor = Self::with_runner_config(state_dir, config);
        executor.factory_claude = Some(ingress);
        executor.factory_authority = Some(authority);
        executor.factory_plan = Some(plan);
        executor.assert_factory_authority()?;
        Ok(executor)
    }

    fn assert_factory_authority(&self) -> Result<(), DurableRunnerError> {
        if let Some(authority) = &self.factory_authority {
            authority
                .assert_live(&crate::claude_external_auth::ActualRun {
                    run_id: &self.config.run_id,
                    environment_lease_id: &self.config.environment_lease_id,
                    normalized_session_id: &self.config.normalized_session_id,
                    runner_instance_id: &self.config.runner_instance_id,
                    worker_plan_sha256: self.factory_plan.as_deref().unwrap_or(""),
                })
                .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        }
        Ok(())
    }

    fn select_recovery(&mut self) -> Result<(), DurableRunnerError> {
        if self.recovery_checked {
            return Ok(());
        }
        self.recovery_checked = true;
        let codex = self.state_dir.join(CODEX_PROVIDER_STATE_FILE).exists();
        let acpx = self.state_dir.join(ACPX_PROVIDER_STATE_FILE).exists();
        let managed = self.state_dir.join(MANAGED_PROVIDER_STATE_FILE).exists();
        if [codex, acpx, managed]
            .into_iter()
            .filter(|present| *present)
            .count()
            > 1
        {
            return Err(DurableRunnerError::invalid(
                "runner state contains conflicting provider authorities",
            ));
        }
        if self.factory_authority.is_some() && (codex || managed || acpx) {
            self.recovery_checked = false;
            return Err(DurableRunnerError::invalid(
                "factory_claude_access_unverified:recovery_not_permitted",
            ));
        }
        if crate::codex_external_auth::selected() && (codex || managed || acpx) {
            // This ingress is cold/per-turn only. A retained provider state is
            // not authority to replay or adopt an already admitted execution.
            self.recovery_checked = false;
            return Err(DurableRunnerError::invalid(
                "codex_external_auth_operator_required:recovery_not_permitted",
            ));
        }
        self.selected = if managed {
            Some(SelectedExecutor::Managed(
                ManagedProviderCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ))
        } else if acpx {
            Some(SelectedExecutor::Acpx(
                AcpxCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ))
        } else if codex {
            Some(SelectedExecutor::LocalFacade(
                CodexCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ))
        } else {
            None
        };
        Ok(())
    }

    fn select_from_payload(&mut self, payload: &Value) -> Result<(), DurableRunnerError> {
        self.assert_factory_authority()?;
        let kind = payload
            .pointer("/provider/kind")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "run.prepare requires a supported provider kind before runner execution",
                )
            })?;
        crate::codex_external_auth::assert_selected_run(
            &crate::codex_external_auth::ExternalAuthRunBinding {
                run_id: &self.config.run_id,
                environment_lease_id: &self.config.environment_lease_id,
                normalized_session_id: &self.config.normalized_session_id,
                runner_instance_id: &self.config.runner_instance_id,
            },
            Some(kind),
        )
        .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        if self.factory_authority.is_some()
            && (kind != "acpx"
                || payload.pointer("/provider/agent").and_then(Value::as_str) != Some("claude"))
        {
            return Err(DurableRunnerError::invalid(
                "factory_claude_access_unverified:incompatible_provider",
            ));
        }
        self.selected = Some(match kind {
            "codex" | "opencode" => SelectedExecutor::LocalFacade(
                CodexCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ),
            "acpx" => SelectedExecutor::Acpx(if let Some(ingress) = self.factory_claude.take() {
                AcpxCommandExecutor::with_factory_claude(
                    &self.state_dir,
                    &self.config,
                    ingress,
                    self.factory_plan
                        .clone()
                        .expect("Factory ingress has its validated plan"),
                )?
            } else if self.factory_authority.is_some() {
                return Err(DurableRunnerError::invalid(
                    "factory_claude_access_unverified:source_already_consumed",
                ));
            } else {
                AcpxCommandExecutor::with_runner_config(&self.state_dir, &self.config)
            }),
            "claude_managed" | "aws_agentcore" => SelectedExecutor::Managed(
                ManagedProviderCommandExecutor::with_runner_config(&self.state_dir, &self.config),
            ),
            _ => {
                return Err(DurableRunnerError::invalid(format!(
                    "provider kind {kind} is not executable through the local runnerd boundary"
                )))
            }
        });
        Ok(())
    }
}

impl CommandExecutor for NativeProviderCommandExecutor {
    fn can_reconcile_result_delivery(&mut self) -> Result<bool, DurableRunnerError> {
        if self.subscription_hold.is_some() { return Ok(false); }
        self.select_recovery()?;
        self.selected
            .as_mut()
            .map_or(Ok(false), CommandExecutor::can_reconcile_result_delivery)
    }

    fn retained_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        self.selected
            .as_mut()
            .map_or_else(|| Ok(Vec::new()), CommandExecutor::retained_events)
    }
    fn execute(&mut self, command: &Command) -> Result<CommandExecution, DurableRunnerError> {
        if let Some(hold) = self.subscription_hold {
            if !subscription_auth_hold::cleanup_command(&command.command_type) {
                return Err(DurableRunnerError::subscription_auth(hold));
            }
            if let Some(executor) = self.selected.as_mut() { return executor.execute(command); }
            return if command.command_type == "runner.drain" {
                Ok(CommandExecution::result(serde_json::json!({"status":"completed"})))
            } else { Err(DurableRunnerError::subscription_auth(hold)) };
        }
        let outcome = (|| {
        // Cleanup/readback remains possible after admission expiry or authority
        // rotation; another prepare/attach/turn cannot reuse this capability.
        if !matches!(
            command.command_type.as_str(),
            "turn.interrupt"
                | "run.cancel"
                | "turn.stop"
                | "session.snapshot"
                | "session.close"
                | "session.destroy"
                | "runner.suspend"
                | "runner.shutdown"
                | "runner.drain"
        ) {
            self.assert_factory_authority()?;
            if self.factory_authority.is_some()
                && (command.payload.get("paperclipNextAuthority").is_some()
                    || command
                        .payload
                        .pointer("/provider/kind")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| kind != "acpx")
                    || command
                        .payload
                        .pointer("/provider/agent")
                        .and_then(Value::as_str)
                        .is_some_and(|agent| agent != "claude"))
            {
                return Err(DurableRunnerError::invalid(
                    "factory_claude_access_unverified:binding_mismatch",
                ));
            }
        }
        // Preserve the existing Codex admission boundary independently of the
        // Claude executor's actual cleanup-only command vocabulary.
        if !subscription_auth_hold::cleanup_command(&command.command_type) {
            crate::codex_external_auth::assert_selected_run(
                &crate::codex_external_auth::ExternalAuthRunBinding {
                    run_id: &self.config.run_id,
                    environment_lease_id: &self.config.environment_lease_id,
                    normalized_session_id: &self.config.normalized_session_id,
                    runner_instance_id: &self.config.runner_instance_id,
                },
                command
                    .payload
                    .pointer("/provider/kind")
                    .and_then(Value::as_str),
            )
            .map_err(|error| DurableRunnerError::invalid(error.to_string()))?;
        }
        self.select_recovery()?;
        if self.selected.is_none()
            && matches!(command.command_type.as_str(), "run.prepare" | "run.attach")
        {
            self.select_from_payload(&command.payload)?;
        }
        self.selected
            .as_mut()
            .ok_or_else(|| {
                DurableRunnerError::invalid(
                    "run.prepare must select a provider before provider commands execute",
                )
            })?
            .execute(command)
        })();
        match outcome {
            Err(error) => {
                let failure = self.project_subscription_error(error);
                if let Some(hold) = failure.subscription_hold() { self.record_subscription_auth_hold(hold)?; }
                Err(failure)
            }
            ok => ok,
        }
    }

    fn poll_events(&mut self) -> Result<Vec<PolledEvent>, DurableRunnerError> {
        if self.subscription_hold.is_some() { return self.retained_events(); }
        let outcome = (|| {
            self.assert_factory_authority()?;
            self.select_recovery()?;
            self.selected.as_mut().map_or_else(|| Ok(Vec::new()), CommandExecutor::poll_events)
        })();
        match outcome {
            Err(error) => {
                let failure = self.project_subscription_error(error);
                if let Some(hold) = failure.subscription_hold() {
                    self.record_subscription_auth_hold(hold)?;
                    return self.retained_events();
                }
                Err(failure)
            }
            ok => ok,
        }
    }

    fn maintain_backpressured_provider(&mut self) -> Result<(), DurableRunnerError> {
        if let Some(hold) = self.subscription_hold { return self.record_subscription_auth_hold(hold); }
        if let Err(error) = self.assert_factory_authority() {
            let failure = self.project_subscription_error(error);
            if let Some(hold) = failure.subscription_hold() { return self.record_subscription_auth_hold(hold); }
            return Err(failure);
        }
        // A provider that has not yet been selected/restored cannot have
        // in-process cleanup to advance. Never launch one merely for ACK debt.
        self.selected
            .as_mut()
            .map_or_else(|| Ok(()), CommandExecutor::maintain_backpressured_provider)
    }

    fn rotate_authority(&mut self, config: &DurableRunnerConfig) {
        if let Some(selected) = self.protected_subscription() {
            if self.config.run_id != config.run_id || self.config.environment_lease_id != config.environment_lease_id
                || self.config.normalized_session_id != config.normalized_session_id
                || self.config.runner_instance_id != config.runner_instance_id {
                let cause = format!("{}:binding_mismatch", selected.code());
                let hold = SubscriptionAuthHold::from_native_error(Some(selected), &cause).expect("fixed native cause");
                let _ = self.record_subscription_auth_hold(hold);
                return; // Keep the original accepted-turn correlation and owner.
            }
        }
        self.config = config.clone();
        if let Some(executor) = self.selected.as_mut() {
            executor.rotate_authority(config);
        }
    }

    fn acknowledge_events(&mut self, count: usize) -> Result<(), DurableRunnerError> {
        if self.subscription_hold.is_none() { self.select_recovery()?; }
        if let Some(executor) = self.selected.as_mut() {
            executor.acknowledge_events(count)
        } else if count == 0 {
            Ok(())
        } else {
            Err(DurableRunnerError::invalid(
                "cannot acknowledge provider events before provider selection",
            ))
        }
    }

    fn reconcile_terminal_delivery(
        &mut self,
    ) -> Result<TerminalDeliveryReconciliation, DurableRunnerError> {
        if self.subscription_hold.is_some() {
            if let Some(executor) = self.selected.as_mut() { executor.reconcile_terminal_delivery()?; }
            return Ok(TerminalDeliveryReconciliation::ProviderCleanupPending);
        }
        // Selection only loads the provider authority. The selected executor
        // decides whether terminal delivery can settle without a cold launch.
        self.select_recovery()?;
        self.selected.as_mut().map_or_else(
            || Ok(TerminalDeliveryReconciliation::CleanupCompleted),
            CommandExecutor::reconcile_terminal_delivery,
        )
    }

    fn shutdown(&mut self) -> Result<(), DurableRunnerError> {
        if let Some(hold) = self.subscription_hold {
            if let Some(executor) = self.selected.as_mut() { let _ = executor.reconcile_terminal_delivery(); }
            return Err(DurableRunnerError::subscription_auth(hold));
        }
        // Terminal delivery can be reconciled by a replacement runner whose
        // executor has not processed a provider command. Select the durable
        // provider authority before cleanup so an absent in-memory selection
        // can never turn the cleanup fence into a successful no-op.
        self.select_recovery()?;
        if let Some(executor) = self.selected.as_mut() {
            executor.shutdown()
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod factory_cleanup_tests {

    fn subscription_hold_native_fixture() -> (PathBuf, DurableRunnerConfig, NativeProviderCommandExecutor) {
        let directory = std::env::temp_dir().join(format!("subscription-hold-native-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let config = DurableRunnerConfig {
            connect_url:"ws://127.0.0.1/runner".into(), ca_bundle_path:None, state_dir:directory.clone(),
            runner_instance_id:"runner".into(), environment_lease_id:"lease".into(), run_id:"run".into(),
            normalized_session_id:"session".into(), turn_id:"turn".into(), item_id:"item".into(),
            runner_version:"test".into(), runner_digest:"sha256:test".into(), acpx_launch_profile:None, opencode_launch_profile:None,
            max_outbox_bytes:1048576,p0_reserve_bytes:65536,max_frame_bytes:1048576,
            reconnect_delay:Duration::from_millis(1),reconnect_grace:None,max_runtime:Duration::from_secs(60),
        };
        let plan = "a".repeat(64);
        let ingress = crate::claude_external_auth::synthetic_ingress(&crate::claude_external_auth::ActualRun {
            run_id:&config.run_id,environment_lease_id:&config.environment_lease_id,
            normalized_session_id:&config.normalized_session_id,runner_instance_id:&config.runner_instance_id,worker_plan_sha256:&plan,
        });
        let executor = NativeProviderCommandExecutor::with_factory_claude(&directory,&config,ingress,plan).unwrap();
        (directory,config,executor)
    }

    #[test]
    fn subscription_hold_native_expiry_precedes_restore_and_never_adopts_cleanup() {
        let (directory,_,mut executor) = subscription_hold_native_fixture();
        let foreign = directory.join(ACPX_PROVIDER_STATE_FILE);
        std::fs::write(&foreign,b"untrusted preexisting state must remain unread and unchanged").unwrap();
        executor.factory_authority = Some(executor.factory_authority.clone().unwrap().expired_for_test());
        assert!(executor.poll_events().unwrap().is_empty());
        assert!(executor.selected.is_none());
        assert!(!executor.recovery_checked);
        assert_eq!(executor.subscription_hold.unwrap().fields()["reason"],"expired_capability");
        assert_eq!(executor.reconcile_terminal_delivery().unwrap(),TerminalDeliveryReconciliation::ProviderCleanupPending);
        assert!(!executor.can_reconcile_result_delivery().unwrap());
        assert!(executor.shutdown().is_err());
        assert_eq!(std::fs::read(&foreign).unwrap(),b"untrusted preexisting state must remain unread and unchanged");
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(),1);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn subscription_hold_native_rejected_rotation_keeps_exact_original_authority() {
        let (directory,config,mut executor) = subscription_hold_native_fixture();
        let mut successor = config.clone();
        successor.environment_lease_id = "foreign-lease".into();
        successor.run_id = "foreign-run".into();
        executor.rotate_authority(&successor);
        assert_eq!(executor.config.run_id,config.run_id);
        assert_eq!(executor.config.environment_lease_id,config.environment_lease_id);
        assert_eq!(executor.subscription_hold.unwrap().fields()["reason"],"binding_mismatch");
        assert!(executor.selected.is_none());
        assert!(!executor.recovery_checked);
        assert_eq!(executor.reconcile_terminal_delivery().unwrap(),TerminalDeliveryReconciliation::ProviderCleanupPending);
        std::fs::remove_dir_all(directory).unwrap();
    }
    use super::*;
    use std::time::Duration;

    #[test]
    fn expired_claude_authority_allows_only_owned_cleanup_and_blocks_new_work() {
        let directory = std::env::temp_dir().join(format!(
            "factory-expired-cleanup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let config = DurableRunnerConfig {
            connect_url: "ws://127.0.0.1/runner".into(),
            ca_bundle_path: None,
            state_dir: directory.clone(),
            runner_instance_id: "runner".into(),
            environment_lease_id: "lease".into(),
            run_id: "run".into(),
            normalized_session_id: "session".into(),
            turn_id: "turn".into(),
            item_id: "item".into(),
            runner_version: "test".into(),
            runner_digest: "sha256:test".into(),
            acpx_launch_profile: None,
            opencode_launch_profile: None,
            max_outbox_bytes: 1024 * 1024,
            p0_reserve_bytes: 65536,
            max_frame_bytes: 1024 * 1024,
            reconnect_delay: Duration::from_millis(1),
            reconnect_grace: None,
            max_runtime: Duration::from_secs(60),
        };
        let plan = "a".repeat(64);
        let actual = crate::claude_external_auth::ActualRun {
            run_id: &config.run_id,
            environment_lease_id: &config.environment_lease_id,
            normalized_session_id: &config.normalized_session_id,
            runner_instance_id: &config.runner_instance_id,
            worker_plan_sha256: &plan,
        };
        let ingress = crate::claude_external_auth::synthetic_ingress(&actual);
        let expired = ingress.authority().unwrap().expired_for_test();
        let mut executor = NativeProviderCommandExecutor::with_factory_claude(
            &directory,
            &config,
            ingress,
            plan.clone(),
        )
        .unwrap();
        executor.factory_authority = Some(expired);
        executor.recovery_checked = true;
        // An already selected, currently owned cold executor needs no launch to
        // handle shutdown/drain. Expiry cannot prevent that cleanup dispatch.
        executor.selected = Some(SelectedExecutor::Acpx(
            AcpxCommandExecutor::with_factory_claude(
                &directory,
                &config,
                crate::claude_external_auth::synthetic_ingress(&actual),
                plan,
            )
            .unwrap(),
        ));
        for command_type in ["runner.drain", "runner.shutdown"] {
            let command = Command {
                schema: "paperclip.prp.command.v1".into(),
                command_id: command_type.into(),
                controller_seq: 1,
                command_type: command_type.into(),
                issued_at: "2026-10-16T00:00:00Z".into(),
                deadline_at: None,
                precondition: None,
                payload: serde_json::json!({}),
            };
            assert!(executor.execute(&command).is_ok(), "{command_type}");
        }
        for command_type in [
            "run.prepare",
            "run.attach",
            "turn.start",
            "turn.steer",
            "request.resolve",
            "semantic_tool.result",
        ] {
            let command = Command {
                schema: "paperclip.prp.command.v1".into(),
                command_id: command_type.into(),
                controller_seq: 2,
                command_type: command_type.into(),
                issued_at: "2026-10-16T00:00:00Z".into(),
                deadline_at: None,
                precondition: None,
                payload: serde_json::json!({}),
            };
            assert!(
                executor
                    .execute(&command)
                    .err()
                    .unwrap()
                    .to_string()
                    .contains("factory_claude_access_unverified:expired_capability"),
                "{command_type}"
            );
        }
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
        std::fs::remove_dir(directory).unwrap();
    }
}
