use super::*;

#[test]
fn subscription_hold_requires_explicit_native_selection() {
    for code in [ProtectedSubscription::Codex, ProtectedSubscription::Claude] {
        let text = format!("{}:expired_capability", code.code());
        assert!(SubscriptionAuthHold::from_native_error(None, &text).is_none());
        let generic = native_error(None, &text, "ordinary provider");
        assert!(generic.subscription_hold().is_none());
        assert_eq!(
            generic.command_failure_result()["code"],
            "command_execution_failed"
        );
        assert_eq!(
            generic.command_failure_result()["message"],
            format!("ordinary provider: {text}")
        );
    }
}

#[test]
fn subscription_hold_requires_complete_exact_closed_reason() {
    for selected in [ProtectedSubscription::Codex, ProtectedSubscription::Claude] {
        let prefix = selected.code();
        for suffix in [
            "",
            "not_a_reason",
            "expired_capability ",
            "expired_capability\n",
            "expired_capability:synthetic-must-not-reflect",
            "expired_capability synthetic-must-not-reflect",
            "expired_capability\u{0}",
            "EXPIRED_CAPABILITY",
        ] {
            let text = format!("{prefix}:{suffix}");
            assert!(SubscriptionAuthHold::from_native_error(Some(selected), &text).is_none());
            let result =
                native_error(Some(selected), text, "protected test").command_failure_result();
            assert_eq!(result["code"], "command_execution_failed");
            assert_eq!(
                result["message"],
                "Protected provider operation failed; details withheld."
            );
        }
        assert!(SubscriptionAuthHold::from_native_error(
            Some(selected),
            &format!("wrapped {prefix}:expired_capability")
        )
        .is_none());
    }
}

#[test]
fn subscription_hold_provider_families_cannot_cross() {
    assert!(SubscriptionAuthHold::from_native_error(
        Some(ProtectedSubscription::Codex),
        "factory_claude_access_unverified:expired_capability"
    )
    .is_none());
    assert!(SubscriptionAuthHold::from_native_error(
        Some(ProtectedSubscription::Claude),
        "codex_external_auth_operator_required:refresh_required"
    )
    .is_none());
    assert!(SubscriptionAuthHold::from_native_error(
        Some(ProtectedSubscription::Codex),
        "codex_external_auth_operator_required:sidecar_rejected"
    )
    .is_none());
}

#[test]
fn subscription_hold_survives_typed_context_without_parsing_display() {
    let error = native_error(
        Some(ProtectedSubscription::Codex),
        "codex_external_auth_operator_required:refresh_required",
        "provider poll",
    )
    .with_context("wrapper synthetic-must-not-reflect");
    assert_eq!(
        error.to_string(),
        "codex_external_auth_operator_required:refresh_required"
    );
    assert_eq!(
        error.command_failure_result(),
        json!({
            "code":"codex_external_auth_operator_required", "reason":"refresh_required",
            "retryable":false, "operatorRequired":true, "message":HOLD_MESSAGE,
        })
    );
    let lookalike = DurableRunnerError::invalid(error.to_string());
    assert!(lookalike.subscription_hold().is_none());
    assert_eq!(
        lookalike.command_failure_result()["code"],
        "command_execution_failed"
    );
}

#[test]
fn subscription_hold_terminal_is_failure_not_cleanup_or_provider_evidence() {
    let hold = SubscriptionAuthHold::from_native_error(
        Some(ProtectedSubscription::Claude),
        "factory_claude_access_unverified:sidecar_rejected",
    )
    .unwrap();
    let events = hold.terminal_events(&HeldTurn {
        run_id: "run",
        normalized_session_id: "session",
        turn_id: "turn",
        item_id: "item",
        provider_turn_id: Some("accepted-once"),
        provider_session_id: Some("provider-session"),
    });
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        ["turn.failed", "run.terminal"]
    );
    for event in events {
        assert_eq!(event.priority, EventPriority::P0);
        assert_eq!(event.payload["error"], hold.fields());
        assert_eq!(event.payload["providerTurnId"], "accepted-once");
        assert_eq!(event.payload["providerTerminalObserved"], false);
        assert_eq!(event.payload["providerExitConfirmed"], false);
        assert_eq!(event.payload["ownershipUnverified"], true);
    }
}

#[test]
fn subscription_hold_cleanup_vocabulary_never_admits_new_work() {
    for name in [
        "turn.stop",
        "turn.interrupt",
        "run.cancel",
        "runner.drain",
        "runner.shutdown",
        "session.close",
        "session.snapshot",
    ] {
        assert!(cleanup_command(name));
    }
    for name in [
        "run.prepare",
        "run.attach",
        "turn.start",
        "turn.steer",
        "semantic_tool.result",
        "request.resolve",
    ] {
        assert!(!cleanup_command(name));
    }
}


#[test]
fn subscription_hold_terminal_matches_actual_prp_schema() {
    let mut schema: Value = serde_json::from_str(include_str!("../../../../protocol/schemas/terminal.schema.json")).unwrap();
    // Resolve the one external schema locally, without any schema/network IO.
    assert_eq!(schema["properties"]["stopReason"]["$ref"], "https://paperclip.dev/schemas/prp/v1/stop-reason.schema.json");
    schema["properties"]["stopReason"] = serde_json::from_str(include_str!("../../../../protocol/schemas/stop-reason.schema.json")).unwrap();
    let validator = jsonschema::validator_for(&schema).unwrap();
    for selected in [ProtectedSubscription::Codex, ProtectedSubscription::Claude] {
        let hold = SubscriptionAuthHold::from_native_error(Some(selected), &format!("{}:expired_capability", selected.code())).unwrap();
        let events = hold.terminal_events(&HeldTurn { run_id:"run",normalized_session_id:"session",turn_id:"turn",item_id:"item",provider_turn_id:Some("accepted"),provider_session_id:None });
        let mut terminal = events[1].payload.clone();
        assert!(validator.is_valid(&terminal));
        assert_eq!(terminal["reportedWorkDisposition"], "needs_review");
        terminal["reportedWorkDisposition"] = json!("unknown");
        assert!(!validator.is_valid(&terminal));
    }
}
