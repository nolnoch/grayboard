// Command-line rewrites applied before commander parses argv.

// An OAuth grant id as every release has issued it: 32 random bytes as base64url, 43 characters. About 1 in 64 issued
// before #1583 starts with '-', which commander reads as an option, so `grants revoke -nPD…` fails "Unknown option",
// and one that starts with -h or -V prints help or the version and exits 0, the parent commands' combined short flags.
// No option of any command is 43 characters of this alphabet, so only an id matches.
const DASH_GRANT_ID = /^-[A-Za-z0-9_-]{42}$/;

// `grants revoke <id>` with a '-'-leading grant id: moves the id behind a `--`, which ends option parsing at every
// level, so it reaches the command as its operand. Any other argv, or one that already has a `--` after `revoke`,
// comes back unchanged.
export function protectGrantIds(argv: string[]): string[] {
  const at = argv.findIndex((a, i) => i >= 2 && a === "grants" && argv[i + 1] === "revoke");
  if (at < 0 || argv.slice(2, at).includes("--")) return argv;
  const tail = argv.slice(at + 2);
  if (tail.includes("--")) return argv;
  const ids = tail.filter(a => DASH_GRANT_ID.test(a));
  if (!ids.length) return argv;
  return [...argv.slice(0, at + 2), ...tail.filter(a => !DASH_GRANT_ID.test(a)), "--", ...ids];
}
