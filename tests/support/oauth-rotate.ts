import { openDatabase } from "../../src/server/db.ts";

const [path, blobs, raw, at] = process.argv.slice(2);
const { db, repo } = openDatabase(path!, { blobDir: blobs! });
console.log("READY");
await Bun.stdin.text();
console.error("ROTATING");
try {
  console.log(JSON.stringify(repo.oauth.rotateRefresh(JSON.parse(raw!), Number(at))));
} finally {
  db.close();
}
