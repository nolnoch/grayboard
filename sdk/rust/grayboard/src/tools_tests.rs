//! Typed tools against the vendored schema snapshot and the recorded responses (#929; `docs/sdk-rust.md` §3).
//!
//! `bun scripts/snapshot_native_tools.ts` writes `sdk/rust/schema/{native,subscriber}-tools.json` and `bun scripts/record_rust_responses.ts` writes `sdk/rust/schema/responses/`; root tests fail when either is stale, and these fail when the crate no longer agrees with them.

use crate::envelope::CallToolResult;
use crate::error::Error;
use crate::tests::{Fake, Reply as HttpReply, session};
use crate::tools::*;
use schemars::JsonSchema;
use schemars::generate::{Contract, SchemaSettings};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};

const NATIVE: &str = include_str!("../../schema/native-tools.json");
const SUBSCRIBER: &str = include_str!("../../schema/subscriber-tools.json");
const RESPONSES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../schema/responses");

/// Subscriber tools the crate never sends, so they have no struct: `session_register` registers a harness's child session, which a service has no use for.
const NOT_SENT: &[&str] = &["session_register"];

/// One argument struct: its tool, its schema as schemars derives it, and samples (every field set, then only the required ones).
struct Entry {
    tool: &'static str,
    schema: Value,
    samples: Vec<Value>,
}

fn entry<A: Args + JsonSchema>(full: A, minimal: A) -> Entry {
    let mut generator = SchemaSettings::draft2020_12()
        .with(|s| {
            s.inline_subschemas = true;
            s.contract = Contract::Serialize;
        })
        .into_generator();
    Entry {
        tool: A::TOOL,
        schema: generator.root_schema_for::<A>().to_value(),
        samples: vec![to_arguments(&full), to_arguments(&minimal)],
    }
}

fn map(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect()
}

/// Every native tool's struct, with a sample that sets every field.
fn native_entries() -> Vec<Entry> {
    vec![
        entry(
            BindArgs {
                name: "w-1".into(),
                create: Some(true),
                meta: Some(map(&[("task", json!("ENG-142"))])),
                where_: Some("host-1".into()),
            },
            BindArgs::new("w-1"),
        ),
        entry(UnbindArgs::new("w-1"), UnbindArgs::new("w-1")),
        entry(WhoamiArgs {}, WhoamiArgs {}),
        entry(
            BoardArchiveArgs {
                board: "e2e".into(),
                archived: Some(false),
            },
            BoardArchiveArgs::new("e2e"),
        ),
        entry(
            BoardCreateArgs {
                kind: Some(BoardKind::Queue),
                team: Some("eng".into()),
                ..BoardCreateArgs::new("work", "a queue")
            },
            BoardCreateArgs::new("work", "a queue"),
        ),
        entry(BoardListArgs {}, BoardListArgs {}),
        entry(
            BoardPostArgs {
                parent_id: Some(7),
                attachment_ids: Some(vec![1, 2]),
                resend: Some(true),
                as_: Some("be".into()),
                ..BoardPostArgs::new("e2e", "hi")
            },
            BoardPostArgs::new("e2e", "hi"),
        ),
        entry(
            BoardReadArgs {
                limit: Some(20),
                before_id: Some(9),
                thread: Some(3),
                ..BoardReadArgs::new("e2e")
            },
            BoardReadArgs::new("e2e"),
        ),
        entry(
            BoardSubscribeArgs {
                thread: Some(3),
                ..BoardSubscribeArgs::new("e2e", SubscribeMode::Digest)
            },
            BoardSubscribeArgs::new("e2e", SubscribeMode::Push),
        ),
        entry(
            ClaimListArgs {
                prefix: Some("ticket:".into()),
            },
            ClaimListArgs::default(),
        ),
        entry(
            ClaimReleaseArgs {
                note: Some("done".into()),
                ..ClaimReleaseArgs::new("ticket:ENG-142")
            },
            ClaimReleaseArgs::new("ticket:ENG-142"),
        ),
        entry(
            ClaimTakeArgs {
                ttl_minutes: Some(30),
                until: Some("2026-11-16T12:00:00Z".into()),
                note: Some("on it".into()),
                board: Some("e2e".into()),
                as_: Some("be".into()),
                ..ClaimTakeArgs::new("ticket:ENG-142")
            },
            ClaimTakeArgs::new("ticket:ENG-142"),
        ),
        entry(
            ClaimWatchArgs {
                off: Some(true),
                ..ClaimWatchArgs::new("ticket:ENG-142")
            },
            ClaimWatchArgs::new("ticket:ENG-142"),
        ),
        entry(
            DelegateArgs {
                to: Some("you@example.com/launcher".into()),
                context: Some("the spec".into()),
                resend: Some(true),
                ..DelegateArgs::new("reviewer", "review it")
            },
            DelegateArgs::new("reviewer", "review it"),
        ),
        entry(DmAckArgs::new(vec![1, 2]), DmAckArgs::new(1)),
        entry(
            DmHistoryArgs {
                peer: Some("be".into()),
                limit: Some(50),
                before_id: Some(9),
            },
            DmHistoryArgs::default(),
        ),
        entry(DmInboxArgs { days: Some(1.5) }, DmInboxArgs::default()),
        entry(DmRetractArgs::new(4), DmRetractArgs::new(4)),
        entry(
            DmSendArgs {
                parent_id: Some(3),
                pending: Some(true),
                attachment_ids: Some(vec![5]),
                resend: Some(true),
                as_: Some("be".into()),
                ..DmSendArgs::new("fe", "hello")
            },
            DmSendArgs::new("fe", "hello"),
        ),
        entry(DmThreadArgs::new(3), DmThreadArgs::new(3)),
        entry(
            PeerListArgs {
                board: Some("e2e".into()),
                include_offline: Some(true),
                match_: Some(map(&[("harness", json!("pi"))])),
            },
            PeerListArgs::default(),
        ),
        entry(
            PeerStatusArgs {
                queue: Some(QueueRotation::Off),
                ..PeerStatusArgs::new("reviewing")
            },
            PeerStatusArgs::new(""),
        ),
    ]
}

/// Every subscriber tool the crate sends (the delivery stream and `Session::end`), plus the shared bind tools.
fn subscriber_entries() -> Vec<Entry> {
    let shared = ["bind", "unbind", "whoami"];
    let mut entries: Vec<Entry> = native_entries()
        .into_iter()
        .filter(|e| shared.contains(&e.tool))
        .collect();
    entries.extend([
        entry(
            DeliveryOpenArgs {
                context: Some(true),
            },
            DeliveryOpenArgs::default(),
        ),
        entry(
            DeliveryReceiptArgs {
                ids: vec!["item-1".into()],
            },
            DeliveryReceiptArgs { ids: vec![] },
        ),
        entry(DeliveryReleaseArgs {}, DeliveryReleaseArgs {}),
        entry(DeliveryRenewArgs {}, DeliveryRenewArgs {}),
        entry(
            SessionEndArgs {
                session: Some("id:0123456789abc".into()),
            },
            SessionEndArgs::default(),
        ),
    ]);
    entries
}

fn snapshot(text: &str) -> BTreeMap<String, Value> {
    let tools: Vec<Value> = serde_json::from_str(text).unwrap();
    tools
        .into_iter()
        .map(|t| {
            (
                t["name"].as_str().unwrap().to_owned(),
                t["inputSchema"].clone(),
            )
        })
        .collect()
}

/// A property's comparable shape: its primitive types (`null` dropped: an `Option` is optional, not nullable), its enum values and its items' shape.
#[derive(Debug, PartialEq)]
struct Shape {
    types: BTreeSet<String>,
    enums: Option<BTreeSet<String>>,
    items: Option<Box<Shape>>,
}

fn shape(schema: &Value) -> Shape {
    let mut types = BTreeSet::new();
    let mut enums: Option<BTreeSet<String>> = None;
    let mut items: Option<Box<Shape>> = None;
    match &schema["type"] {
        Value::String(t) => {
            types.insert(t.clone());
        }
        Value::Array(list) => {
            types.extend(list.iter().filter_map(|t| t.as_str().map(str::to_owned)))
        }
        _ => {}
    }
    if let Some(values) = schema["enum"].as_array() {
        enums = Some(
            values
                .iter()
                .filter(|v| !v.is_null())
                .map(Value::to_string)
                .collect(),
        );
    }
    if !schema["items"].is_null() {
        items = Some(Box::new(shape(&schema["items"])));
    }
    for branch in schema["anyOf"].as_array().into_iter().flatten() {
        let b = shape(branch);
        types.extend(b.types);
        if b.items.is_some() {
            items = b.items;
        }
    }
    types.remove("null");
    Shape {
        types,
        enums,
        items,
    }
}

/// `integer` in the struct where the snapshot says only `number` is a deliberate narrowing (IDs, minutes, limits): it serializes as a number the schema accepts.
fn narrow(rust: &mut Shape, snap: &Shape) {
    if snap.types.contains("number")
        && !snap.types.contains("integer")
        && rust.types.remove("integer")
    {
        rust.types.insert("number".into());
    }
    if let (Some(r), Some(s)) = (rust.items.as_mut(), snap.items.as_ref()) {
        narrow(r, s);
    }
}

fn properties(schema: &Value) -> BTreeMap<String, Value> {
    schema["properties"]
        .as_object()
        .map(|p| p.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
        .unwrap_or_default()
}

fn required(schema: &Value) -> BTreeSet<String> {
    schema["required"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str().map(str::to_owned))
        .collect()
}

/// Every difference between the structs and one snapshot, as lines naming the tool.
fn mismatches(
    which: &str,
    snap: &BTreeMap<String, Value>,
    entries: &[Entry],
    not_sent: &[&str],
) -> Vec<String> {
    let mut out = Vec::new();
    let by_tool: BTreeMap<&str, &Entry> = entries.iter().map(|e| (e.tool, e)).collect();
    for (tool, schema) in snap {
        if not_sent.contains(&tool.as_str()) {
            continue;
        }
        let Some(entry) = by_tool.get(tool.as_str()) else {
            out.push(format!("{which} tool `{tool}` has no argument struct"));
            continue;
        };
        let (snap_props, rust_props) = (properties(schema), properties(&entry.schema));
        let snap_names: BTreeSet<&String> = snap_props.keys().collect();
        let rust_names: BTreeSet<&String> = rust_props.keys().collect();
        if snap_names != rust_names {
            out.push(format!("{which} `{tool}`: properties differ: snapshot {snap_names:?}, struct {rust_names:?}"));
        }
        if required(schema) != required(&entry.schema) {
            out.push(format!(
                "{which} `{tool}`: required differs: snapshot {:?}, struct {:?}",
                required(schema),
                required(&entry.schema)
            ));
        }
        for (name, prop) in &snap_props {
            let Some(rust) = rust_props.get(name) else {
                continue;
            };
            let snap_shape = shape(prop);
            let mut rust_shape = shape(rust);
            narrow(&mut rust_shape, &snap_shape);
            if rust_shape != snap_shape {
                out.push(format!(
                    "{which} `{tool}`.{name}: snapshot {snap_shape:?}, struct {rust_shape:?}"
                ));
            }
        }
    }
    for tool in by_tool.keys() {
        if !snap.contains_key(*tool) {
            out.push(format!(
                "{which} struct for `{tool}`, a tool the snapshot doesn't list"
            ));
        }
    }
    for tool in not_sent {
        if !snap.contains_key(*tool) {
            out.push(format!(
                "{which} NOT_SENT names `{tool}`, which the snapshot doesn't list"
            ));
        }
    }
    out
}

// D5 point 2, first test: per tool, property names, required set, primitive types and enums of the struct's schema equal the snapshot's, and every snapshot tool has a struct.
#[test]
fn argument_structs_match_the_schema_snapshot() {
    let mut out = mismatches("native", &snapshot(NATIVE), &native_entries(), &[]);
    out.extend(mismatches(
        "subscriber",
        &snapshot(SUBSCRIBER),
        &subscriber_entries(),
        NOT_SENT,
    ));
    assert!(
        out.is_empty(),
        "argument structs disagree with sdk/rust/schema (regenerated by `bun scripts/snapshot_native_tools.ts`); change the struct in src/tools.rs to match:\n  {}",
        out.join("\n  ")
    );
}

/// Validates `value` against the subset of JSON Schema the snapshot uses. A keyword outside it is an error, so a snapshot that starts using one fails here until this validator learns it.
fn validate(value: &Value, schema: &Value, path: &str, errors: &mut Vec<String>) {
    let Some(schema) = schema.as_object() else {
        return; // `{}` or `true`: anything
    };
    for (keyword, rule) in schema {
        match keyword.as_str() {
            "$schema" | "description" | "title" | "format" => {}
            // Unchecked: a regex engine isn't a dependency, and a rename (what this test is for) is caught by `additionalProperties`.
            "pattern" => {}
            "type" => {
                let ok = |t: &str| match t {
                    "string" => value.is_string(),
                    "boolean" => value.is_boolean(),
                    "integer" => value.as_f64().is_some_and(|n| n.fract() == 0.0),
                    "number" => value.is_number(),
                    "array" => value.is_array(),
                    "object" => value.is_object(),
                    "null" => value.is_null(),
                    _ => false,
                };
                let fits = match rule {
                    Value::String(t) => ok(t),
                    Value::Array(ts) => ts.iter().filter_map(Value::as_str).any(ok),
                    _ => false,
                };
                if !fits {
                    errors.push(format!("{path}: {value} is not {rule}"));
                }
            }
            "enum" => {
                if !rule.as_array().is_some_and(|vs| vs.contains(value)) {
                    errors.push(format!("{path}: {value} is not one of {rule}"));
                }
            }
            "properties" | "required" | "additionalProperties" | "propertyNames" => {
                let Some(obj) = value.as_object() else {
                    continue;
                };
                match keyword.as_str() {
                    "properties" => {
                        for (name, sub) in rule.as_object().into_iter().flatten() {
                            if let Some(v) = obj.get(name) {
                                validate(v, sub, &format!("{path}.{name}"), errors);
                            }
                        }
                    }
                    "required" => {
                        for name in rule
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                        {
                            if !obj.contains_key(name) {
                                errors.push(format!("{path}: missing required `{name}`"));
                            }
                        }
                    }
                    "additionalProperties" => {
                        let declared = schema.get("properties").and_then(Value::as_object);
                        for (name, v) in obj {
                            if declared.is_some_and(|d| d.contains_key(name)) {
                                continue;
                            }
                            if rule == &Value::Bool(false) {
                                errors.push(format!(
                                    "{path}: `{name}` is not a property the schema declares"
                                ));
                            } else {
                                validate(v, rule, &format!("{path}.{name}"), errors);
                            }
                        }
                    }
                    _ => {
                        for name in obj.keys() {
                            validate(&json!(name), rule, &format!("{path} key {name}"), errors);
                        }
                    }
                }
            }
            "items" => {
                for (i, v) in value.as_array().into_iter().flatten().enumerate() {
                    validate(v, rule, &format!("{path}[{i}]"), errors);
                }
            }
            "minItems" | "maxItems" => {
                if let (Some(a), Some(n)) = (value.as_array(), rule.as_u64()) {
                    let len = a.len() as u64;
                    if (keyword == "minItems" && len < n) || (keyword == "maxItems" && len > n) {
                        errors.push(format!("{path}: {len} items breaks {keyword} {n}"));
                    }
                }
            }
            "minLength" | "maxLength" => {
                if let (Some(s), Some(n)) = (value.as_str(), rule.as_u64()) {
                    let len = s.chars().count() as u64;
                    if (keyword == "minLength" && len < n) || (keyword == "maxLength" && len > n) {
                        errors.push(format!("{path}: length {len} breaks {keyword} {n}"));
                    }
                }
            }
            "minimum" | "maximum" | "exclusiveMinimum" | "exclusiveMaximum" => {
                if let (Some(v), Some(n)) = (value.as_f64(), rule.as_f64()) {
                    let ok = match keyword.as_str() {
                        "minimum" => v >= n,
                        "maximum" => v <= n,
                        "exclusiveMinimum" => v > n,
                        _ => v < n,
                    };
                    if !ok {
                        errors.push(format!("{path}: {v} breaks {keyword} {n}"));
                    }
                }
            }
            "anyOf" => {
                let fits = rule.as_array().into_iter().flatten().any(|branch| {
                    let mut e = Vec::new();
                    validate(value, branch, path, &mut e);
                    e.is_empty()
                });
                if !fits {
                    errors.push(format!("{path}: {value} fits no anyOf branch"));
                }
            }
            other => errors.push(format!(
                "{path}: the schema uses `{other}`, which this validator doesn't check"
            )),
        }
    }
}

// D5 point 2, second test: each struct's samples, serialized as the crate sends them, validate against the snapshot's inputSchema (`additionalProperties: false` catches a renamed field).
#[test]
fn serialized_samples_validate_against_the_snapshot() {
    let mut errors = Vec::new();
    for (which, snap, entries) in [
        ("native", snapshot(NATIVE), native_entries()),
        ("subscriber", snapshot(SUBSCRIBER), subscriber_entries()),
    ] {
        for e in &entries {
            let Some(schema) = snap.get(e.tool) else {
                continue;
            }; // reported by the schema test
            for sample in &e.samples {
                validate(sample, schema, &format!("{which} {}", e.tool), &mut errors);
            }
        }
    }
    // A minimal sample leaves out every optional field.
    assert_eq!(to_arguments(&BindArgs::new("w-1")), json!({"name": "w-1"}));
    assert!(
        errors.is_empty(),
        "serialized arguments break the snapshot:\n  {}",
        errors.join("\n  ")
    );
}

#[test]
fn the_validator_refuses_a_renamed_field_and_an_unknown_keyword() {
    let schema = snapshot(NATIVE)["board_post"].clone();
    let mut errors = Vec::new();
    validate(
        &json!({"board": "e2e", "body": "hi", "parent": 7}),
        &schema,
        "board_post",
        &mut errors,
    );
    assert_eq!(
        errors,
        ["board_post: `parent` is not a property the schema declares"]
    );
    errors.clear();
    validate(&json!("x"), &json!({"const": "x"}), "v", &mut errors);
    assert_eq!(
        errors,
        ["v: the schema uses `const`, which this validator doesn't check"]
    );
}

/// Reads a recorded result through the reader its typed method uses.
fn read_recorded(tool: &str, result: &CallToolResult) -> Result<String, Error> {
    fn read<A: Typed>(result: &CallToolResult) -> Result<String, Error>
    where
        A::Output: std::fmt::Debug,
    {
        A::read(result).map(|r| format!("{:?}", r.value))
    }
    match tool {
        "bind" => read::<BindArgs>(result),
        "unbind" => read::<UnbindArgs>(result),
        "whoami" => read::<WhoamiArgs>(result),
        "board_archive" => read::<BoardArchiveArgs>(result),
        "board_create" => read::<BoardCreateArgs>(result),
        "board_list" => read::<BoardListArgs>(result),
        "board_post" => read::<BoardPostArgs>(result),
        "board_read" => read::<BoardReadArgs>(result),
        "board_subscribe" => read::<BoardSubscribeArgs>(result),
        "claim_list" => read::<ClaimListArgs>(result),
        "claim_release" => read::<ClaimReleaseArgs>(result),
        "claim_take" => read::<ClaimTakeArgs>(result),
        "claim_watch" => read::<ClaimWatchArgs>(result),
        "delegate" => read::<DelegateArgs>(result),
        "dm_ack" => read::<DmAckArgs>(result),
        "dm_history" => read::<DmHistoryArgs>(result),
        "dm_inbox" => read::<DmInboxArgs>(result),
        "dm_retract" => read::<DmRetractArgs>(result),
        "dm_send" => read::<DmSendArgs>(result),
        "dm_thread" => read::<DmThreadArgs>(result),
        "peer_list" => read::<PeerListArgs>(result),
        "peer_status" => read::<PeerStatusArgs>(result),
        other => panic!("no typed reader for `{other}`"),
    }
}

// D5 responses: every native tool has a recorded response, each reads through its typed method's reader, and the recorded arguments validate against the snapshot.
#[test]
fn every_recorded_response_reads() {
    let snap = snapshot(NATIVE);
    let mut seen = BTreeSet::new();
    let mut errors = Vec::new();
    for file in std::fs::read_dir(RESPONSES).unwrap() {
        let path = file.unwrap().path();
        let tool = path.file_stem().unwrap().to_str().unwrap().to_owned();
        let recorded: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let result: CallToolResult = serde_json::from_value(recorded["result"].clone()).unwrap();
        if let Err(e) = read_recorded(&tool, &result) {
            errors.push(format!("{tool}: {e}"));
        }
        validate(
            &recorded["arguments"],
            &snap[&tool],
            &format!("{tool} arguments"),
            &mut errors,
        );
        seen.insert(tool);
    }
    assert!(
        errors.is_empty(),
        "recorded responses don't read:\n  {}",
        errors.join("\n  ")
    );
    assert_eq!(
        seen,
        snap.keys().cloned().collect::<BTreeSet<_>>(),
        "one recording per native tool"
    );
}

#[test]
fn recorded_values_read_as_typed() {
    let load = |tool: &str| -> CallToolResult {
        let text = std::fs::read_to_string(format!("{RESPONSES}/{tool}.json")).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        serde_json::from_value(v["result"].clone()).unwrap()
    };
    let bound = BindArgs::read(&load("bind")).unwrap();
    assert_eq!((bound.name.as_str(), bound.ownership), ("rec-a", 1));
    match ClaimTakeArgs::read(&load("claim_take")).unwrap().value {
        ClaimTaken::Taken { claim, renewed } => {
            assert_eq!(claim.key, "ticket:ENG-142");
            assert!(!renewed);
        }
        held => panic!("{held:?}"),
    }
    let peers = PeerListArgs::read(&load("peer_list")).unwrap();
    assert!(peers.peers.iter().any(|p| p.is_self));
    assert!(peers.peers.iter().any(|p| p.launcher));
    let inbox = DmInboxArgs::read(&load("dm_inbox")).unwrap();
    assert_eq!(
        inbox.unanswered[0].from.as_deref(),
        Some("you@example.com/rec-a")
    );
    let acked = DmAckArgs::read(&load("dm_ack")).unwrap();
    assert!(acked.not_found.is_empty());
}

// D4: a typed method sends its struct's arguments, reads the value, and keeps the text blocks after it as notices.
#[tokio::test]
async fn a_typed_method_sends_its_arguments_and_keeps_notices() {
    let fake = Fake::start(false, |req, _| {
        HttpReply::result(
            req,
            json!({"content": [
                {"type": "text", "text": "{\"post_id\": 12, \"board\": \"e2e\", \"notified\": [\"fe\"], \"new_field\": 1}"},
                {"type": "text", "text": "a notice"}
            ]}),
        )
    })
    .await;
    let s = session(&fake);
    let posted = s
        .board_post(BoardPostArgs {
            parent_id: Some(7),
            ..BoardPostArgs::new("e2e", "done")
        })
        .await
        .unwrap();
    assert_eq!(posted.post_id, 12);
    assert_eq!(posted.notified, ["fe"]);
    assert_eq!(posted.extra["new_field"], 1);
    assert_eq!(posted.notices, ["a notice"]);
    let call = &fake.calls("tools/call")[0];
    assert_eq!(call.body["params"]["name"], "board_post");
    assert_eq!(
        call.body["params"]["arguments"],
        json!({"board": "e2e", "body": "done", "parent_id": 7})
    );
}

// D4: a refusal is `Error::Refusal`, compared by code.
#[tokio::test]
async fn a_refusal_is_a_typed_code() {
    let fake = Fake::start(false, |req, _| {
        HttpReply::result(
            req,
            json!({"isError": true, "content": [{"type": "text", "text": "error: no such board #nope"}], "structuredContent": {"code": "not_found"}}),
        )
    })
    .await;
    let s = session(&fake);
    match s.board_read(BoardReadArgs::new("nope")).await {
        Err(Error::Refusal { code, .. }) => assert_eq!(code, "not_found"),
        other => panic!("{other:?}"),
    }
    match s.claim_release(ClaimReleaseArgs::new("k")).await {
        Err(Error::Refusal { code, .. }) => assert_eq!(code, "not_found"),
        other => panic!("{other:?}"),
    }
}

// D4: `"ok"` and other confirmation text are unit success; `dm_ack`'s `"ok"` is an empty `Acked`; a key someone else holds is `ClaimTaken::Held`, not an error.
#[tokio::test]
async fn confirmations_and_results_that_are_not_refusals() {
    let fake = Fake::start(false, |req, _| {
        let text = match req.body["params"]["name"].as_str().unwrap() {
            "claim_release" => "already released by you at 2026-11-16T00:00:00.000Z".to_owned(),
            "dm_ack" if req.body["params"]["arguments"]["message_id"].is_array() => {
                "{\"acked\": [1], \"not_found\": [2], \"note\": \"no message 2\"}".to_owned()
            }
            "dm_ack" => "ok".to_owned(),
            "claim_take" => {
                json!({"ok": false, "held_by": "be", "note": "mine", "expires_at": 1}).to_string()
            }
            other => panic!("unexpected {other}"),
        };
        HttpReply::result(req, json!({"content": [{"type": "text", "text": text}]}))
    })
    .await;
    let s = session(&fake);
    s.claim_release(ClaimReleaseArgs::new("k")).await.unwrap();
    assert!(
        s.dm_ack(DmAckArgs::new(1))
            .await
            .unwrap()
            .not_found
            .is_empty()
    );
    match s.claim_take(ClaimTakeArgs::new("k")).await.unwrap().value {
        ClaimTaken::Held { held_by, note, .. } => {
            assert_eq!((held_by.as_str(), note.as_deref()), ("be", Some("mine")))
        }
        taken => panic!("{taken:?}"),
    }
    // A partial ack (some IDs not found) is a result, not a refusal.
    let partial = s.dm_ack(DmAckArgs::new(vec![1, 2])).await.unwrap();
    assert_eq!(
        (partial.acked.as_slice(), partial.not_found.as_slice()),
        (&[1][..], &[2][..])
    );
}

/// Fields the server adds only on some branch, which the recording doesn't reach: whoami after a revocation (`alias_lost`, objects), an unbound root (`unbound`, `candidates`), a child (`root`, `child`).
#[tokio::test]
async fn whoami_reads_the_conditional_fields() {
    let fake = Fake::start(false, |req, _| {
        let whoami = json!({
            "id": "id:abc", "principal": "you@example.com", "held": [], "primary": null, "ownership": 3,
            "alias_lost": [{"alias": "you@example.com/be", "reason": "removed from team core"}, {"alias": "you@example.com/fe"}],
            "writes_as": "you@example.com/be", "root": "id:root", "child": true, "unbound": true,
            "candidates": [{"name": "be", "queued": 2, "claims": 1, "where": null, "suggested": true}]
        });
        HttpReply::result(
            req,
            json!({"content": [{"type": "text", "text": whoami.to_string()}]}),
        )
    })
    .await;
    let me = session(&fake).whoami().await.unwrap();
    let lost: Vec<_> = me
        .alias_lost
        .iter()
        .map(|l| (l.alias.as_str(), l.reason.as_deref()))
        .collect();
    assert_eq!(
        lost,
        [
            ("you@example.com/be", Some("removed from team core")),
            ("you@example.com/fe", None)
        ]
    );
    assert_eq!(
        (
            me.writes_as.as_deref(),
            me.root.as_deref(),
            me.child,
            me.unbound
        ),
        (Some("you@example.com/be"), Some("id:root"), true, true)
    );
    let c = &me.candidates[0];
    assert_eq!(
        (
            c.name.as_str(),
            c.queued,
            c.claims,
            c.where_.as_deref(),
            c.suggested
        ),
        ("be", Some(2), Some(1), None, true)
    );
}

/// `dm_ack`'s bare confirmation is a full ack only as `"ok"` or `"ok: …"`; no value and no such text is invalid, not success.
#[tokio::test]
async fn dm_ack_defaults_only_on_ok() {
    let fake = Fake::start(false, |req, _| {
        let content = match req.body["params"]["arguments"]["message_id"]
            .as_u64()
            .unwrap()
        {
            1 => json!([{"type": "text", "text": "ok"}]),
            2 => json!([{"type": "text", "text": "ok: already acked"}]),
            3 => json!([]),
            _ => json!([{"type": "text", "text": "done"}]),
        };
        HttpReply::result(req, json!({"content": content}))
    })
    .await;
    let s = session(&fake);
    for id in [1, 2] {
        let acked = s.dm_ack(DmAckArgs::new(id)).await.unwrap();
        assert!(acked.acked.is_empty() && acked.not_found.is_empty(), "{id}");
    }
    for id in [3, 4] {
        match s.dm_ack(DmAckArgs::new(id)).await {
            Err(Error::InvalidResponse(_)) => {}
            other => panic!("{id}: {other:?}"),
        }
    }
}
