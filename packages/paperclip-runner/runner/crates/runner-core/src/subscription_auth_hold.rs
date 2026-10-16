//! Native subscription failure metadata; never an authority or retry token.
//! Only a trusted, explicitly selected ingress may classify a complete cause.
use crate::durable::{DurableRunnerError, EventPriority};
use crate::provider_events::NormalizedProviderEvent;
use serde_json::{json, Value};

pub(crate) const HOLD_MESSAGE: &str = "Subscription access requires operator review. Automatic retries and replacement sessions are stopped. Verify worker retirement before explicitly admitting a new run.";
const UNKNOWN_PROTECTED_ERROR: &str = "Protected provider operation failed; details withheld.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProtectedSubscription {
    Codex,
    Claude,
}
impl ProtectedSubscription {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Codex => "codex_external_auth_operator_required",
            Self::Claude => "factory_claude_access_unverified",
        }
    }
    fn provider(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "acpx",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SubscriptionAuthHold {
    provider: ProtectedSubscription,
    reason: &'static str,
}

impl SubscriptionAuthHold {
    /// Selection comes from native ingress, never provider JSON or prose.
    /// Match the entire suffix; reject wrappers, whitespace and appended bytes.
    pub(crate) fn from_native_error(
        selected: Option<ProtectedSubscription>,
        error: &str,
    ) -> Option<Self> {
        let provider = selected?;
        let (code, reason) = error.split_once(':')?;
        if code != provider.code() {
            return None;
        }
        let reason = match (provider, reason) {
            (_, "unsafe_source") => "unsafe_source",
            (_, "source_timeout") => "source_timeout",
            (_, "malformed_capability") => "malformed_capability",
            (_, "binding_mismatch") => "binding_mismatch",
            (_, "expired_capability") => "expired_capability",
            (_, "source_already_consumed") => "source_already_consumed",
            (_, "unsafe_configuration") => "unsafe_configuration",
            (_, "incompatible_provider") => "incompatible_provider",
            (_, "recovery_not_permitted") => "recovery_not_permitted",
            (ProtectedSubscription::Codex, "missing_source") => "missing_source",
            (ProtectedSubscription::Codex, "oversize_capability") => "oversize_capability",
            (ProtectedSubscription::Codex, "foreign_authority") => "foreign_authority",
            (ProtectedSubscription::Codex, "conflicting_authentication") => {
                "conflicting_authentication"
            }
            (ProtectedSubscription::Codex, "refresh_required") => "refresh_required",
            (ProtectedSubscription::Codex, "authentication_rejected") => "authentication_rejected",
            (ProtectedSubscription::Codex, "identity_unverified") => "identity_unverified",
            (ProtectedSubscription::Codex, "provider_reflection") => "provider_reflection",
            (ProtectedSubscription::Codex, "provider_protocol") => "provider_protocol",
            (ProtectedSubscription::Codex, "provider_exited") => "provider_exited",
            (ProtectedSubscription::Claude, "conflicting_provider") => "conflicting_provider",
            (ProtectedSubscription::Claude, "unsafe_startup_slots") => "unsafe_startup_slots",
            (ProtectedSubscription::Claude, "malformed_binding") => "malformed_binding",
            (ProtectedSubscription::Claude, "unverified_bootstrap") => "unverified_bootstrap",
            (ProtectedSubscription::Claude, "unsupported_platform") => "unsupported_platform",
            (ProtectedSubscription::Claude, "artifact_descriptor") => "artifact_descriptor",
            (ProtectedSubscription::Claude, "unsafe_descriptor_layout") => {
                "unsafe_descriptor_layout"
            }
            (ProtectedSubscription::Claude, "sidecar_rejected") => "sidecar_rejected",
            _ => return None,
        };
        Some(Self { provider, reason })
    }
    pub(crate) fn selected(self) -> ProtectedSubscription {
        self.provider
    }
    pub(crate) fn diagnostic(self) -> String {
        format!("{}:{}", self.provider.code(), self.reason)
    }
    pub(crate) fn fields(self) -> Value {
        json!({"code": self.provider.code(), "reason": self.reason,
            "retryable": false, "operatorRequired": true, "message": HOLD_MESSAGE})
    }

    /// Native failure evidence, not a provider terminal or retirement receipt.
    pub(crate) fn terminal_events(self, turn: &HeldTurn<'_>) -> Vec<NormalizedProviderEvent> {
        let common = json!({
            "provider": self.provider.provider(), "runId": turn.run_id,
            "normalizedSessionId": turn.normalized_session_id,
            "turnId": turn.turn_id, "itemId": turn.item_id,
            "providerTurnId": turn.provider_turn_id, "providerSessionId": turn.provider_session_id,
            "providerTerminalObserved": false, "providerExitConfirmed": false,
            "ownershipUnverified": true, "error": self.fields(),
        });
        let mut failed = common.clone();
        failed["status"] = json!("failed");
        let mut terminal = common;
        terminal["schema"] = json!("paperclip.prp.terminal.v1");
        terminal["status"] = json!("failed");
        terminal["turnTerminalState"] = json!("failed");
        terminal["runTerminalState"] = json!("failed");
        terminal["reportedWorkDisposition"] = json!("needs_review");
        vec![
            NormalizedProviderEvent {
                event_type: "turn.failed".into(),
                priority: EventPriority::P0,
                payload: failed,
            },
            NormalizedProviderEvent {
                event_type: "run.terminal".into(),
                priority: EventPriority::P0,
                payload: terminal,
            },
        ]
    }
}

pub(crate) struct HeldTurn<'a> {
    pub run_id: &'a str,
    pub normalized_session_id: &'a str,
    pub turn_id: &'a str,
    pub item_id: &'a str,
    pub provider_turn_id: Option<&'a str>,
    pub provider_session_id: Option<&'a str>,
}

/// Convert at the immediate native boundary, before contextual wrapping.
/// Unknown protected failures stay generic and nonreflecting.
pub(crate) fn native_error(
    selected: Option<ProtectedSubscription>,
    error: impl std::fmt::Display,
    context: &str,
) -> DurableRunnerError {
    let raw = error.to_string();
    if let Some(hold) = SubscriptionAuthHold::from_native_error(selected, &raw) {
        return DurableRunnerError::subscription_auth(hold);
    }
    if selected.is_some() { DurableRunnerError::invalid(UNKNOWN_PROTECTED_ERROR) }
    else { DurableRunnerError::invalid(format!("{context}: {raw}")) }
}

/// Avoid checking an expired credential before existing physical cleanup.
pub(crate) fn cleanup_command(command: &str) -> bool {
    matches!(
        command,
        "turn.interrupt"
            | "run.cancel"
            | "turn.stop"
            | "session.snapshot"
            | "session.close"
            | "session.destroy"
            | "runner.suspend"
            | "runner.shutdown"
            | "runner.drain"
    )
}

#[cfg(test)]
#[path = "subscription_auth_hold_tests.rs"]
mod tests;
