//! Sensitive protocol branch kept separate from generic provider behavior.
use super::*;
use crate::codex_external_auth::{ExternalAuthHold, HoldReason, Inbound};

impl CodexProvider {
    pub(crate) fn validate_external_cold_selection(
        config: &CodexProviderConfig,
        resume_thread_id: Option<&str>,
    ) -> Result<(), LocalRunnerError> {
        if config.external_auth.is_none() && !crate::codex_external_auth::selected() {
            return Ok(());
        }
        let reason = if config.provider != "codex" || config.driver != "codex_app_server" {
            Some(HoldReason::IncompatibleProvider)
        } else if config.provider_session_id.is_some() || resume_thread_id.is_some() {
            Some(HoldReason::RecoveryNotPermitted)
        } else if config.externally_sandboxed
            || std::env::var("PAPERCLIP_RUNNER_EXTERNAL_SANDBOX").as_deref() == Ok("1")
        {
            Some(HoldReason::UnsafeConfiguration)
        } else {
            None
        };
        match reason {
            Some(reason) => Err(LocalRunnerError::invalid(ExternalAuthHold(reason).to_string())),
            None => Ok(()),
        }
    }

    pub(super) fn enter_external_auth_hold(&mut self, reason: HoldReason) -> LocalRunnerError {
        let failure = self
            .external_auth
            .as_mut()
            .map(|auth| auth.latch(reason))
            .unwrap_or(ExternalAuthHold(reason));
        self.expected_shutdown = true;
        self.quarantined = true;
        // Keep the existing owned-child retirement. Its result is still observed
        // by the caller; this does not claim escaped tool descendants retired.
        let _ = self.process.terminate_group();
        LocalRunnerError::invalid(failure.to_string())
    }

    pub(crate) fn check_external_auth_live(&mut self) -> Result<(), LocalRunnerError> {
        if let Some(Err(ExternalAuthHold(reason))) =
            self.external_auth.as_ref().map(|auth| auth.check_live())
        {
            return Err(self.enter_external_auth_hold(reason));
        }
        Ok(())
    }

    pub(super) fn initialize_external_auth(&mut self) -> Result<(), LocalRunnerError> {
        if self.external_auth.is_none() {
            return Ok(());
        }
        self.check_external_auth_live()?;
        // Both added auth RPCs share 20 seconds, leaving room in the native
        // controller's existing 120-second combined session-open budget.
        self.external_auth_start_deadline = Some(
            std::time::Instant::now()
                + self
                    .external_auth
                    .as_ref()
                    .expect("external auth selected")
                    .remaining()
                    .min(Duration::from_secs(20)),
        );
        let id = self.next_request_id;
        self.next_request_id = id
            .checked_add(1)
            .ok_or_else(|| LocalRunnerError::invalid("Codex request id exhausted"))?;
        // No Value/String copy and no send_frame(): its ordinary trace records
        // rawBase64 and a digest. The wire-only borrowed request is serialized
        // exclusively into the bounded sensitive stdin writer.
        let sent = {
            let auth = self.external_auth.as_ref().expect("external auth selected");
            self.process.send_ephemeral_json(
                &auth.login_request(id),
                auth.remaining().min(Duration::from_secs(2)),
            )
        };
        if sent.is_err() {
            return Err(self.enter_external_auth_hold(HoldReason::ProviderProtocol));
        }
        if let Some(trace) = self.trace.as_mut() {
            trace.send_record(json!({"kind":"external_auth_metadata", "event":"login_request_sent", "rawCapture":false}));
        }
        let login = match self.receive_classified_response(id, "account/login/start") {
            Ok(value) => value,
            Err(error) => {
                let error = error.into_inner();
                if error
                    .to_string()
                    .starts_with(crate::codex_external_auth::AUTH_HOLD_CODE)
                {
                    return Err(error);
                }
                return Err(self.enter_external_auth_hold(HoldReason::AuthenticationRejected));
            }
        };
        if login.get("type").and_then(Value::as_str) != Some("chatgptAuthTokens") {
            return Err(self.enter_external_auth_hold(HoldReason::IdentityUnverified));
        }
        // A login acknowledgement alone is not a named-account/plan proof.
        // The supplied offline 0.160 probe is expected to hold here.
        let account = match self.request("account/read", json!({"refreshToken":false})) {
            Ok(value) => value,
            Err(error) => {
                if error
                    .to_string()
                    .starts_with(crate::codex_external_auth::AUTH_HOLD_CODE)
                {
                    return Err(error);
                }
                return Err(self.enter_external_auth_hold(HoldReason::IdentityUnverified));
            }
        };
        if let Err(ExternalAuthHold(reason)) = self
            .external_auth
            .as_ref()
            .expect("external auth selected")
            .verify_account(&account)
        {
            return Err(self.enter_external_auth_hold(reason));
        }
        self.check_external_auth_live()?;
        self.external_auth_start_deadline = None;
        Ok(())
    }

    pub(super) fn external_inbound_before_trace(
        &mut self,
        line: String,
    ) -> Result<Option<String>, LocalRunnerError> {
        let Some(auth) = self.external_auth.as_ref() else {
            return Ok(Some(line));
        };
        match auth.inspect_inbound(&line) {
            Ok(Inbound::Message(safe)) => Ok(Some(safe)),
            Ok(Inbound::Discard) => Ok(None),
            Ok(Inbound::RefreshDenied(id)) => {
                let reason = auth
                    .check_live()
                    .err()
                    .map(|e| e.0)
                    .unwrap_or(HoldReason::RefreshRequired);
                // Respond on the actual request ID while a synchronous request
                // is pending OR while asynchronous turn events are polled.
                // No token, provider callback params or arbitrary error text is
                // reflected. This slice never asks CAAM to refresh anything.
                let response = json!({"id":id,"error":{"code":-32001,
                    "message":"external_auth_operator_required: nonrefreshing lease cannot renew"}});
                let _ = self
                    .process
                    .send_ephemeral_json(&response, Duration::from_secs(2));
                Err(self.enter_external_auth_hold(reason))
            }
            Err(ExternalAuthHold(reason)) => Err(self.enter_external_auth_hold(reason)),
        }
    }
}
