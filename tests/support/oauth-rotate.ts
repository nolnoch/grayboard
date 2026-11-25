import { openDatabase } from "../../src/server/db.ts";
import { sessionEndPort } from "../../src/server/session_end.ts";

const [path, blobs, raw, at] = process.argv.slice(2);
const { db, repo } = openDatabase(path!, { blobDir: blobs!, sessionEnd: sessionEndPort("team") });
// The second worker waits on the paused one's lock: outwait any test's timeout, not the server's 5 s (#1134).
db.exec("PRAGMA busy_timeout = 60000");
console.log("READY");
await Bun.stdin.text();
console.error("ROTATING");
try {
  console.log(JSON.stringify(await repo.write(tx => repo.oauth.rotateRefresh(tx, JSON.parse(raw!), Number(at)))));
} finally {
  db.close();
}
