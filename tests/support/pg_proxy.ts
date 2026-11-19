// A proxy between a store and its database that cuts the connection at the client's next COMMIT once armed: dropped
// before the server sees it ("dropped"), or forwarded and its ack lost ("ack lost"). Either way the client can't know
// the outcome (#807 P3 C2 T-P18; C9b T-C9-10).
export type CommitCut = "dropped" | "ack lost";
export type CommitCutProxy = { url: string; arm(): void; stop(): void };

export function commitCutProxy(dbUrl: string, mode: CommitCut): CommitCutProxy {
  const target = new URL(dbUrl);
  const sockets = new Set<{ end(): void }>();
  let armed = false;
  type Link = { up?: { write(d: Uint8Array): number; end(): void }; pending: Uint8Array[]; muted: boolean };
  const proxy = Bun.listen<Link>({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open(client) {
        client.data = { pending: [], muted: false };
        sockets.add(client);
        void Bun.connect({ hostname: target.hostname, port: Number(target.port), socket: {
          open(up) { sockets.add(up); client.data.up = up; for (const b of client.data.pending) up.write(b); client.data.pending = []; },
          // The ack of a muted COMMIT never reaches the client: both ends close instead.
          data(up, d) { if (client.data.muted) { up.end(); client.end(); } else client.write(d); },
          close() { client.end(); },
          error() { client.end(); },
        } }).catch(() => client.end());
      },
      data(client, d) {
        const buf = Buffer.from(d);
        if (armed && buf.includes("COMMIT")) {
          armed = false;
          if (mode === "dropped") { client.data.up?.end(); client.end(); return; }
          client.data.muted = true;
        }
        if (client.data.up) client.data.up.write(buf); else client.data.pending.push(buf);
      },
      close(client) { client.data.up?.end(); },
    },
  });
  const url = new URL(dbUrl);
  url.hostname = "127.0.0.1";
  url.port = String(proxy.port);
  return {
    url: url.toString(),
    arm() { armed = true; },
    stop() { for (const sock of sockets) sock.end(); proxy.stop(true); },
  };
}
