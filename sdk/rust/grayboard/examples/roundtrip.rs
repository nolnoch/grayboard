//! A queue worker through the hosted MCP endpoint (#929 stage 3; `docs/sdk-rust.md` §2): bind a name, subscribe to a queue board in push mode, take one work item and one direct message from the delivery stream, receipt each, reply to the work item in its thread (which releases its queue claim), `dm_ack` the message, then end the session.
//!
//! It authenticates as a service (#270) with its credential, minting its own run token with no browser, and revokes that token when it's done:
//!
//! ```sh
//! GRAYBOARD_URL=https://bus.example.com/mcp GRAYBOARD_ISSUER=https://bus.example.com \
//!   GRAYBOARD_CLIENT_ID=svc_... GRAYBOARD_CLIENT_SECRET=... GRAYBOARD_SESSION=rust-example-1 \
//!   cargo run --example roundtrip -- w-1 work
//! ```
//!
//! With `GRAYBOARD_TOKEN` in place of the issuer, client ID and secret, it uses that token as given (`StaticBearer`).

use futures_util::StreamExt;
use grayboard::tools::{BindArgs, BoardPostArgs, BoardSubscribeArgs, DmAckArgs, SubscribeMode};
use grayboard::{Client, ClientCredentials, ClientInfo, DeliveryMode, Error, StaticBearer};

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

    let url = env("GRAYBOARD_URL");
    let info = ClientInfo::new("grayboard-rust-roundtrip", env!("CARGO_PKG_VERSION"));
    // The service credential when one is configured; it's kept to revoke the run's token at the end.
    let (client, credential) = if std::env::var_os("GRAYBOARD_CLIENT_ID").is_some() {
        let credential = ClientCredentials::new(
            &url,
            &env("GRAYBOARD_ISSUER"),
            env("GRAYBOARD_CLIENT_ID"),
            env("GRAYBOARD_CLIENT_SECRET"),
        )?;
        (
            Client::new(&url, credential.clone(), info)?,
            Some(credential),
        )
    } else {
        let token = StaticBearer::new(env("GRAYBOARD_TOKEN"));
        (Client::new(&url, token, info)?, None)
    };
    let session = client.session(
        env("GRAYBOARD_SESSION"),
        DeliveryMode::push("grayboard-rust-roundtrip")?,
    );

    let bound = session
        .bind(BindArgs {
            create: Some(true),
            ..BindArgs::new(&name)
        })
        .await?;
    println!("bound {}", bound.name);
    session
        .board_subscribe(BoardSubscribeArgs::new(&board, SubscribeMode::Push))
        .await?;
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
            let reply = session
                .board_post(BoardPostArgs {
                    parent_id: Some(post),
                    ..BoardPostArgs::new(&board, "done")
                })
                .await?;
            println!("replied {} to {post}", reply.post_id);
            replied = true;
        } else if event["kind"] == "direct" {
            let id = event["message"]["id"].as_u64().ok_or_else(|| {
                Error::InvalidResponse("a direct item without a message id".into())
            })?;
            session.dm_ack(DmAckArgs::new(id)).await?;
            println!("acked {id}");
            acked = true;
        }
    }
    // Stops the stream (releasing its lease) before session_end.
    session.end().await?;
    if let Some(credential) = credential {
        credential.revoke().await?;
        println!("revoked the run token");
    }
    Ok(())
}
