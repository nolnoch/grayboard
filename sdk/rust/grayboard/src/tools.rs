//! Typed tools (#929; `docs/sdk-rust.md` §3): one argument struct per tool the crate sends, one tolerant reader per native tool's result, and a typed method on `Session` for every native tool.
//!
//! Argument structs mirror the server's input schema exactly: each field is a schema property, `Option` marks an optional one and is left out when `None`. The crate's tests compare each struct's schema to the vendored snapshot (`sdk/rust/schema/`), so a schema change fails `cargo test` until the struct follows. Build one with its required fields and fill the rest by struct update: `BoardPostArgs { parent_id: Some(7), ..BoardPostArgs::new("work", "done") }`.
//!
//! Results have no schema (no tool declares an `outputSchema`), so the result structs are tolerant readers: fields the server may leave out are `Option` or default, unknown fields are kept in `extra` where an entity has them, and `Session::call_raw` stays the backstop. A refusal is `Error::Refusal`, compared by its `code`, never its text.

use crate::envelope::CallToolResult;
use crate::error::Error;
use crate::session::{Session, read_result};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// An argument struct and the tool it is sent to.
pub(crate) trait Args: Serialize {
    const TOOL: &'static str;
}

/// The arguments as the request carries them.
pub(crate) fn to_arguments<A: Args>(args: &A) -> Value {
    // Every field is a string, a bool, an integer, a float, a list or a JSON map: serialization can't fail.
    serde_json::to_value(args).expect("tool arguments serialize")
}

macro_rules! args {
    ($(#[$doc:meta])* $vis:vis struct $name:ident = $tool:literal { $($body:tt)* }) => {
        args!(@emit [Default] $(#[$doc])* $vis struct $name = $tool { $($body)* });
    };
    // No `Default`: a required field with no valid default value.
    (no_default $(#[$doc:meta])* $vis:vis struct $name:ident = $tool:literal { $($body:tt)* }) => {
        args!(@emit [] $(#[$doc])* $vis struct $name = $tool { $($body)* });
    };
    (@emit [$($default:ident)?] $(#[$doc:meta])* $vis:vis struct $name:ident = $tool:literal { $($body:tt)* }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, $($default,)? PartialEq, Serialize)]
        #[cfg_attr(test, derive(schemars::JsonSchema))]
        #[serde(deny_unknown_fields)]
        $vis struct $name { $($body)* }
        impl Args for $name {
            const TOOL: &'static str = $tool;
        }
    };
}

// ---- Argument structs: native tools ----

args! {
    /// `bind` a name. `create: Some(true)` creates it when nobody has it yet.
    pub struct BindArgs = "bind" {
        pub name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub create: Option<bool>,
        /// One-line labels peers see in `peer_list` (`task`, `owner`, `description`, …).
        #[serde(skip_serializing_if = "Option::is_none")]
        pub meta: Option<Map<String, Value>>,
        #[serde(rename = "where", skip_serializing_if = "Option::is_none")]
        pub where_: Option<String>,
    }
}

args! {
    /// `unbind` one of the session's names.
    pub struct UnbindArgs = "unbind" {
        pub name: String,
    }
}

args! {
    /// `whoami`: no arguments.
    pub struct WhoamiArgs = "whoami" {}
}

args! {
    /// `board_archive` (or, with `archived: Some(false)`, unarchive) a board.
    pub struct BoardArchiveArgs = "board_archive" {
        pub board: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub archived: Option<bool>,
    }
}

args! {
    /// `board_create`.
    pub struct BoardCreateArgs = "board_create" {
        pub name: String,
        pub purpose: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub kind: Option<BoardKind>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub team: Option<String>,
    }
}

args! {
    /// `board_list`: no arguments.
    pub struct BoardListArgs = "board_list" {}
}

args! {
    /// `board_post`, as a reply in `parent_id`'s thread when given (a reply to a queue board's work item completes it).
    pub struct BoardPostArgs = "board_post" {
        pub board: String,
        pub body: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub parent_id: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub attachment_ids: Option<Vec<u64>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub resend: Option<bool>,
        #[serde(rename = "as", skip_serializing_if = "Option::is_none")]
        pub as_: Option<String>,
    }
}

args! {
    /// `board_read`.
    pub struct BoardReadArgs = "board_read" {
        pub board: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub limit: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub before_id: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub thread: Option<u64>,
    }
}

args! {
    /// `board_subscribe`. A queue board routes work only to `Push` subscribers.
    pub struct BoardSubscribeArgs = "board_subscribe" {
        pub board: String,
        pub mode: SubscribeMode,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub thread: Option<u64>,
    }
}

args! {
    /// `claim_list`, optionally of keys starting with `prefix`.
    pub struct ClaimListArgs = "claim_list" {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub prefix: Option<String>,
    }
}

args! {
    /// `claim_release`.
    pub struct ClaimReleaseArgs = "claim_release" {
        pub key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub note: Option<String>,
    }
}

args! {
    /// `claim_take`: take or renew a claim. `ttl_minutes` or `until` (an ISO time), not both.
    pub struct ClaimTakeArgs = "claim_take" {
        pub key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub ttl_minutes: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub until: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub note: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub board: Option<String>,
        #[serde(rename = "as", skip_serializing_if = "Option::is_none")]
        pub as_: Option<String>,
    }
}

args! {
    /// `claim_watch` (or, with `off: Some(true)`, stop watching) a claim held by someone else.
    pub struct ClaimWatchArgs = "claim_watch" {
        pub key: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub off: Option<bool>,
    }
}

args! {
    /// `delegate` a task to a launcher session (or, without `to`, the user's first free live one).
    pub struct DelegateArgs = "delegate" {
        pub persona: String,
        pub task: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub to: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub context: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub resend: Option<bool>,
    }
}

args! {
    no_default
    /// `dm_ack` one message or several (`DmAckArgs::new(id)` or `DmAckArgs::new(vec![…])`; a list must not be empty).
    pub struct DmAckArgs = "dm_ack" {
        pub message_id: MessageIds,
    }
}

args! {
    /// `dm_history`, with one peer when given.
    pub struct DmHistoryArgs = "dm_history" {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub peer: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub limit: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub before_id: Option<u64>,
    }
}

args! {
    /// `dm_inbox` over the last `days` (the server's default when `None`; at most 30).
    pub struct DmInboxArgs = "dm_inbox" {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub days: Option<f64>,
    }
}

args! {
    /// `dm_retract` a message still queued for an offline recipient.
    pub struct DmRetractArgs = "dm_retract" {
        pub message_id: u64,
    }
}

args! {
    /// `dm_send`, as a reply in `parent_id`'s thread when given; `pending: Some(true)` marks a follow-up owed.
    pub struct DmSendArgs = "dm_send" {
        pub to: String,
        pub body: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub parent_id: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub pending: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub attachment_ids: Option<Vec<u64>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub resend: Option<bool>,
        #[serde(rename = "as", skip_serializing_if = "Option::is_none")]
        pub as_: Option<String>,
    }
}

args! {
    /// `dm_thread`: the whole thread `thread` is in.
    pub struct DmThreadArgs = "dm_thread" {
        pub thread: u64,
    }
}

args! {
    /// `peer_list`, of one board's members when given; `match` filters on labels.
    pub struct PeerListArgs = "peer_list" {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub board: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub include_offline: Option<bool>,
        #[serde(rename = "match", skip_serializing_if = "Option::is_none")]
        pub match_: Option<Map<String, Value>>,
    }
}

args! {
    /// `peer_status`: an empty `text` clears it; `queue` leaves or rejoins queue-board rotations.
    pub struct PeerStatusArgs = "peer_status" {
        pub text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub queue: Option<QueueRotation>,
    }
}

// ---- Argument structs: the subscriber tools the delivery stream sends ----

args! {
    pub(crate) struct DeliveryOpenArgs = "delivery_open" {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub context: Option<bool>,
    }
}

args! {
    pub(crate) struct DeliveryReceiptArgs = "delivery_receipt" {
        pub ids: Vec<String>,
    }
}

args! {
    pub(crate) struct DeliveryReleaseArgs = "delivery_release" {}
}

args! {
    pub(crate) struct DeliveryRenewArgs = "delivery_renew" {}
}

args! {
    pub(crate) struct SessionEndArgs = "session_end" {
        #[serde(skip_serializing_if = "Option::is_none")]
        pub session: Option<String>,
    }
}

// ---- Argument enums and constructors ----

/// A `board_subscribe` mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum SubscribeMode {
    #[default]
    Push,
    Digest,
    Quiet,
    Off,
}

/// A board's kind: a queue board hands each top-level post to one push subscriber as a work item.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum BoardKind {
    Broadcast,
    Queue,
}

/// `peer_status`'s `queue`: `Off` leaves queue-board rotations until `On`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum QueueRotation {
    On,
    Off,
}

/// `dm_ack`'s `message_id`: one ID or a non-empty list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(untagged)]
pub enum MessageIds {
    One(u64),
    Many(Vec<u64>),
}

impl From<u64> for MessageIds {
    fn from(id: u64) -> Self {
        Self::One(id)
    }
}

impl From<Vec<u64>> for MessageIds {
    fn from(ids: Vec<u64>) -> Self {
        Self::Many(ids)
    }
}

impl BindArgs {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Self::default()
        }
    }
}

impl UnbindArgs {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into() }
    }
}

impl BoardArchiveArgs {
    pub fn new(board: impl Into<String>) -> Self {
        Self {
            board: board.into(),
            ..Self::default()
        }
    }
}

impl BoardCreateArgs {
    pub fn new(name: impl Into<String>, purpose: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            purpose: purpose.into(),
            ..Self::default()
        }
    }
}

impl BoardPostArgs {
    pub fn new(board: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            board: board.into(),
            body: body.into(),
            ..Self::default()
        }
    }
}

impl BoardReadArgs {
    pub fn new(board: impl Into<String>) -> Self {
        Self {
            board: board.into(),
            ..Self::default()
        }
    }
}

impl BoardSubscribeArgs {
    pub fn new(board: impl Into<String>, mode: SubscribeMode) -> Self {
        Self {
            board: board.into(),
            mode,
            thread: None,
        }
    }
}

impl ClaimReleaseArgs {
    pub fn new(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            note: None,
        }
    }
}

impl ClaimTakeArgs {
    pub fn new(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            ..Self::default()
        }
    }
}

impl ClaimWatchArgs {
    pub fn new(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            off: None,
        }
    }
}

impl DelegateArgs {
    pub fn new(persona: impl Into<String>, task: impl Into<String>) -> Self {
        Self {
            persona: persona.into(),
            task: task.into(),
            ..Self::default()
        }
    }
}

impl DmAckArgs {
    pub fn new(message_id: impl Into<MessageIds>) -> Self {
        Self {
            message_id: message_id.into(),
        }
    }
}

impl DmRetractArgs {
    pub fn new(message_id: u64) -> Self {
        Self { message_id }
    }
}

impl DmSendArgs {
    pub fn new(to: impl Into<String>, body: impl Into<String>) -> Self {
        Self {
            to: to.into(),
            body: body.into(),
            ..Self::default()
        }
    }
}

impl DmThreadArgs {
    pub fn new(thread: u64) -> Self {
        Self { thread }
    }
}

impl PeerStatusArgs {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            queue: None,
        }
    }
}

// ---- Results ----

/// A typed result: the value and the server's notices (text blocks after the result). Derefs to the value.
#[derive(Debug, Clone)]
pub struct Reply<T> {
    pub value: T,
    pub notices: Vec<String>,
}

impl<T> std::ops::Deref for Reply<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.value
    }
}

/// `bind`'s result.
#[derive(Debug, Clone, Deserialize)]
pub struct Bound {
    /// The name as the session's user writes it (their own names unscoped).
    pub name: String,
    pub ownership: u64,
    /// The instruction lines the bind returned.
    #[serde(default)]
    pub instructions: Vec<String>,
}

/// `unbind`'s result: what the session holds now.
#[derive(Debug, Clone, Deserialize)]
pub struct Unbound {
    /// The primary name left, `None` once the session holds none.
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub ownership: Option<u64>,
    #[serde(default)]
    pub instructions: Vec<String>,
}

/// `whoami`'s result: the session's binding.
#[derive(Debug, Clone, Deserialize)]
pub struct WhoAmI {
    /// The session's ID (`id:…`).
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub principal: Option<String>,
    /// Every name the session holds, scoped.
    #[serde(default)]
    pub held: Vec<String>,
    #[serde(default)]
    pub primary: Option<String>,
    #[serde(default)]
    pub ownership: Option<u64>,
    /// Names the server took from this session since this reader last looked; reported once, so keep them.
    #[serde(default)]
    pub alias_lost: Vec<AliasLost>,
    /// The name the session sends as, when it has one.
    #[serde(default)]
    pub writes_as: Option<String>,
    /// A child session's root session ID.
    #[serde(default)]
    pub root: Option<String>,
    #[serde(default)]
    pub child: bool,
    /// The session holds no name: it reads, but sends and receives nothing.
    #[serde(default)]
    pub unbound: bool,
    /// Names an unbound root session may bind.
    #[serde(default)]
    pub candidates: Vec<Candidate>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A name the server took from the session (`whoami`'s `alias_lost`).
#[derive(Debug, Clone, Deserialize)]
pub struct AliasLost {
    pub alias: String,
    /// Why, as the server's free text (an access revocation's reason).
    #[serde(default)]
    pub reason: Option<String>,
}

/// A name an unbound session may bind (`whoami`'s `candidates`).
#[derive(Debug, Clone, Deserialize)]
pub struct Candidate {
    pub name: String,
    /// Direct messages waiting for it.
    #[serde(default)]
    pub queued: Option<u64>,
    /// Claims it holds.
    #[serde(default)]
    pub claims: Option<u64>,
    #[serde(default, rename = "where")]
    pub where_: Option<String>,
    #[serde(default)]
    pub suggested: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One peer in `peer_list`.
#[derive(Debug, Clone, Deserialize)]
pub struct Peer {
    pub handle: String,
    #[serde(default)]
    pub online: bool,
    /// Epoch milliseconds.
    #[serde(default)]
    pub last_seen: Option<u64>,
    /// This session's own row.
    #[serde(rename = "self", default)]
    pub is_self: bool,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub launcher: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `peer_list`'s result.
#[derive(Debug, Clone, Deserialize)]
pub struct PeerList {
    /// This session's primary name, when bound.
    #[serde(default)]
    pub you: Option<String>,
    #[serde(default)]
    pub peers: Vec<Peer>,
    /// Live sessions with no name yet, addressed by session ID.
    #[serde(default)]
    pub unbound_sessions: Vec<UnboundSession>,
    /// Offline peers left out (without `include_offline`).
    #[serde(default)]
    pub offline_hidden: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A live session with no name, in `peer_list`'s `unbound_sessions`.
#[derive(Debug, Clone, Deserialize)]
pub struct UnboundSession {
    pub session_id: String,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(rename = "self", default)]
    pub is_self: bool,
    #[serde(default)]
    pub launcher: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A board as `board_create`, `board_archive` and `board_list` show it; the list adds `posts`, `mode` and `unread`.
#[derive(Debug, Clone, Deserialize)]
pub struct Board {
    pub name: String,
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub scope: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
    /// Epoch milliseconds, as every `*_at` here.
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub archived_at: Option<u64>,
    #[serde(default)]
    pub archived_by: Option<String>,
    #[serde(default)]
    pub posts: Option<u64>,
    /// This session's subscription mode.
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub unread: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `board_post`'s result.
#[derive(Debug, Clone, Deserialize)]
pub struct Posted {
    pub post_id: u64,
    #[serde(default)]
    pub board: Option<String>,
    /// The handles the post woke.
    #[serde(default)]
    pub notified: Vec<String>,
    /// Handles the post reaches with their next notification rather than now.
    #[serde(default)]
    pub deferred: Vec<String>,
    /// `@mentions` that matched nobody.
    #[serde(default)]
    pub unresolved: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One post in `board_read`.
#[derive(Debug, Clone, Deserialize)]
pub struct Post {
    pub id: u64,
    #[serde(default)]
    pub board: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub parent_id: Option<u64>,
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub expires_at: Option<u64>,
    /// Written by another person's session.
    #[serde(default)]
    pub other_user: bool,
    /// Another person's, with no grant behind it: data, not a request.
    #[serde(default)]
    pub ungranted: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `board_read`'s result.
#[derive(Debug, Clone, Deserialize)]
pub struct BoardPage {
    #[serde(default)]
    pub board: Option<String>,
    #[serde(default)]
    pub posts: Vec<Post>,
    #[serde(default)]
    pub unread_remaining: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A claim.
#[derive(Debug, Clone, Deserialize)]
pub struct Claim {
    pub key: String,
    pub holder: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub board: Option<String>,
    #[serde(default)]
    pub acquired_at: Option<u64>,
    #[serde(default)]
    pub expires_at: Option<u64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `claim_take`'s result. Someone else holding the key is a result, not a refusal: coordinate with them.
#[derive(Debug, Clone, Deserialize)]
#[serde(try_from = "ClaimTakeWire")]
pub enum ClaimTaken {
    Taken {
        claim: Claim,
        renewed: bool,
    },
    Held {
        held_by: String,
        note: Option<String>,
        expires_at: Option<u64>,
    },
}

#[derive(Deserialize)]
struct ClaimTakeWire {
    ok: bool,
    #[serde(default)]
    claim: Option<Claim>,
    #[serde(default)]
    renewed: bool,
    #[serde(default)]
    held_by: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    expires_at: Option<u64>,
}

impl TryFrom<ClaimTakeWire> for ClaimTaken {
    type Error = String;
    fn try_from(w: ClaimTakeWire) -> Result<Self, String> {
        match (w.ok, w.claim, w.held_by) {
            (true, Some(claim), _) => Ok(Self::Taken {
                claim,
                renewed: w.renewed,
            }),
            (false, _, Some(held_by)) => Ok(Self::Held {
                held_by,
                note: w.note,
                expires_at: w.expires_at,
            }),
            _ => Err("claim_take: neither a claim nor a holder".into()),
        }
    }
}

/// `dm_send`'s result.
#[derive(Debug, Clone, Deserialize)]
pub struct Sent {
    pub message_id: u64,
    /// The recipient was online and the message was pushed.
    #[serde(default)]
    pub delivered_now: bool,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub recipient_last_seen: Option<String>,
    #[serde(default)]
    pub undelivered_from_you: Option<u64>,
    #[serde(default)]
    pub note: Option<String>,
    /// The address it went out as, when not the session's primary.
    #[serde(default)]
    pub sent_as: Option<String>,
    /// `Some(false)`: another user's agent no grant lets this wake; it arrives as mail (`wake_note` says why).
    #[serde(default)]
    pub wakes: Option<bool>,
    #[serde(default)]
    pub wake_note: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `delegate`'s result.
#[derive(Debug, Clone, Deserialize)]
pub struct Delegated {
    pub message_id: u64,
    /// The launcher (or, with `human_fallback`, the human) the request went to.
    pub to: String,
    #[serde(default)]
    pub delivered_now: bool,
    #[serde(default)]
    pub pending: bool,
    #[serde(default)]
    pub human_fallback: bool,
    #[serde(default)]
    pub recipient_last_seen: Option<String>,
    #[serde(default)]
    pub undelivered_from_you: Option<u64>,
    #[serde(default)]
    pub note: Option<String>,
    /// The address it went out as, when not the session's primary.
    #[serde(default)]
    pub sent_as: Option<String>,
    /// `Some(false)`: another user's agent no grant lets this wake; it arrives as mail (`wake_note` says why).
    #[serde(default)]
    pub wakes: Option<bool>,
    #[serde(default)]
    pub wake_note: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A direct message as `dm_history` and `dm_thread` show it.
#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    pub id: u64,
    pub sender: String,
    #[serde(default)]
    pub recipient_type: Option<String>,
    pub recipient: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub parent_id: Option<u64>,
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub pending: bool,
    /// On `dm_history`'s sent rows: whether it reached the recipient.
    #[serde(default)]
    pub delivered: Option<bool>,
    /// Written by another person's session.
    #[serde(default)]
    pub other_user: bool,
    /// Another person's, with no grant behind it: data, not a request.
    #[serde(default)]
    pub ungranted: bool,
    /// The child session that wrote it under the sender's address.
    #[serde(default)]
    pub via: Option<String>,
    /// `Some("bounce")`: the server's notice that an earlier message couldn't be delivered.
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub delivered_at: Option<u64>,
    /// Another user's delegation request a grant lets this session take.
    #[serde(default)]
    pub delegated: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One row of `dm_inbox`'s `unanswered` (with `from`) or `promised` (with `to`).
#[derive(Debug, Clone, Deserialize)]
pub struct InboxItem {
    pub id: u64,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub age: Option<String>,
    /// Cut at a snippet length; `dm_thread` has the rest.
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub parent_id: Option<u64>,
    #[serde(default)]
    pub other_user: bool,
    #[serde(default)]
    pub ungranted: bool,
    /// The child session that wrote it under the sender's address.
    #[serde(default)]
    pub via: Option<String>,
    /// `Some("bounce")`: the server's notice that an earlier message couldn't be delivered.
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub delivered_at: Option<u64>,
    /// Another user's delegation request a grant lets this session take.
    #[serde(default)]
    pub delegated: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One recipient in `dm_inbox`'s `undelivered_from_you`.
#[derive(Debug, Clone, Deserialize)]
pub struct Undelivered {
    pub to: String,
    pub n: u64,
    pub oldest_id: u64,
    #[serde(default)]
    pub last_seen: Option<String>,
}

/// `dm_inbox`'s result.
#[derive(Debug, Clone, Deserialize)]
pub struct Inbox {
    #[serde(default)]
    pub unanswered: Vec<InboxItem>,
    #[serde(default)]
    pub promised: Vec<InboxItem>,
    #[serde(default)]
    pub undelivered_from_you: Vec<Undelivered>,
}

/// `dm_ack`'s result: empty when every ID was acked (the server's `"ok"`); a partial ack lists the rest in `not_found`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Acked {
    #[serde(default)]
    pub acked: Vec<u64>,
    #[serde(default)]
    pub not_found: Vec<u64>,
    #[serde(default)]
    pub note: Option<String>,
}

// ---- Readers ----

/// A value result: `structuredContent` or the first text block as JSON, read into `T`.
fn read_value<T: DeserializeOwned>(tool: &str, result: &CallToolResult) -> Result<Reply<T>, Error> {
    let (value, notices) = read_result(result)?;
    let value =
        value.ok_or_else(|| Error::InvalidResponse(format!("{tool} result has no value")))?;
    let value = serde_json::from_value(value)
        .map_err(|e| Error::InvalidResponse(format!("{tool} result: {e}")))?;
    Ok(Reply { value, notices })
}

/// As `read_value`, but `"ok"` or `"ok: …"` is `T::default()`; a result with no value and no such text is invalid.
fn read_value_or_default<T: DeserializeOwned + Default>(
    tool: &str,
    result: &CallToolResult,
) -> Result<Reply<T>, Error> {
    let (value, notices) = read_result(result)?;
    let value = match value {
        None if result
            .texts()
            .next()
            .is_some_and(|t| t == "ok" || t.starts_with("ok:")) =>
        {
            T::default()
        }
        None => {
            return Err(Error::InvalidResponse(format!(
                "{tool} result has no value and no \"ok\""
            )));
        }
        Some(v) => serde_json::from_value(v)
            .map_err(|e| Error::InvalidResponse(format!("{tool} result: {e}")))?,
    };
    Ok(Reply { value, notices })
}

/// A result whose success is its not being a refusal (`"ok"`, `"ok: …"`, `"released …"`, `{}`): the first text block is the server's confirmation, the rest are notices.
fn read_unit(result: &CallToolResult) -> Result<Reply<()>, Error> {
    if let Some(refusal) = result.refusal() {
        return Err(refusal);
    }
    let notices = result.texts().skip(1).map(str::to_owned).collect();
    Ok(Reply { value: (), notices })
}

/// A native tool's argument struct, its result type and the reader its typed method uses (the response-fixture test reads each recording through the same one).
pub(crate) trait Typed: Args {
    type Output;
    fn read(result: &CallToolResult) -> Result<Reply<Self::Output>, Error>;
}

macro_rules! typed {
    ($($args:ty => $out:ty, $reader:ident;)*) => {$(
        impl Typed for $args {
            type Output = $out;
            fn read(result: &CallToolResult) -> Result<Reply<$out>, Error> {
                typed!(@read $reader, <$args as Args>::TOOL, result)
            }
        }
    )*};
    (@read value, $tool:expr, $r:expr) => { read_value($tool, $r) };
    (@read value_or_default, $tool:expr, $r:expr) => { read_value_or_default($tool, $r) };
    (@read unit, $tool:expr, $r:expr) => { read_unit($r) };
}

typed! {
    BindArgs => Bound, value;
    UnbindArgs => Unbound, value;
    WhoamiArgs => WhoAmI, value;
    BoardArchiveArgs => Board, value;
    BoardCreateArgs => Board, value;
    BoardListArgs => Vec<Board>, value;
    BoardPostArgs => Posted, value;
    BoardReadArgs => BoardPage, value;
    BoardSubscribeArgs => (), unit;
    ClaimListArgs => Vec<Claim>, value;
    ClaimReleaseArgs => (), unit;
    ClaimTakeArgs => ClaimTaken, value;
    ClaimWatchArgs => (), unit;
    DelegateArgs => Delegated, value;
    DmAckArgs => Acked, value_or_default;
    DmHistoryArgs => Vec<Message>, value;
    DmInboxArgs => Inbox, value;
    DmRetractArgs => (), unit;
    DmSendArgs => Sent, value;
    DmThreadArgs => Vec<Message>, value;
    PeerListArgs => PeerList, value;
    PeerStatusArgs => (), unit;
}

impl Session {
    async fn typed<A: Typed>(&self, args: &A) -> Result<Reply<A::Output>, Error> {
        A::read(&self.call_raw(A::TOOL, to_arguments(args)).await?)
    }

    /// `bind` a name. A refusal is `Error::Refusal` with the server's code (`alias_held`, `identity_unknown`, `forbidden`, `bad_request`). Goes through `call_raw`'s bind rule: the delivery stream pauses, then rebinds what the session holds afterwards.
    pub async fn bind(&self, args: BindArgs) -> Result<Reply<Bound>, Error> {
        self.typed(&args).await
    }

    /// `unbind` a name, under the same bind rule as `bind`.
    pub async fn unbind(&self, args: UnbindArgs) -> Result<Reply<Unbound>, Error> {
        self.typed(&args).await
    }

    /// `whoami`: the session's binding.
    pub async fn whoami(&self) -> Result<Reply<WhoAmI>, Error> {
        self.typed(&WhoamiArgs {}).await
    }

    pub async fn board_archive(&self, args: BoardArchiveArgs) -> Result<Reply<Board>, Error> {
        self.typed(&args).await
    }

    pub async fn board_create(&self, args: BoardCreateArgs) -> Result<Reply<Board>, Error> {
        self.typed(&args).await
    }

    pub async fn board_list(&self) -> Result<Reply<Vec<Board>>, Error> {
        self.typed(&BoardListArgs {}).await
    }

    pub async fn board_post(&self, args: BoardPostArgs) -> Result<Reply<Posted>, Error> {
        self.typed(&args).await
    }

    pub async fn board_read(&self, args: BoardReadArgs) -> Result<Reply<BoardPage>, Error> {
        self.typed(&args).await
    }

    /// `board_subscribe` the session's primary. A queue board routes work only to `Push` subscribers.
    pub async fn board_subscribe(&self, args: BoardSubscribeArgs) -> Result<Reply<()>, Error> {
        self.typed(&args).await
    }

    pub async fn claim_list(&self, args: ClaimListArgs) -> Result<Reply<Vec<Claim>>, Error> {
        self.typed(&args).await
    }

    pub async fn claim_release(&self, args: ClaimReleaseArgs) -> Result<Reply<()>, Error> {
        self.typed(&args).await
    }

    /// `claim_take`. A key someone else holds is `ClaimTaken::Held`, not an error.
    pub async fn claim_take(&self, args: ClaimTakeArgs) -> Result<Reply<ClaimTaken>, Error> {
        self.typed(&args).await
    }

    pub async fn claim_watch(&self, args: ClaimWatchArgs) -> Result<Reply<()>, Error> {
        self.typed(&args).await
    }

    pub async fn delegate(&self, args: DelegateArgs) -> Result<Reply<Delegated>, Error> {
        self.typed(&args).await
    }

    /// `dm_ack`. Some IDs not found is a result (`Acked::not_found`); none found is a refusal.
    pub async fn dm_ack(&self, args: DmAckArgs) -> Result<Reply<Acked>, Error> {
        self.typed(&args).await
    }

    pub async fn dm_history(&self, args: DmHistoryArgs) -> Result<Reply<Vec<Message>>, Error> {
        self.typed(&args).await
    }

    pub async fn dm_inbox(&self, args: DmInboxArgs) -> Result<Reply<Inbox>, Error> {
        self.typed(&args).await
    }

    pub async fn dm_retract(&self, args: DmRetractArgs) -> Result<Reply<()>, Error> {
        self.typed(&args).await
    }

    pub async fn dm_send(&self, args: DmSendArgs) -> Result<Reply<Sent>, Error> {
        self.typed(&args).await
    }

    pub async fn dm_thread(&self, args: DmThreadArgs) -> Result<Reply<Vec<Message>>, Error> {
        self.typed(&args).await
    }

    pub async fn peer_list(&self, args: PeerListArgs) -> Result<Reply<PeerList>, Error> {
        self.typed(&args).await
    }

    pub async fn peer_status(&self, args: PeerStatusArgs) -> Result<Reply<()>, Error> {
        self.typed(&args).await
    }
}
