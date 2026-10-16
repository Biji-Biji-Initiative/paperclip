use super::*;

fn fixture(now: u64) -> (ExternalAuthReference, String, Vec<u8>) {
    let reference = ExternalAuthReference {
        schema: "paperclip.codex-external-auth.v1".into(),
        authority_id: "fixture-owner".into(),
        capability_id: "fixture-capability".into(),
        company_id: FACTORY_COMPANY_ID.into(),
        profile_ref: "fixture@example.invalid".into(),
        chatgpt_account_id: "fixture-account".into(),
        chatgpt_plan_type: Some("team".into()),
        run_id: "fixture-run".into(),
        environment_lease_id: "fixture-lease".into(),
        normalized_session_id: "fixture-session".into(),
        runner_instance_id: "fixture-runner".into(),
        admitted_until_unix_ms: now + 60_000,
    };
    let token = format!("{}.{}.synthetic-not-a-provider-signature",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"exp":(now+120_000)/1000,
            "https://api.openai.com/auth":{"chatgpt_account_id":"fixture-account","chatgpt_plan_type":"team"}})).unwrap()));
    let bytes = serde_json::to_vec(&json!({"reference":reference,"accessToken":token,"accessTokenExpiresAtUnixMs":(now+120_000)/1000*1000})).unwrap();
    (reference, token, bytes)
}
fn guard() -> ExternalAuthGuard {
    let (_, _, b) = fixture(unix_ms().unwrap());
    ExternalAuthGuard::from_bytes(&b, unix_ms().unwrap()).unwrap()
}
fn reject_mutation(f: impl FnOnce(&mut Value)) -> ExternalAuthHold {
    let now = unix_ms().unwrap();
    let (_, _, b) = fixture(now);
    let mut value: Value = serde_json::from_slice(&b).unwrap();
    f(&mut value);
    ExternalAuthGuard::from_bytes(&serde_json::to_vec(&value).unwrap(), now)
        .err()
        .expect("must reject")
}
#[test]
fn capability_accepts_named_bound_admission() {
    assert_eq!(guard().reference.profile_ref, "fixture@example.invalid");
}
#[test]
fn foreign_company_rejected() {
    assert_eq!(
        reject_mutation(|v| v["reference"]["companyId"] = json!("another-company")).0,
        HoldReason::ForeignAuthority
    );
}
#[test]
fn unknown_authority_field_rejected() {
    assert_eq!(
        reject_mutation(|v| v["reference"]["brokerUrl"] = json!("https://invalid.example")).0,
        HoldReason::MalformedCapability
    );
}
#[test]
fn refresh_material_rejected() {
    assert_eq!(
        reject_mutation(|v| v["refreshToken"] = json!("synthetic-forbidden")).0,
        HoldReason::MalformedCapability
    );
}
#[test]
fn identity_token_rejected() {
    assert_eq!(
        reject_mutation(|v| v["idToken"] = json!("synthetic-forbidden")).0,
        HoldReason::MalformedCapability
    );
}
#[test]
fn authority_paths_rejected() {
    assert_eq!(
        reject_mutation(|v| v["reference"]["authorityId"] = json!("/home/operator/.codex")).0,
        HoldReason::ForeignAuthority
    );
}
#[test]
fn expired_admission_rejected() {
    assert_eq!(
        reject_mutation(|v| v["reference"]["admittedUntilUnixMs"] = json!(1)).0,
        HoldReason::ExpiredCapability
    );
}
#[test]
fn overlong_admission_rejected() {
    assert_eq!(
        reject_mutation(|v| v["reference"]["admittedUntilUnixMs"] =
            json!(unix_ms().unwrap() + MAX_ADMISSION_MS + 10))
        .0,
        HoldReason::ExpiredCapability
    );
}
#[test]
fn access_expiry_must_cover_admission() {
    assert_eq!(
        reject_mutation(|v| v["accessTokenExpiresAtUnixMs"] = json!(1)).0,
        HoldReason::ExpiredCapability
    );
}
#[test]
fn token_account_must_match_reference() {
    assert_eq!(
        reject_mutation(|v| v["reference"]["chatgptAccountId"] = json!("other")).0,
        HoldReason::BindingMismatch
    );
}
#[test]
fn token_plan_must_match_reference() {
    assert_eq!(
        reject_mutation(|v| v["reference"]["chatgptPlanType"] = json!("business")).0,
        HoldReason::BindingMismatch
    );
}
#[test]
fn malformed_json_is_nonreflecting() {
    let error = ExternalAuthGuard::from_bytes(b"{sensitive-untrusted-input", 1)
        .err()
        .unwrap();
    assert!(!error.to_string().contains("sensitive-untrusted-input"));
}
#[test]
fn oversize_is_bounded() {
    assert_eq!(
        ExternalAuthGuard::from_bytes(&vec![b'x'; MAX_CAPABILITY_BYTES + 1], 1)
            .err()
            .unwrap()
            .0,
        HoldReason::OversizeCapability
    );
}
#[test]
fn duplicate_json_fields_rejected() {
    let (r, t, _) = fixture(unix_ms().unwrap());
    let data=format!("{{\"reference\":{},\"accessToken\":\"{}\",\"accessToken\":\"{}\",\"accessTokenExpiresAtUnixMs\":1}}",serde_json::to_string(&r).unwrap(),t,t);
    assert_eq!(
        ExternalAuthGuard::from_bytes(data.as_bytes(), unix_ms().unwrap())
            .err()
            .unwrap()
            .0,
        HoldReason::MalformedCapability
    );
}
#[test]
fn run_lease_session_and_owner_must_match() {
    let g = guard();
    let r = &g.reference;
    let binding = ExternalAuthRunBinding {
        run_id: &r.run_id,
        environment_lease_id: &r.environment_lease_id,
        normalized_session_id: &r.normalized_session_id,
        runner_instance_id: &r.runner_instance_id,
    };
    assert!(r.assert_run(&binding).is_ok());
    for b in [
        ExternalAuthRunBinding {
            run_id: "foreign",
            ..binding.clone()
        },
        ExternalAuthRunBinding {
            environment_lease_id: "foreign",
            ..binding.clone()
        },
        ExternalAuthRunBinding {
            normalized_session_id: "foreign",
            ..binding.clone()
        },
        ExternalAuthRunBinding {
            runner_instance_id: "foreign",
            ..binding.clone()
        },
    ] {
        assert_eq!(r.assert_run(&b).unwrap_err().0, HoldReason::BindingMismatch);
    }
}
#[test]
fn login_wire_matches_codex_0160_contract() {
    let g = guard();
    let wire = serde_json::to_value(g.login_request(7)).unwrap();
    assert_eq!(wire["method"], "account/login/start");
    assert_eq!(wire["params"]["type"], "chatgptAuthTokens");
    assert_eq!(wire["params"]["chatgptAccountId"], "fixture-account");
    assert!(wire["params"].get("refreshToken").is_none());
    assert!(wire["params"].get("idToken").is_none());
}
#[test]
fn reference_serialization_never_contains_material() {
    let g = guard();
    let text = serde_json::to_string(g.reference()).unwrap();
    let debug = format!("{:?}", g.reference());
    assert!(!text.contains(g.access.0.as_str()));
    assert!(!debug.contains(g.access.0.as_str()));
}
#[test]
fn reflected_raw_base64url_base64_hex_never_survive_boundary() {
    let g = guard();
    for needle in &g.reflections {
        let line=json!({"id":3,"error":{"code":-1,"message":format!("prefix {} suffix",needle.as_str())}}).to_string();
        assert_eq!(
            g.inspect_inbound(&line).err().unwrap().0,
            HoldReason::ProviderReflection
        );
    }
}
#[test]
fn reflected_credential_in_identifier_is_rejected() {
    let g = guard();
    let line =
        json!({"method":"account/chatgptAuthTokens/refresh","id":g.access.0.as_str(),"params":{}})
            .to_string();
    assert_eq!(
        g.inspect_inbound(&line).err().unwrap().0,
        HoldReason::ProviderReflection
    );
}
#[test]
fn independently_encoded_reflections_are_rejected() {
    let g = guard();
    let token = g.access.0.as_str();
    let encodings = [
        STANDARD_NO_PAD.encode(token),
        URL_SAFE.encode(token),
        token.bytes().map(|byte| format!("{byte:02X}")).collect(),
    ];
    for encoded in encodings {
        let line = json!({"method":"item/agentMessage/delta","params":{"delta":encoded}}).to_string();
        assert_eq!(g.inspect_inbound(&line).err().unwrap().0, HoldReason::ProviderReflection);
    }
}
#[test]
fn explicit_account_update_identity_cannot_change() {
    let g = guard();
    for (key, expected) in [("chatgptAccountId", "fixture-account"), ("accountId", "fixture-account"),
        ("chatgptPlanType", "team"), ("planType", "team")] {
        for foreign in [Value::String("foreign".into()), Value::Null] {
            let mut params = json!({"authMode":"chatgptAuthTokens"});
            params[key] = foreign;
            let line = json!({"method":"account/updated","params":params}).to_string();
            assert_eq!(g.inspect_inbound(&line).err().unwrap().0, HoldReason::IdentityUnverified);
        }
        let mut params = json!({"authMode":"chatgptAuthTokens"});
        params[key] = Value::String(expected.into());
        assert!(matches!(g.inspect_inbound(&json!({"method":"account/updated","params":params}).to_string()).unwrap(), Inbound::Discard));
    }
}
#[test]
fn raw_error_details_are_not_reflected() {
    let g = guard();
    let Inbound::Message(line)=g.inspect_inbound(&json!({"id":1,"error":{"code":42,"message":"private provider detail","data":{"secret":"not printed"}}}).to_string()).unwrap() else{panic!("expected sanitized message")};
    assert!(!line.contains("private provider detail"));
    assert!(!line.contains("not printed"));
}
#[test]
fn refresh_callback_is_intercepted_even_after_lease_expiry() {
    let mut g = guard();
    g.deadline = Instant::now();
    assert!(matches!(g.inspect_inbound(r#"{"id":9,"method":"account/chatgptAuthTokens/refresh","params":{"reason":"unauthorized"}}"#).unwrap(),Inbound::RefreshDenied(_)));
    assert_eq!(g.check_live().unwrap_err().0, HoldReason::ExpiredCapability);
}
#[test]
fn hold_is_latched_and_never_recovers_implicitly() {
    let mut g = guard();
    g.latch(HoldReason::RefreshRequired);
    g.latch(HoldReason::ExpiredCapability);
    assert_eq!(g.check_live().unwrap_err().0, HoldReason::RefreshRequired);
}
#[test]
fn unsupported_auth_mode_rejected() {
    assert_eq!(
        guard()
            .inspect_inbound(r#"{"method":"account/updated","params":{"authMode":"apikey"}}"#)
            .err()
            .unwrap()
            .0,
        HoldReason::IdentityUnverified
    );
}
#[test]
fn nullable_account_is_not_authentication_proof() {
    assert_eq!(
        guard()
            .verify_account(&json!({"account":null}))
            .unwrap_err()
            .0,
        HoldReason::IdentityUnverified
    );
}
#[test]
fn plan_readback_checked() {
    assert_eq!(
        guard()
            .verify_account(&json!({"account":{"type":"chatgpt","planType":"pro"}}))
            .unwrap_err()
            .0,
        HoldReason::IdentityUnverified
    );
}
#[test]
fn explicit_http401_is_typed_hold() {
    assert_eq!(
        guard()
            .inspect_inbound(r#"{"id":1,"error":{"code":401,"message":"unauthorized"}}"#)
            .err()
            .unwrap()
            .0,
        HoldReason::AuthenticationRejected
    );
}

#[test]
fn personal_or_missing_plan_cannot_select_company_subscription() {
    for plan in [json!("pro"), json!("plus"), Value::Null] {
        assert_eq!(
            reject_mutation(|v| v["reference"]["chatgptPlanType"] = plan).0,
            HoldReason::ForeignAuthority
        );
    }
}
#[test]
fn access_expiry_includes_owner_delivery_safety_margin() {
    assert_eq!(
        reject_mutation(|v| {
            v["accessTokenExpiresAtUnixMs"] = v["reference"]["admittedUntilUnixMs"].clone();
        })
        .0,
        HoldReason::ExpiredCapability
    );
}
