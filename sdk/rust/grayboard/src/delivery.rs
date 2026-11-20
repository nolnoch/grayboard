//! The delivery stream (#929; its rules: `docs/sdk-rust.md` §2): the lease protocol of `adapters/hosted-core/src/controller.ts` `run`, as a spawned task feeding a one-slot channel.
//!
//! Deliberate differences from the controller, each a consequence of handing items to a caller instead of admitting them inline: one item is out at a time (the server receipts direct items only as an in-order prefix of unread), so the in-process dedup state is that one item rather than a 100-key set; the lease is renewed in the background while an item is out (the controller has no renew between admission and receipt, #845, because its admission is inline and fast); a `Delivery` dropped without `receipt()` is a failed admission.

use crate::error::Error;
use crate::session::{read_resource, subscriber_call};
use crate::tools::{
    BindArgs, DeliveryOpenArgs, DeliveryReceiptArgs, DeliveryReleaseArgs, DeliveryRenewArgs,
    WhoamiArgs,
};
use crate::transport::{Connection, Subscription, Timeouts};
use futures_util::Stream;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{Instant, sleep, sleep_until};
use tokio_util::sync::CancellationToken;

const INBOX: &str = "grayboard://inbox";
/// A read this long may have more behind it: read again.
const PAGE: usize = 100;
/// An item handed over this many times without a receipt stops the stream on its next showing.
const ATTEMPT_LIMIT: u32 = 8;
/// Failures in a row (not outages, not lease losses) that stop the stream.
const FAILURE_LIMIT: u32 = 8;
/// Lease losses, since the lease last proved healthy, that a reopen tolerates.
const RECOVERY_LIMIT: u32 = 3;
/// Admission-throttled reopens before the stream stops with the transport's `RateLimited`.
const THROTTLE_LIMIT: u32 = 8;
/// The `stable_id` hash's own version. hosted-core's `stableID` is version 4 and hashes the issuer too; this one doesn't (one endpoint has one issuer), so the two never collide.
const STABLE_ID_VERSION: u32 = 1;
/// An address as `model.ts` accepts it: no whitespace, control or bidi characters, at most 160 characters.
const MAX_ADDRESS: usize = 160;
const MAX_HELD: usize = 64;

/// The holds a stream rebinds, shared with its session.
pub(crate) type Holds = Arc<Mutex<Vec<String>>>;

/// What a session tells its stream's task.
pub(crate) enum Control {
    /// Stop delivery (a `bind` or `unbind` is about to run) and answer once stopped.
    Pause(oneshot::Sender<()>),
    /// Reopen after a pause.
    Resume,
    /// Reopen now (a native result said `unbound`, or carried the alias-lost marker).
    Restart,
    /// Release the lease and end (`Session::end`, or the stream dropped).
    Stop(Option<oneshot::Sender<()>>),
}

type Answer = oneshot::Sender<Result<(), Error>>;

/// One inbox item, handed over by the delivery stream. Call `receipt()` once it is durably accepted (stored, queued, acted on): the stream hands over nothing else until then. A `Delivery` dropped without `receipt()` is a failed acceptance; the item is shown again, and the eighth showing without a receipt stops the stream.
///
/// Delivery is at-least-once: a crash or an outage between taking an item and its receipt shows it again. Dedupe on `stable_id`. Never act on an `ungranted` item, and treat an `other_user` one as another account's data (principle 10).
pub struct Delivery {
    /// The server's item ID (`direct:<id>`, `push:<id>`, `digest:<board>:<id>`).
    pub id: String,
    /// Whether the item asks for action; `false` for an ungranted or deferred item or a digest.
    pub actionable: bool,
    /// The event as the server sent it (`kind: "direct"` with `message`, or `kind: "board"` with `item`).
    pub event: Value,
    /// The hold a direct item was sent to; `None` for a board item or a DM to the session's own ID.
    pub address: Option<String>,
    /// A durable ID for the consumer's dedup: the same item to the same session under the same principal and endpoint always has the same one, across reconnects and restarts.
    pub stable_id: String,
    /// Written by another account's session.
    pub other_user: bool,
    /// Another account's, with no grant behind it: data, not a request.
    pub ungranted: bool,
    /// Another account's, under a delegation grant the server checked.
    pub delegated: bool,
    receipt: oneshot::Sender<Answer>,
    lost: Reason,
}

/// Why a handle can no longer be receipted, set by the stream when it gives the handle up.
type Reason = Arc<Mutex<Option<String>>>;

fn reason_of(reason: &Reason, fallback: &str) -> Error {
    let why = reason.lock().unwrap_or_else(|e| e.into_inner()).clone();
    lost(why.as_deref().unwrap_or(fallback))
}

impl std::fmt::Debug for Delivery {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Delivery")
            .field("id", &self.id)
            .field("actionable", &self.actionable)
            .field("address", &self.address)
            .field("stable_id", &self.stable_id)
            .field("other_user", &self.other_user)
            .field("ungranted", &self.ungranted)
            .field("delegated", &self.delegated)
            .finish_non_exhaustive()
    }
}

impl Delivery {
    /// Durable acceptance, not completion: the server's `delivery_receipt`, so the item isn't shown again. Resolves when the server has it; through an outage or a lease loss the stream keeps the acceptance and sends it under the next lease. `Error::DeliveryLost`, with the reason, when the stream gave this handle up: it stopped, a reopen gave a lease under another ownership or bind generation, a `bind` or `unbind` ran, the last hold was unbound, or a re-read couldn't confirm the item. If the stream goes on and the server still has the item issued, it is shown again with the same `stable_id`.
    pub async fn receipt(self) -> Result<(), Error> {
        let (answer, result) = oneshot::channel();
        if self.receipt.send(answer).is_err() {
            return Err(reason_of(&self.lost, "the delivery stream ended"));
        }
        match result.await {
            Ok(r) => r,
            Err(_) => Err(reason_of(
                &self.lost,
                "the delivery stream ended before the receipt",
            )),
        }
    }
}

fn lost(why: &str) -> Error {
    Error::DeliveryLost(why.into())
}

/// The session's deliveries (`Session::deliveries`). Dropping it releases the lease, which ends the session on the server.
pub struct DeliveryStream {
    rx: mpsc::Receiver<Result<Delivery, Error>>,
    ctl: Option<mpsc::UnboundedSender<Control>>,
    _alive: Arc<()>,
}

impl DeliveryStream {
    pub(crate) fn spawn(
        sub: Arc<Connection>,
        session: String,
        holds: Holds,
        after: Option<tokio::task::JoinHandle<()>>,
    ) -> (
        Self,
        mpsc::UnboundedSender<Control>,
        std::sync::Weak<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let (ctl_tx, ctl) = mpsc::unbounded_channel();
        let (out, rx) = mpsc::channel(1);
        let t = sub.shared.timeouts;
        let resource = sub.shared.endpoint.as_str().to_owned();
        let task = Task {
            sub,
            session,
            resource,
            t,
            out,
            ctl,
            holds,
            lease: None,
            outstanding: None,
            attempts: HashMap::new(),
            failures: 0,
            recoveries: 0,
            throttles: 0,
            unreachable: 0,
            reidentified: false,
        };
        let handle = tokio::spawn(async move {
            if let Some(after) = after {
                let _ = after.await;
            }
            task.run().await
        });
        let alive = Arc::new(());
        let weak = Arc::downgrade(&alive);
        (
            Self {
                rx,
                ctl: Some(ctl_tx.clone()),
                _alive: alive,
            },
            ctl_tx,
            weak,
            handle,
        )
    }

    /// A stream that yields `error` and ends.
    pub(crate) fn failed(error: Error) -> Self {
        let (out, rx) = mpsc::channel(1);
        let _ = out.try_send(Err(error));
        Self {
            rx,
            ctl: None,
            _alive: Arc::new(()),
        }
    }
}

impl Stream for DeliveryStream {
    type Item = Result<Delivery, Error>;
    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}

impl Drop for DeliveryStream {
    fn drop(&mut self) {
        if let Some(ctl) = self.ctl.take() {
            let _ = ctl.send(Control::Stop(None));
        }
    }
}

struct Lease {
    capability: String,
    ownership: u64,
    bind_gen: u64,
    email: String,
}

impl Lease {
    fn key(&self, id: &str) -> String {
        format!("{}:{}:{}", self.ownership, self.bind_gen, id)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Item {
    id: String,
    actionable: bool,
    event: Value,
    ownership: u64,
    bind_gen: u64,
    address: Option<String>,
}

/// The one item out: handed over (`Out`) or accepted and not yet receipted (`Receipting`). `confirmed`: the current lease's inbox read showed it, so the server has it issued under this capability and a receipt can land.
struct Outstanding {
    id: String,
    key: String,
    confirmed: bool,
    held: Held,
    lost: Reason,
}

enum Held {
    Out(oneshot::Receiver<Answer>),
    Receipting(Option<Answer>),
}

impl Outstanding {
    /// The handle can't be receipted any more: a `receipt()` waiting or to come gets `DeliveryLost`.
    fn invalidate(self, why: &str) {
        *self.lost.lock().unwrap_or_else(|e| e.into_inner()) = Some(why.to_owned());
        if let Held::Receipting(Some(answer)) = self.held {
            let _ = answer.send(Err(lost(why)));
        }
    }
}

/// Why a round (open, then serve) ended.
enum Fail {
    Pause(oneshot::Sender<()>),
    Restart,
    Stop(Option<oneshot::Sender<()>>),
    /// Nothing held, and no remembered holds: wait for a bind.
    Idle,
    /// The session and the stream are both gone.
    Gone,
    /// `not_found`/`unbound` on a lease operation: the lease is gone.
    Lease,
    /// Reopen at once, without backoff (a lease that named another identity, once).
    Again,
    /// Stop the stream with this error.
    Terminal(Error),
    Err(Error),
}

/// Awaits `fut` unless a control message arrives first; a control message drops the in-flight request (as `controller.ts` `stop` aborts its loop).
async fn watch<T>(
    ctl: &mut mpsc::UnboundedReceiver<Control>,
    fut: impl Future<Output = T>,
) -> Result<T, Fail> {
    tokio::pin!(fut);
    loop {
        tokio::select! {
            biased;
            c = ctl.recv() => match c {
                None => return Err(Fail::Gone),
                Some(Control::Pause(ack)) => return Err(Fail::Pause(ack)),
                Some(Control::Resume) => continue,
                Some(Control::Restart) => return Err(Fail::Restart),
                Some(Control::Stop(ack)) => return Err(Fail::Stop(ack)),
            },
            r = &mut fut => return Ok(r),
        }
    }
}

fn lease_fail(e: Error) -> Fail {
    match &e {
        Error::Refusal { code, .. } if code == "not_found" || code == "unbound" => Fail::Lease,
        _ => Fail::Err(e),
    }
}

/// Runs a request under `watch`, returning the round's `Fail` from the enclosing function on a control message or an error (mapped by `$map`).
macro_rules! call {
    ($ctl:expr, $fut:expr, $map:expr) => {
        match watch($ctl, $fut).await {
            Err(f) => return f,
            Ok(Err(e)) => return $map(e),
            Ok(Ok(v)) => v,
        }
    };
}

enum Wake {
    Control(Option<Control>),
    Event(Option<Event>),
    Receipt(Option<Answer>),
    Renew,
    /// The credential installed a new token (#1265).
    Token,
}

enum Event {
    Hint,
    Closed(Option<Error>),
}

/// Reads one listen stream until `stop`: a hint marks the inbox dirty, an end or error closes the round. Its own task, so the idle timeout runs across the serve loop's other waits.
async fn read_hints(
    mut sub: Subscription,
    events: mpsc::UnboundedSender<Event>,
    stop: CancellationToken,
) {
    loop {
        tokio::select! {
            _ = stop.cancelled() => {
                sub.close().await;
                return;
            }
            r = sub.next() => match r {
                Ok(Some(n)) => {
                    if n.method == "notifications/resources/updated" {
                        let _ = events.send(Event::Hint);
                    }
                }
                Ok(None) => {
                    let _ = events.send(Event::Closed(None));
                    return;
                }
                Err(e) => {
                    let _ = events.send(Event::Closed(Some(e)));
                    return;
                }
            },
        }
    }
}

/// The round's listen stream: its reader task and the hints it sends.
struct Listener {
    events: mpsc::UnboundedReceiver<Event>,
    stop: CancellationToken,
    /// `None` once closed: a reopen that failed leaves it so, and the round's own close then has nothing to wait for.
    reader: Option<tokio::task::JoinHandle<()>>,
}

impl Listener {
    fn start(subscription: Subscription) -> Self {
        let (events_tx, events) = mpsc::unbounded_channel();
        let stop = CancellationToken::new();
        let reader = tokio::spawn(read_hints(subscription, events_tx, stop.clone()));
        Self {
            events,
            stop,
            reader: Some(reader),
        }
    }

    /// Cancels the listen (its `notifications/cancelled` goes out before this returns) and waits for the reader.
    async fn close(&mut self) {
        self.stop.cancel();
        if let Some(reader) = self.reader.take() {
            let _ = reader.await;
        }
    }
}

/// Resolves when the credential's token changes; never for a credential that reports no changes, or once its sender is gone.
async fn token_changed(changes: &mut Option<tokio::sync::watch::Receiver<u64>>) {
    if let Some(rx) = changes
        && rx.changed().await.is_ok()
    {
        return;
    }
    std::future::pending().await
}

struct Task {
    sub: Arc<Connection>,
    session: String,
    resource: String,
    t: Timeouts,
    out: mpsc::Sender<Result<Delivery, Error>>,
    ctl: mpsc::UnboundedReceiver<Control>,
    holds: Holds,
    lease: Option<Lease>,
    outstanding: Option<Outstanding>,
    attempts: HashMap<String, u32>,
    /// Failures in a row that aren't outages or lease losses; reset by a receipt.
    failures: u32,
    /// Lease losses; reset by a healthy renew or receipt.
    recoveries: u32,
    /// Admission-throttled reopens in a row; reset by a receipt.
    throttles: u32,
    /// Outages in a row (unreachable, stream closed); no limit; reset by a healthy renew or receipt.
    unreachable: u32,
    reidentified: bool,
}

impl Task {
    fn holds(&self) -> Vec<String> {
        self.holds.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn set_holds(&self, held: Vec<String>) {
        *self.holds.lock().unwrap_or_else(|e| e.into_inner()) = held;
    }

    fn backoff(&self, n: u32, unit: Duration) -> Duration {
        unit.saturating_mul(1u32 << n.min(20))
            .min(self.t.backoff_max)
    }

    fn pending_item(&self) -> Option<String> {
        self.outstanding.as_ref().map(|o| o.id.clone())
    }

    async fn run(mut self) {
        let mut next: Option<Fail> = None;
        loop {
            let fail = match next.take() {
                Some(f) => f,
                None => self.round().await,
            };
            let wait = match fail {
                Fail::Gone => return self.drop_outstanding("the session ended"),
                Fail::Stop(ack) => {
                    self.release().await;
                    self.drop_outstanding("the delivery stream was closed");
                    if let Some(ack) = ack {
                        let _ = ack.send(());
                    }
                    return;
                }
                Fail::Pause(ack) => {
                    self.lose_lease();
                    let _ = ack.send(());
                    next = self.wait_resume().await;
                    continue;
                }
                Fail::Idle => {
                    self.lose_lease();
                    // Nothing held: the item can't be receipted under any lease until a bind, which starts a new bind generation anyway.
                    self.drop_outstanding("the last hold was unbound");
                    next = self.wait_resume().await;
                    continue;
                }
                Fail::Restart | Fail::Again => {
                    self.lose_lease();
                    continue;
                }
                Fail::Terminal(e) => return self.finish(e).await,
                Fail::Lease => {
                    // Counted with an item out too (controller.ts exempts losses inside an item, whose admission is inline and brief): a caller holding an item would otherwise keep a lease that never comes back reopening forever. The item's own reconfirming renew is healthy and resets the count.
                    self.lose_lease();
                    self.recoveries += 1;
                    if self.recoveries > RECOVERY_LIMIT {
                        let item = self.pending_item();
                        return self
                            .finish(Error::DeliveryStopped {
                                code: "lease_lost",
                                item,
                                message:
                                    "the delivery lease was lost four times without a healthy renew"
                                        .into(),
                            })
                            .await;
                    }
                    self.backoff(self.recoveries, self.t.backoff_unit)
                }
                Fail::Err(e) => match self.classify(e).await {
                    Ok(wait) => wait,
                    Err(stop) => return self.finish(stop).await,
                },
            };
            if let Err(f) = watch(&mut self.ctl, sleep(wait)).await {
                next = Some(f);
            }
        }
    }

    /// The wait before the next reopen, or the error that stops the stream.
    async fn classify(&mut self, e: Error) -> Result<Duration, Error> {
        match &e {
            Error::Cancelled => Err(e),
            // The server down or the stream closed under it: no limit, since leases don't count server downtime (#423). A lease tool's lost response is safe to repeat.
            Error::Unreachable(_) | Error::OutcomeUnknown(_) => {
                self.lose_lease();
                self.unreachable += 1;
                Ok(self.backoff(self.unreachable, self.t.backoff_unit))
            }
            Error::RateLimited { retry_after } => {
                self.lose_lease();
                self.throttles += 1;
                self.failures += 1;
                if self.throttles >= THROTTLE_LIMIT || self.failures >= FAILURE_LIMIT {
                    return Err(e);
                }
                let floor = self.backoff(self.throttles, self.t.throttle_unit);
                Ok((*retry_after).max(floor))
            }
            Error::Refusal { code, .. } if code == "alias_held" || code == "identity_unknown" => {
                Err(e)
            }
            Error::Unauthorized(_)
            | Error::InsufficientScope
            | Error::Incompatible { .. }
            | Error::ConnectRefused { .. }
            | Error::Auth(_)
            | Error::InvalidArgument(_)
            | Error::HeaderMismatch(_) => Err(e),
            _ => {
                self.failures += 1;
                if let Error::Refusal { code, .. } = &e
                    && code == "receipt_capacity"
                {
                    // Release ends the session on the server; the reopen's whoami then finds nothing held and rebinds the remembered holds with create: false.
                    self.release().await;
                }
                self.lose_lease();
                if self.failures >= FAILURE_LIMIT {
                    return Err(Error::DeliveryStopped {
                        code: "retry_exhausted",
                        item: self.pending_item(),
                        message: format!("eight failures in a row, the last: {e}"),
                    });
                }
                Ok(self.backoff(self.failures, self.t.backoff_unit))
            }
        }
    }

    /// Paused or idle: waits for `Resume`. `None` reopens. A `Restart` (an unbound or alias-lost result on a concurrent native call) waits too: reopening mid-bind would see the bind's holds before the session refreshed them; the `Resume` reopens from `whoami` anyway. The session's cancellation ends the wait, so a dropped `Session` ends an idle stream.
    async fn wait_resume(&mut self) -> Option<Fail> {
        let cancel = self.sub.cancel.clone();
        loop {
            let c = tokio::select! {
                c = self.ctl.recv() => c,
                _ = cancel.cancelled() => return Some(Fail::Gone),
            };
            match c {
                None => return Some(Fail::Gone),
                Some(Control::Restart) => {}
                Some(Control::Resume) => return None,
                Some(Control::Pause(ack)) => {
                    let _ = ack.send(());
                }
                Some(Control::Stop(ack)) => return Some(Fail::Stop(ack)),
            }
        }
    }

    /// The lease is gone or abandoned: the header goes, and an item out needs the next lease's read before its receipt.
    fn lose_lease(&mut self) {
        self.lease = None;
        self.sub.set_lease(None);
        if let Some(o) = &mut self.outstanding {
            o.confirmed = false;
        }
    }

    /// `delivery_release` under the current lease, if any, best effort; it ends the session on the server.
    async fn release(&mut self) {
        if let Some(lease) = self.lease.take() {
            self.sub.set_lease(Some(lease.capability));
            let _ = subscriber_call(&self.sub, &DeliveryReleaseArgs {}).await;
        }
        self.lose_lease();
    }

    fn drop_outstanding(&mut self, why: &str) {
        if let Some(o) = self.outstanding.take() {
            o.invalidate(why);
        }
    }

    async fn finish(mut self, e: Error) {
        self.drop_outstanding("the delivery stream stopped");
        if matches!(e, Error::Cancelled) {
            return;
        }
        // The error survives pauses and restarts (the stream is over; a bind just proceeds); only a Stop, the caller giving up the stream, or the session going drops it.
        let cancel = self.sub.cancel.clone();
        let send = self.out.send(Err(e));
        tokio::pin!(send);
        loop {
            tokio::select! {
                biased;
                c = self.ctl.recv() => match c {
                    Some(Control::Pause(ack)) => { let _ = ack.send(()); }
                    Some(Control::Resume | Control::Restart) => {}
                    Some(Control::Stop(ack)) => {
                        if let Some(ack) = ack { let _ = ack.send(()); }
                        return;
                    }
                    None => return,
                },
                _ = cancel.cancelled() => return,
                _ = &mut send => return,
            }
        }
    }

    /// One lease: open it, then serve the inbox until something ends it.
    async fn round(&mut self) -> Fail {
        let sub = Arc::clone(&self.sub);
        // This connection outlives leases (the controller makes a fresh wire per reopen): whoami, bind and delivery_open carry no stale capability.
        sub.set_lease(None);
        let current = call!(
            &mut self.ctl,
            subscriber_call(&sub, &WhoamiArgs {}),
            Fail::Err
        );
        // An invalid whoami (a child session, a malformed hold) stops at once, as `model.ts` `bindingOf` does: retrying can't fix the server's answer.
        let binding = match Binding::of(&current) {
            Ok(b) => b,
            Err(e) => return Fail::Terminal(e),
        };
        let mut holds = self.holds();
        // Holds the server took (#453): dropped from the remembered ones, so neither this loop nor a later one binds them again; the rest keep receiving.
        let lost: Vec<&String> = binding
            .lost
            .iter()
            .filter(|a| !binding.held.contains(a))
            .collect();
        let kept: Vec<String> = holds
            .iter()
            .filter(|a| !lost.contains(a))
            .cloned()
            .collect();
        if kept.len() != holds.len() {
            holds = kept;
            self.set_holds(holds.clone());
            if holds.is_empty() {
                return Fail::Terminal(Error::DeliveryStopped {
                    code: "alias_lost",
                    item: None,
                    message: format!(
                        "the server took every hold ({})",
                        lost.iter()
                            .map(|a| a.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                });
            }
        }
        if binding.held.is_empty() {
            if holds.is_empty() {
                return Fail::Idle;
            }
            for address in &holds {
                call!(
                    &mut self.ctl,
                    subscriber_call(
                        &sub,
                        &BindArgs {
                            create: Some(false),
                            ..BindArgs::new(address.clone())
                        }
                    ),
                    Fail::Err
                );
            }
        } else if holds.is_empty() {
            holds = binding.held.clone();
            self.set_holds(holds.clone());
        } else if binding.held != holds {
            return Fail::Terminal(Error::DeliveryStopped {
                code: "holds_changed",
                item: None,
                message: format!(
                    "the session holds {:?}, not the expected {:?}, without a bind or unbind through it",
                    binding.held, holds
                ),
            });
        }
        let opened = call!(
            &mut self.ctl,
            subscriber_call(&sub, &DeliveryOpenArgs::default()),
            lease_fail
        );
        let lease = match Lease::of(&opened, &holds[0]) {
            Ok(l) => l,
            // A primary revoked between whoami and delivery_open (#453) gives a lease naming another identity: the next whoami reports the loss. Once; a second stops.
            Err(e) if self.reidentified => return Fail::Terminal(e),
            Err(_) => {
                self.reidentified = true;
                return Fail::Again;
            }
        };
        self.reidentified = false;
        sub.set_lease(Some(lease.capability.clone()));
        if let Some(o) = &self.outstanding
            && o.key != lease.key(&o.id)
        {
            self.drop_outstanding(
                "a reopen gave a lease under another ownership or bind generation",
            );
        }
        self.lease = Some(lease);
        // Watched from before the listen opens, so a token installed while it opens reopens it (at worst once needlessly).
        let mut changes = sub.shared.credential.changes();
        if let Some(rx) = &mut changes {
            rx.mark_unchanged();
        }
        let subscription = call!(&mut self.ctl, sub.listen(&[INBOX]), Fail::Err);
        let mut listener = Listener::start(subscription);
        let fail = self.serve(&sub, &mut listener, &mut changes).await;
        // The reader's cancel notification goes out before anything that follows (a release, `session_end`): one sent after the session ended would start a new one under the same ID.
        listener.close().await;
        fail
    }

    /// The credential installed a new token: the server closes this listen stream when the token it was opened with expires, so it is replaced now, under the same lease (#1265). Close, then open: listens count against a per-user cap, and every session on one credential renews at once, so opening first could need twice the slots. Hints are nonconsuming and the server keeps the inbox position, so the caller re-reads afterwards and a hint lost in the gap costs nothing. Not an outage, failure, lease loss or throttle, and no backoff; a reopen that fails is an ordinary round failure.
    async fn relisten(
        &mut self,
        sub: &Arc<Connection>,
        listener: &mut Listener,
    ) -> Result<(), Fail> {
        listener.close().await;
        match watch(&mut self.ctl, sub.listen(&[INBOX])).await {
            Err(f) => Err(f),
            Ok(Err(e)) => Err(Fail::Err(e)),
            Ok(Ok(subscription)) => {
                *listener = Listener::start(subscription);
                Ok(())
            }
        }
    }

    async fn serve(
        &mut self,
        sub: &Arc<Connection>,
        listener: &mut Listener,
        changes: &mut Option<tokio::sync::watch::Receiver<u64>>,
    ) -> Fail {
        // The first read is unconditional: hints are nonconsuming, and the server keeps the position.
        let mut dirty = true;
        let mut more = false;
        let mut batch: VecDeque<Item> = VecDeque::new();
        let mut renew_at = Instant::now() + self.t.renew;
        loop {
            // An accepted item: its receipt, under this lease once its read confirmed it.
            if let Some(o) = &mut self.outstanding
                && o.confirmed
                && let Held::Receipting(_) = o.held
            {
                let id = o.id.clone();
                call!(
                    &mut self.ctl,
                    subscriber_call(
                        sub,
                        &DeliveryReceiptArgs {
                            ids: vec![id.clone()]
                        }
                    ),
                    lease_fail
                );
                if let Some(Outstanding {
                    held: Held::Receipting(Some(answer)),
                    ..
                }) = self.outstanding.take()
                {
                    let _ = answer.send(Ok(()));
                }
                self.attempts.remove(&id);
                self.healthy();
                if batch.is_empty() && more {
                    dirty = true;
                }
                continue;
            }
            // An item out: renew in the background until the caller receipts or drops it; no read or hand-over meanwhile.
            if let Some(o) = &mut self.outstanding
                && o.confirmed
                && let Held::Out(rx) = &mut o.held
            {
                let wake = tokio::select! {
                    biased;
                    c = self.ctl.recv() => Wake::Control(c),
                    _ = token_changed(changes) => Wake::Token,
                    e = listener.events.recv() => Wake::Event(e),
                    r = rx => Wake::Receipt(r.ok()),
                    _ = sleep_until(renew_at) => Wake::Renew,
                };
                match wake {
                    Wake::Control(c) => return control(c),
                    Wake::Event(Some(Event::Hint)) => dirty = true,
                    Wake::Event(Some(Event::Closed(e))) => return closed(e),
                    Wake::Event(None) => return closed(None),
                    Wake::Receipt(Some(answer)) => {
                        if let Some(o) = &mut self.outstanding {
                            o.held = Held::Receipting(Some(answer));
                        }
                    }
                    Wake::Receipt(None) => {
                        // Dropped without receipt(): a failed acceptance, spending the item's attempt (counted at its showing).
                        let id = self.outstanding.take().map(|o| o.id);
                        self.failures += 1;
                        if self.failures >= FAILURE_LIMIT {
                            return Fail::Terminal(Error::DeliveryStopped {
                                code: "retry_exhausted",
                                item: id,
                                message:
                                    "an item was dropped without a receipt eight times in a row"
                                        .into(),
                            });
                        }
                        let wait = self.backoff(self.failures, self.t.backoff_unit);
                        if let Err(f) = watch(&mut self.ctl, sleep(wait)).await {
                            return f;
                        }
                        batch.clear();
                        dirty = true;
                    }
                    Wake::Renew => {
                        call!(
                            &mut self.ctl,
                            subscriber_call(sub, &DeliveryRenewArgs {}),
                            lease_fail
                        );
                        renew_at = Instant::now() + self.t.renew;
                        self.recoveries = 0;
                        self.unreachable = 0;
                    }
                    Wake::Token => {
                        if let Err(f) = self.relisten(sub, listener).await {
                            return f;
                        }
                        dirty = true;
                    }
                }
                continue;
            }
            if dirty && batch.is_empty() {
                dirty = false;
                let value = call!(&mut self.ctl, read_resource(sub, INBOX), lease_fail);
                let items = match items_of(&value) {
                    Ok(items) => items,
                    Err(e) => return Fail::Err(e),
                };
                more = items.len() == PAGE;
                batch = items.into();
                // An item out under an earlier lease: this read shows it again (still issued) or not (its receipt landed).
                if let Some(o) = &self.outstanding
                    && !o.confirmed
                {
                    let id = o.id.clone();
                    match batch.iter().position(|i| i.id == id) {
                        Some(pos) => {
                            // Items ahead of it stay in the batch, for after its receipt.
                            let item = batch.remove(pos).expect("found");
                            if let Err(f) = self.show(sub, &item).await {
                                return f;
                            }
                            if let Some(o) = &mut self.outstanding {
                                o.confirmed = true;
                            }
                            renew_at = Instant::now() + self.t.renew;
                        }
                        // Not on a full page: it may be further on, and a read has no cursor to reach it, so the handle goes (`DeliveryLost`); the item comes again once it reaches the first page.
                        None if more => self.drop_outstanding(
                            "a re-read could not confirm the item: the inbox has more than a page ahead of it",
                        ),
                        // Not in the whole inbox: its receipt landed before the lease was lost (or, for an item never accepted, the server withdrew it).
                        None => {
                            match self.outstanding.take() {
                                Some(Outstanding {
                                    held: Held::Receipting(Some(answer)),
                                    ..
                                }) => {
                                    let _ = answer.send(Ok(()));
                                }
                                // Never accepted, so the server withdrew it: the handle can't receipt it.
                                Some(o) => o.invalidate("the server no longer has the item issued"),
                                None => {}
                            }
                            self.attempts.remove(&id);
                        }
                    }
                }
                continue;
            }
            if self.outstanding.is_none()
                && let Some(item) = batch.pop_front()
            {
                if let Err(f) = self.show(sub, &item).await {
                    return f;
                }
                let lease = self.lease.as_ref().expect("serving under a lease");
                let (receipt, rx) = oneshot::channel();
                let reason = Reason::default();
                let delivery = Delivery {
                    lost: Arc::clone(&reason),
                    stable_id: stable_id(&lease.email, &self.resource, &item, &self.session),
                    other_user: mark(&item.event, "other_user"),
                    ungranted: mark(&item.event, "ungranted"),
                    delegated: mark(&item.event, "delegated"),
                    id: item.id.clone(),
                    actionable: item.actionable,
                    address: item.address.clone(),
                    event: item.event,
                    receipt,
                };
                self.outstanding = Some(Outstanding {
                    key: lease.key(&item.id),
                    id: item.id,
                    confirmed: true,
                    held: Held::Out(rx),
                    lost: reason,
                });
                match watch(&mut self.ctl, self.out.send(Ok(delivery))).await {
                    Err(f) => return f,
                    // The stream is gone: its Drop sent Stop.
                    Ok(Err(_)) => return Fail::Stop(None),
                    Ok(Ok(())) => {}
                }
                renew_at = Instant::now() + self.t.renew;
                continue;
            }
            if batch.is_empty() && more {
                dirty = true;
                continue;
            }
            let wake = tokio::select! {
                biased;
                c = self.ctl.recv() => Wake::Control(c),
                _ = token_changed(changes) => Wake::Token,
                e = listener.events.recv() => Wake::Event(e),
                _ = sleep_until(renew_at) => Wake::Renew,
            };
            match wake {
                Wake::Control(c) => return control(c),
                Wake::Event(Some(Event::Hint)) => dirty = true,
                Wake::Event(Some(Event::Closed(e))) => return closed(e),
                Wake::Event(None) => return closed(None),
                Wake::Receipt(_) => {}
                Wake::Renew => {
                    // A renew re-reads the inbox: a hint lost with a dropped stream costs at most one interval.
                    call!(
                        &mut self.ctl,
                        subscriber_call(sub, &DeliveryRenewArgs {}),
                        lease_fail
                    );
                    renew_at = Instant::now() + self.t.renew;
                    self.recoveries = 0;
                    self.unreachable = 0;
                    dirty = true;
                }
                Wake::Token => {
                    if let Err(f) = self.relisten(sub, listener).await {
                        return f;
                    }
                    dirty = true;
                }
            }
        }
    }

    /// One showing of `item`: its attempt, its check against the lease, the renew that proves the lease before it goes out.
    async fn show(&mut self, sub: &Arc<Connection>, item: &Item) -> Result<(), Fail> {
        let count = self.attempts.entry(item.id.clone()).or_insert(0);
        *count += 1;
        if *count > ATTEMPT_LIMIT {
            return Err(Fail::Terminal(Error::DeliveryStopped {
                code: "retry_exhausted",
                item: Some(item.id.clone()),
                message: "the item was shown eight times without a receipt".into(),
            }));
        }
        let lease = self.lease.as_ref().expect("serving under a lease");
        let holds = self.holds();
        if item.ownership != lease.ownership
            || item.bind_gen != lease.bind_gen
            || item.address.as_ref().is_some_and(|a| !holds.contains(a))
        {
            return Err(Fail::Terminal(Error::DeliveryStopped {
                code: "identity",
                item: Some(item.id.clone()),
                message: "an issued item does not match the lease".into(),
            }));
        }
        match watch(&mut self.ctl, subscriber_call(sub, &DeliveryRenewArgs {})).await {
            Err(f) => Err(f),
            Ok(Err(e)) => Err(lease_fail(e)),
            Ok(Ok(_)) => {
                self.recoveries = 0;
                self.unreachable = 0;
                Ok(())
            }
        }
    }

    fn healthy(&mut self) {
        self.failures = 0;
        self.throttles = 0;
        self.recoveries = 0;
        self.unreachable = 0;
    }
}

fn control(c: Option<Control>) -> Fail {
    match c {
        None => Fail::Gone,
        Some(Control::Pause(ack)) => Fail::Pause(ack),
        // A stray resume changes nothing; reopening is the cheap way to say so.
        Some(Control::Resume | Control::Restart) => Fail::Restart,
        Some(Control::Stop(ack)) => Fail::Stop(ack),
    }
}

fn closed(e: Option<Error>) -> Fail {
    Fail::Err(e.unwrap_or_else(|| Error::Unreachable("the listen stream closed".into())))
}

/// `whoami` as the stream reads it (`model.ts` `bindingOf`).
struct Binding {
    held: Vec<String>,
    lost: Vec<String>,
}

fn valid_address(a: &str) -> bool {
    (1..=MAX_ADDRESS).contains(&a.chars().count())
        && !a.chars().any(|c| {
            (c as u32) <= 0x20
                || ('\u{7f}'..='\u{9f}').contains(&c)
                || ('\u{202a}'..='\u{202e}').contains(&c)
                || ('\u{2066}'..='\u{2069}').contains(&c)
        })
}

/// `whoami`'s `held`, validated: at most 64 distinct valid addresses.
pub(crate) fn held_of(value: &Value) -> Result<Vec<String>, Error> {
    let bad = || Error::InvalidResponse("whoami: invalid held".into());
    let list = value
        .get("held")
        .and_then(Value::as_array)
        .ok_or_else(bad)?;
    if list.len() > MAX_HELD {
        return Err(bad());
    }
    let mut held: Vec<String> = Vec::with_capacity(list.len());
    for a in list {
        let a = a.as_str().filter(|a| valid_address(a)).ok_or_else(bad)?;
        if held.iter().any(|h| h == a) {
            return Err(bad());
        }
        held.push(a.to_owned());
    }
    Ok(held)
}

impl Binding {
    fn of(value: &Value) -> Result<Self, Error> {
        let held = held_of(value)?;
        if value.get("child").and_then(Value::as_bool) == Some(true) {
            return Err(Error::InvalidResponse(
                "whoami: a child session has no delivery".into(),
            ));
        }
        let lost = match value.get("alias_lost") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(list)) if list.len() <= MAX_HELD => list
                .iter()
                .map(|l| {
                    l.get("alias")
                        .and_then(Value::as_str)
                        .filter(|a| valid_address(a))
                        .map(str::to_owned)
                        .ok_or_else(|| Error::InvalidResponse("whoami: invalid alias_lost".into()))
                })
                .collect::<Result<_, _>>()?,
            _ => {
                return Err(Error::InvalidResponse("whoami: invalid alias_lost".into()));
            }
        };
        Ok(Self { held, lost })
    }
}

fn safe_positive(v: Option<&Value>) -> Option<u64> {
    v.and_then(Value::as_u64)
        .filter(|n| (1..=9_007_199_254_740_991).contains(n))
}

impl Lease {
    /// `delivery_open`'s result, validated as `model.ts` `leaseOf` does: a 43-character url-safe capability, positive ownership and bind generation, a finite expiry, and an identity whose `identity_full` is the first hold.
    fn of(value: &Value, primary: &str) -> Result<Self, Error> {
        let bad = |what: &str| Error::DeliveryStopped {
            code: "identity",
            item: None,
            message: format!("invalid delivery lease: {what}"),
        };
        let capability = value
            .get("capability")
            .and_then(Value::as_str)
            .filter(|c| {
                c.len() == 43
                    && c.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
            .ok_or_else(|| bad("capability"))?;
        let ownership = safe_positive(value.get("ownership")).ok_or_else(|| bad("ownership"))?;
        let bind_gen = safe_positive(value.get("bind_gen")).ok_or_else(|| bad("bind_gen"))?;
        value
            .get("expiresAt")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .ok_or_else(|| bad("expiresAt"))?;
        let identity = value.get("identity").ok_or_else(|| bad("identity"))?;
        let email = identity
            .get("user_email")
            .and_then(Value::as_str)
            .filter(|e| !e.is_empty())
            .ok_or_else(|| bad("identity"))?;
        if identity.get("identity_full").and_then(Value::as_str) != Some(primary) {
            return Err(bad("identity names another hold"));
        }
        Ok(Self {
            capability: capability.to_owned(),
            ownership,
            bind_gen,
            email: email.to_owned(),
        })
    }
}

/// `grayboard://inbox`'s items, validated as `model.ts` `itemsOf` does.
fn items_of(value: &Value) -> Result<Vec<Item>, Error> {
    let bad = |what: &str| Error::InvalidResponse(format!("inbox: {what}"));
    let list = value
        .get("items")
        .and_then(Value::as_array)
        .filter(|a| a.len() <= PAGE)
        .ok_or_else(|| bad("invalid items"))?;
    list.iter()
        .map(|i| {
            let id = i
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| (1..=128).contains(&id.len()))
                .ok_or_else(|| bad("invalid item id"))?;
            let actionable = i
                .get("actionable")
                .and_then(Value::as_bool)
                .ok_or_else(|| bad("invalid item"))?;
            let event = i.get("event").cloned().ok_or_else(|| bad("invalid item"))?;
            let int = |k: &str| {
                i.get(k)
                    .and_then(Value::as_u64)
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or_else(|| bad("invalid item"))
            };
            let address = match i.get("address") {
                None => None,
                Some(a) => Some(
                    a.as_str()
                        .filter(|a| valid_address(a))
                        .ok_or_else(|| bad("invalid item address"))?
                        .to_owned(),
                ),
            };
            Ok(Item {
                id: id.to_owned(),
                actionable,
                event,
                ownership: int("ownership")?,
                bind_gen: int("bind_gen")?,
                address,
            })
        })
        .collect()
}

/// A writer mark (`src/server/application.ts` `writerMarks`): on a direct item's `message`, a board push's `post`, a digest's `latest`.
fn mark(event: &Value, name: &str) -> bool {
    ["/message", "/item/post", "/item/latest"].iter().any(|p| {
        event
            .pointer(p)
            .and_then(|o| o.get(name))
            .and_then(Value::as_bool)
            == Some(true)
    })
}

/// The consumer's durable dedup key: SHA-256 of `[version, principal email, resource (the endpoint), address or null, item ID, session ID]`, hex, with `msg_`. The hold an item was for, not the primary, so binding a second name never changes the IDs of items already shown.
pub(crate) fn stable_id(email: &str, resource: &str, item: &Item, session: &str) -> String {
    let input = json!([
        STABLE_ID_VERSION,
        email,
        resource,
        item.address,
        item.id,
        session
    ]);
    let digest = Sha256::digest(input.to_string().as_bytes());
    let mut out = String::with_capacity(4 + 64);
    out.push_str("msg_");
    for b in digest.iter() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Whether a native result reports the session `unbound: true` (the native `whoami`), so the stream rebinds the remembered holds.
pub(crate) fn unbound_output(result: &crate::CallToolResult) -> bool {
    if result.is_error {
        return false;
    }
    let value = result.structured_content.clone().or_else(|| {
        result
            .texts()
            .next()
            .and_then(|t| serde_json::from_str::<Value>(t).ok())
    });
    value.and_then(|v| v.get("unbound").and_then(Value::as_bool)) == Some(true)
}

/// Whether a native result carries the alias-lost marker (#453): the server took a hold.
pub(crate) fn alias_lost_meta(result: &crate::CallToolResult) -> bool {
    result
        .meta
        .as_ref()
        .and_then(|m| m.get(crate::envelope::ALIAS_LOST_META))
        .and_then(Value::as_bool)
        == Some(true)
}
