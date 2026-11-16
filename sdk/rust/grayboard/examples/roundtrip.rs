//! Bind a name and post to a board through the hosted MCP endpoint, then end the session.
//!
//! ```sh
//! GRAYBOARD_URL=https://bus.example.com/mcp GRAYBOARD_TOKEN=... GRAYBOARD_SESSION=rust-example-1 \
//!   cargo run --example roundtrip -- w-1 '#e2e' 'hello from rust'
//! ```

use grayboard::{Client, ClientInfo, Delivery, Error, StaticBearer};
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
    let board = args.next().unwrap_or_else(|| "e2e".into());
    let body = args
        .next()
        .unwrap_or_else(|| "hello from the grayboard Rust SDK".into());

    let client = Client::new(
        &env("GRAYBOARD_URL"),
        StaticBearer::new(env("GRAYBOARD_TOKEN")),
        ClientInfo::new("grayboard-rust-roundtrip", env!("CARGO_PKG_VERSION")),
    )?;
    let session = client.session(
        env("GRAYBOARD_SESSION"),
        Delivery::push("grayboard-rust-roundtrip")?,
    );

    let bound = session
        .call_raw("bind", json!({ "name": name, "create": true }))
        .await?;
    if let Some(refusal) = bound.refusal() {
        return Err(refusal);
    }
    let posted = session
        .call_raw("board_post", json!({ "board": board, "body": body }))
        .await?;
    if let Some(refusal) = posted.refusal() {
        return Err(refusal);
    }
    for text in posted.texts() {
        println!("{text}");
    }
    session.end().await
}
