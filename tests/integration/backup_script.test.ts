// deploy/backup.sh writes the full database snapshot to a private, unpredictable
// temp dir and removes it (#92). sqlite3 and aws are stand-ins on PATH that
// record what they saw.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../support/paths.ts";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

function fixture(opts: { awsFails?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), "gb-backup-"));
  const bin = join(dir, "bin"), tmp = join(dir, "tmp"), log = join(dir, "log");
  for (const d of [bin, tmp, join(dir, "blobs")]) mkdirSync(d);
  // `.backup '<path>'`: record the path and the modes of the file and its dir.
  writeFileSync(join(bin, "sqlite3"), `#!/usr/bin/env bash
target="\${2#.backup }"; target="\${target#\\'}"; target="\${target%\\'}"
printf 'x' > "$target"
echo "sqlite3 $target file=$(stat -c %a "$target") dir=$(stat -c %a "$(dirname "$target")")" >> "${log}"
`);
  writeFileSync(join(bin, "aws"), `#!/usr/bin/env bash
echo "aws $*" >> "${log}"
${opts.awsFails ? "exit 1" : ""}
`);
  for (const f of ["sqlite3", "aws"]) chmodSync(join(bin, f), 0o755);
  const run = () => Bun.spawnSync(["bash", join(ROOT, "deploy/backup.sh")], {
    env: { PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, S3_BUCKET: "bucket", GRAYBOARD_DB_PATH: join(dir, "bus.db") },
    stdout: "pipe", stderr: "pipe",
  });
  return { tmp, log, run, lines: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] };
}

test("the snapshot goes to a 0700 mktemp dir under TMPDIR, mode 0600, and the dir is removed", () => {
  const f = fixture();
  const r = f.run();
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  const [snap, ...aws] = f.lines();
  const m = /^sqlite3 (\S+) file=(\d+) dir=(\d+)$/.exec(snap!);
  expect(m, snap).not.toBeNull();
  const [, target, fileMode, dirMode] = m!;
  expect(target!.startsWith(join(f.tmp, "grayboard-backup."))).toBe(true);
  expect(target).not.toBe(join(f.tmp, `grayboard-backup-${new Date().toISOString().slice(0, 10)}.sqlite`));
  expect([fileMode, dirMode]).toEqual(["600", "700"]);
  expect(aws[0]).toStartWith(`aws s3 cp ${target} s3://bucket/grayboard/`);
  expect(readdirSync(f.tmp)).toEqual([]);
});

test("a failed upload still removes the snapshot", () => {
  const f = fixture({ awsFails: true });
  expect(f.run().exitCode).not.toBe(0);
  expect(f.lines()[0]).toStartWith("sqlite3 ");
  expect(readdirSync(f.tmp)).toEqual([]);
});
