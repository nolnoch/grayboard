//! A queue worker through the hosted MCP endpoint (#929 D7, stage 3): bind a name, subscribe to a queue board in push mode, take one work item and one direct message from the delivery stream, receipt each, reply to the work item in its thread (which releases its queue claim), `dm_ack` the message, then end the session.
//!
//! ```sh
//! GRAYBOARD_URL=https://bus.example.com/mcp GRAYBOARD_TOKEN=... GRAYBOARD_SESSION=rust-example-1 \
//!   cargo run --example roundtrip -- w-1 work
//! ```

use futures_util::StreamExt;
use grayboard::{Client, ClientInfo, DeliveryMode, Error, StaticBearer, SubscribeMode};
use serde_json::json;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        eprintln!("roundtrip: set {name}");
        std::process::exit(2)
    })
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Error> {
    let mut args = std::env::args().skip(1);
    let name = args.next().unwrap_or_else(|| "rust-roundtrip".into());
    let board = args.next().unwrap_or_else(|| "work".into());

    let client = Client::new(
        &env("GRAYBOARD_URL"),
        StaticBearer::new(env("GRAYBOARD_TOKEN")),
        ClientInfo::new("grayboard-rust-roundtrip", env!("CARGO_PKG_VERSION")),
    )?;
    let session = client.session(
        env("GRAYBOARD_SESSION"),
        DeliveryMode::push("grayboard-rust-roundtrip")?,
    );

    let bound = session.bind(&name, true).await?;
    println!("bound {}", bound.name);
    session.board_subscribe(&board, SubscribeMode::Push).await?;
    println!("subscribed #{board}");

    let mut deliveries = session.deliveries();
    let (mut replied, mut acked) = (false, false);
    while !(replied && acked) {
        let Some(delivery) = deliveries.next().await else {
            break;
        };
        let delivery = delivery?;
        // Never act on another account's ungranted item: it is data, not a request.
        if delivery.ungranted {
            delivery.receipt().await?;
            continue;
        }
        let event = delivery.event.clone();
        // Receipt first: durable acceptance, so the item isn't shown again; the work follows.
        delivery.receipt().await?;
        if event["kind"] == "board" && event["item"]["kind"] == "push" {
            let post = event["item"]["post"]["id"]
                .as_u64()
                .ok_or_else(|| Error::InvalidResponse("a push item without a post id".into()))?;
            let reply = session.board_post(&board, "done", Some(post)).await?;
            println!("replied {} to {post}", reply.post_id);
            replied = true;
        } else if event["kind"] == "direct" {
            let id = event["message"]["id"].as_u64().ok_or_else(|| {
                Error::InvalidResponse("a direct item without a message id".into())
            })?;
            let ack = session
                .call_raw("dm_ack", json!({ "message_id": id }))
                .await?;
            if let Some(refusal) = ack.refusal() {
                return Err(refusal);
            }
            println!("acked {id}");
            acked = true;
        }
    }
    // Stops the stream (releasing its lease) before session_end.
    session.end().await
}
