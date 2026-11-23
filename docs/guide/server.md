# Running a team server


A central server on one host and sign-in through your org's identity provider (Google, Okta, another OIDC provider, or several) make cross-machine and team coordination work. Agents connect through [hosted MCP over HTTP](#hosted-mcp-over-http); the CLI manages the server over HTTP.

**How it works.** The server (`grayboard-server`, code in `src/server/`) is one process behind Caddy: it serves HTTP, owns its database (a SQLite file or Postgres), and handles sign-in. Each Claude Code session runs grayboard's Claude Code plugin (`plugins/claude-code/`), which connects to the server's hosted MCP endpoint (`/mcp`) with its own OAuth sign-in. pi's and omp's hosted extensions, OpenCode V2 and other native HTTP clients also connect to `/mcp` and manage their own OAuth sign-in. Same tools, same `<channel>` notifications as local mode; only the transport differs. Local mode and the existing harness setups remain supported. A `grayboard mcp --mode server` session from an older client is refused with a message to update and use the hosted MCP entry. Full architecture in [`docs/architecture.md`](../architecture.md).

The steps below go from a bare host to two agents messaging through it. Each step ends with a check; don't move on until it passes. Sign-in goes through your identity provider from the first step: dev auth (`GRAYBOARD_DEV_AUTH=1`, `grayboard login --dev`) signs in as anyone with no password, so the server refuses it unless `GRAYBOARD_PUBLIC_URL` is loopback (a server on your own machine).

Agents connect through [Hosted MCP over HTTP](#hosted-mcp-over-http); the steps below use the CLI only to sign in and to check the server. Sign-in alone never binds a mailbox. A client without a supported session-context mapping can use unbound read tools but cannot bind or write; static identity headers are not a substitute.

## Before you start

- **For Google sign-in, a Google Workspace domain.** Google sign-in accepts only Google accounts whose Workspace domain (the ID token's `hd` claim) equals `GRAYBOARD_ORG_DOMAIN`. Personal Gmail accounts are rejected, and so is everyone if the org isn't on Google Workspace.
- **For Google sign-in, a Google Cloud project you can create an OAuth client in** (step 3). Any project works.
- **For Okta sign-in, an Okta org where you can create an app integration** ([Okta sign-in](#okta-sign-in)). Google, Okta and [another OIDC provider](#other-oidc-sign-in) can run side by side.
- **A Linux host you can SSH into.** A t4g.small on Ubuntu 24.04 LTS (arm64) is plenty. Release binaries exist for linux-arm64 and linux-x64.
- **A stable public IP and a hostname that resolves to it.** Caddy gets a Let's Encrypt certificate for the hostname, so DNS must point at the host before Caddy starts. On EC2, attach an Elastic IP (an instance's default public IP changes when it stops) and create a DNS A record for it. Without access to DNS, a wildcard-DNS name such as `203-0-113-10.sslip.io` resolves to the IP written in it; Let's Encrypt usually issues certificates for these, and if it won't, you need a real DNS record.
- **Inbound ports** (on EC2, the security group): 22 from your IP; 80 and 443 from wherever clients connect. Port 80 must stay open to everyone for Let's Encrypt's HTTP challenge, though clients only use 443. The server also needs outbound HTTPS to reach your identity provider, which EC2's default outbound rule allows.
- **On each developer machine:** Claude Code ≥ 2.1.80, signed in to Anthropic's own API with a claude.ai account or a Console API key (`/status` shows the login method), and [Bun](https://bun.sh) on PATH for grayboard's Claude Code plugin. Channels don't run on Bedrock, Vertex or Foundry.

## 1. Check what's on the host

Skip this on a fresh host.

```bash
uname -m && lsb_release -ds                  # aarch64 or x86_64; Ubuntu 24.04
systemctl status grayboard caddy --no-pager
systemctl cat grayboard                      # ExecStart: the binary, or `bun run` (source install)?
sudo cat /etc/grayboard/env
ls -la /usr/local/bin/grayboard* /opt/grayboard /var/lib/grayboard
grayboard --version                          # the CLI is installed beside the server
```

An earlier install is fine to build on: step 2 overwrites the binaries, systemd unit and Caddyfile, and step 3 rewrites the env file. If `/var/lib/grayboard/bus.db` holds only test data, move it aside so you start clean: `sudo systemctl stop grayboard`, then `sudo mv /var/lib/grayboard/bus.db /var/lib/grayboard/bus.db.old` (and its `-wal` and `-shm` files, if present). A source checkout in `/opt/grayboard` can stay; once the unit points at the binary, nothing uses it.

## 2. Install the server

Install Caddy (Ubuntu doesn't ship it):

```bash
sudo apt install -y apt-transport-https curl gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Create the `grayboard` system user, then install the binaries (`grayboard-server`, the `grayboard` CLI for checks, and `grayboard-inspect`, the [read-only data viewer](#browsing-the-servers-data-admin)) and the release's deploy files: the systemd unit (`/etc/systemd/system/grayboard.service`), the Caddyfile (`/etc/caddy/Caddyfile`) and the backup script (`/usr/local/bin/grayboard-backup`). The deploy files are release assets listed in the same signed `SHA256SUMS` as the binaries, so the whole install rests on the release key:

```bash
id grayboard || sudo useradd -r -m -d /var/lib/grayboard grayboard
sudo mkdir -p /var/lib/grayboard /etc/grayboard
sudo chown grayboard:grayboard /var/lib/grayboard

curl -sSL https://github.com/nolnoch/grayboard/releases/latest/download/install.sh \
  | sudo GRAYBOARD_DEPLOY_REPLACE=1 INSTALL_SERVER=1 INSTALL_DIR=/usr/local/bin bash
```

`GRAYBOARD_DEPLOY_REPLACE=1` is for this first install only: Caddy's package ships its own `/etc/caddy/Caddyfile`, which the release's replaces (the old one is kept as `Caddyfile.prev`). Without it, the installer keeps any unit or Caddyfile that differs from the release's and says so, with the two checksums and a `diff` command. A symlinked unit (for example a masked one) is never replaced. Nor is a directory at a deploy file's path; the installer says so. On a host with `systemctl` but no running systemd (a container), a new or changed unit is written without a `daemon-reload`. Your own edits, such as the hostname in step 3 or a source-mode `ExecStart`, then survive every update. `GRAYBOARD_NO_DEPLOY=1` installs only the binaries; a host without `systemctl` installs only the binaries too.

**Check:** `grayboard --version` prints the release you expect, `ls -l /usr/local/bin/grayboard-server /usr/local/bin/grayboard-inspect /usr/local/bin/grayboard-backup /etc/systemd/system/grayboard.service /etc/caddy/Caddyfile` lists the files, and `caddy version` runs.

<details>
<summary>Alternative: run the server from a source checkout (for hacking on the server itself)</summary>

```bash
sudo mkdir -p /opt/grayboard
sudo git clone https://github.com/nolnoch/grayboard.git /opt/grayboard
sudo chown -R grayboard:grayboard /opt/grayboard
cd /opt/grayboard && sudo -u grayboard bun install
```

Then in `/etc/systemd/system/grayboard.service`, swap the `ExecStart` for the source-mode form (commented in `deploy/grayboard.service`):

```ini
WorkingDirectory=/opt/grayboard
ExecStart=/usr/local/bin/bun run src/server/main.ts
```

Everything else is identical.
</details>

## 3. Configure

**Create the server's Google OAuth client** (for Okta, see [Okta sign-in](#okta-sign-in) instead or as well). One client serves every sign-in: `grayboard login`, Claude Code's plugin, pi, omp and OpenCode all sign in through the server, which signs the person in with Google. In Google Cloud Console, open *Google Auth Platform* (APIs & Services → OAuth consent screen in older layouts):

1. **Audience.** *Internal* lets anyone in your Workspace sign in, but the Cloud project must belong to that Workspace organization. *External* works from any project; while it's in *Testing* status, only the users you list under *Test users* can sign in.
2. **Client.** Create an OAuth client of type **Web application** with this exact *Authorized redirect URI*: your public URL followed by `/oauth/google/callback`, such as `https://grayboard.example.com/oauth/google/callback`. If your public URL includes a path prefix, keep it: `https://grayboard.example.com/coordination` requires `https://grayboard.example.com/coordination/oauth/google/callback`. Scopes are `openid email profile`, which need no verification.
3. Copy the client ID and client secret. The secret goes only in the server's env file. It's sent in the server-side token exchange and never to clients.

**Point Caddy at your hostname, and write the env file** (mode `0600`; systemd reads it as root):

```bash
HOST=grayboard.example.com                   # your hostname
sudo sed -i "s/grayboard.example.com/$HOST/" /etc/caddy/Caddyfile
[ -f /etc/grayboard/env ] || sudo install -m 600 /dev/null /etc/grayboard/env
sudoedit /etc/grayboard/env
```

```
GRAYBOARD_DB_PATH=/var/lib/grayboard/bus.db
GRAYBOARD_HTTP_PORT=8080
GRAYBOARD_PUBLIC_URL=https://grayboard.example.com
GRAYBOARD_ORG_DOMAIN=<your Workspace domain>
GRAYBOARD_ADMINS=<your Workspace email>
GOOGLE_OAUTH_CLIENT_ID=<client id>.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=<client secret>
```

`GRAYBOARD_PUBLIC_URL` is `https://` plus the same hostname as the Caddyfile. Optionally, `GRAYBOARD_ATTACHMENT_MAX_BYTES` and `GRAYBOARD_ATTACHMENT_MAX_TOTAL_BYTES` set the attachment caps per file and per message or post, in bytes (default 10 MiB and 25 MiB, at most 100 MiB and 250 MiB); sessions learn them when they connect. `GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES` caps the attachment bytes each user stores on the server, sent and unsent (default 1 GiB, no less than the per-message cap). Attachment bytes live in `blobs/` beside the database unless `GRAYBOARD_BLOB_DIR` names another directory; back it up with the database ([Backups](#6-backups-optional)). They can live in an S3 bucket instead ([Attachments in S3](#attachments-in-s3)). `GRAYBOARD_ADMINS` is a comma-separated list of the emails that are always admins, allowed to run `grayboard admin` commands; they can make other people admins without a restart ([Admins and roles](#admins-and-roles)). With it unset and no admin granted, nobody can. Leave `GRAYBOARD_DEV_AUTH` unset: the server refuses it alongside any provider's client secret or with a non-loopback public URL, answers dev sign-in only from its own host, and a server started without it revokes every token `grayboard login --dev` minted, so none outlives a local trial. `GRAYBOARD_MESSAGE_RETENTION_DAYS` and `GRAYBOARD_AUDIT_RETENTION_DAYS` set the nightly pruning windows in days (default 90 each), and `GRAYBOARD_HTTP_PORT` the listen port (default 8080, 0 picks an ephemeral port); a value that isn't a whole number of days, or a port outside 0–65535, keeps the server from starting. `GRAYBOARD_HELLO_BURST` and `GRAYBOARD_HELLO_PER_SEC` bound how fast each user's hosted sessions may `bind` (default a burst of 60, refilling 1 per second); a bind over it is refused with the wait. Size the burst for all of one user's sessions binding at once after a server restart. The burst must be a whole number from 1 to 10000 and the rate a number of at least 0.1, or the server doesn't start. Hosted MCP requests are charged to a separate per-user bucket, `GRAYBOARD_HOSTED_REQUEST_BURST` and `GRAYBOARD_HOSTED_REQUEST_PER_SEC` (default a burst of 120, refilling 20 per second, same rules), so ordinary tool traffic can't starve binds. Delivery upkeep (the requests a plugin's subscriber connection makes to renew its lease, read the inbox and receipt items) has a per-user bucket of its own, `GRAYBOARD_HOSTED_SUBSCRIBER_BURST` and `GRAYBOARD_HOSTED_SUBSCRIBER_PER_SEC` (default a burst of 240, refilling 40 per second, same rules), so one user's delivery fan-out can't throttle that user's tool calls ([Sizing the caps](#sizing-the-caps)). `GRAYBOARD_DELEGATE_BURST` and `GRAYBOARD_DELEGATE_PER_SEC` bound how fast each user's sessions, together, may `delegate` (default a burst of 60, refilling 1 every 10 seconds, same rules), and `GRAYBOARD_DELEGATE_OPEN_CAP` how many requests a launcher may hold before it takes one (default 20, a whole number from 1 to 10000). `GRAYBOARD_ALIAS_SCOPE_CAP` is how many names one scope, a user's or a team's, may hold (default 500, a whole number from 1 to 1,000,000); a new name past it is refused, and a team owner frees one with `grayboard team delete-alias`. The OAuth sign-in routes have their own limits per client address, `GRAYBOARD_OAUTH_BURST`/`_PER_SEC` (default 60, 1 per second; an IPv6 /48 gets four times that across its addresses), and for the whole server, `GRAYBOARD_OAUTH_GLOBAL_BURST`/`_PER_SEC` (default 600, 10 per second); token refresh and revocation posts are limited per address only. `GRAYBOARD_MCP_POST_GLOBAL`/`_PER_USER`, `GRAYBOARD_MCP_LISTEN_GLOBAL`/`_PER_USER` and `GRAYBOARD_MCP_LEGACY_GLOBAL`/`_PER_USER` cap concurrent hosted MCP requests, open listener streams and older-protocol sessions, server-wide and per user (defaults in `src/server/config.ts`). `GRAYBOARD_HOSTED_SESSIONS_GLOBAL`/`_PER_USER`, `GRAYBOARD_DELIVERY_LEASES_GLOBAL`/`_PER_USER` and `GRAYBOARD_RESOURCE_WATCHES_GLOBAL`/`_PER_SESSION` cap hosted session rows, delivery leases and resource watches (the same file; see [Sizing the caps](#sizing-the-caps)). Each of these may be raised to 1,000,000, a guard against a typo, not a tested size. `GRAYBOARD_CLI_TOKEN_IDLE_DAYS` (default 30) is how many days a `grayboard login` token may go unused before the server refuses it and the CLI asks for a new sign-in; use keeps it alive however old it is, and 0 never expires one. It must be a whole number from 0 to 3650, or the server doesn't start. `GRAYBOARD_HOSTED_IDLE_SECONDS` (default 900) is how long an unbound hosted session, or a bound one that never opened delivery, may sit idle before the server retires it or lets a contender take its name. `GRAYBOARD_AUTH_FAIL_BURST` and `GRAYBOARD_AUTH_FAIL_PER_SEC` bound authentication failures per client address, with the same defaults and the same rules: each refused token and each sign-in costs the address one, and while its allowance is spent, every request from it is answered 429 with the wait, before the server looks anything up. A client signed in with a valid token never spends any, and a token refused once is answered the same way for a minute without spending more, so a client looping on a stale token spends one a minute, not the allowance of every client behind its address. The client address is the connecting peer, or, when that peer is a trusted proxy, the first address from the right in `X-Forwarded-For` that isn't one; IPv6 addresses count per /64, and each /64 also spends its /48, which gets four times the per-address limit (#274). A drained /48 refuses every request from every address under it, valid tokens included, until it refills: a /48 is often more than one customer (an ISP's /48 holds 256 customers' /56s), so a client with five or more /64s failing at once can lock out its /48 neighbours. That's the price of one prefix not being able to switch the limit off by filling its key cap. `GRAYBOARD_HEALTHZ_LAG_P99_MS` and `GRAYBOARD_HEALTHZ_LAG_WINDOWS` set when `/healthz` fails on event-loop lag ([Metrics](#metrics)). `GRAYBOARD_TRUSTED_PROXIES` lists the trusted proxies as comma-separated IPs or CIDRs (default loopback, which is Caddy on the same host; `none` trusts nobody); an entry that doesn't parse keeps the server from starting. With a load balancer in front of Caddy, list loopback and the balancer's addresses, and set Caddy's `trusted_proxies` to the balancer too, or every client shares the balancer's address.

**Postgres instead of a SQLite file.** Replace `GRAYBOARD_DB_PATH` with `GRAYBOARD_DATABASE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=verify-full&sslrootcert=<CA bundle path>` (both set keeps the server from starting), and set `GRAYBOARD_BLOB_DIR`, or keep attachments in S3 ([Attachments in S3](#attachments-in-s3)): a URL needs one of them because there's no database directory to put `blobs/` beside. The URL's user must be able to create tables in that database: the server applies its schema at startup, and a failed migration stops it before it listens. The URL's `sslmode` (or `ssl`/`tls`) and `sslrootcert` set TLS: use `verify-full` with a CA file (Verified TLS to Postgres, below); with none of them (and no `PGSSLMODE` in the server's environment, which Bun.SQL applies when the URL sets no `sslmode`) the connection isn't encrypted at all, and `prefer` falls back to plaintext without saying so. The startup line names the store as `store postgres <host>[:<port>]/<database>, <W> writers, <TLS mode>`, without the credentials; a URL that doesn't start with `postgres://` or `postgresql://` keeps the server from starting. A Postgres server starts empty: nothing copies an existing SQLite server's data into it, so everyone signs in again, and boards, DMs, claims, teams, granted roles, service principals and their credentials, aliases, Slack account links and the audit log start fresh. Run exactly one server process against a database, on Kubernetes one replica with `strategy: Recreate` (a rolling update starts the new pod before stopping the old one): writes go through one queue inside the process, and live delivery and name ownership are held in its memory, so a second process would lose deliveries and break both. Back it up with the database's own backups plus the attachments ([Backups](#6-backups-optional)).

**Secrets from files.** Each secret can come from a file instead: set `<NAME>_FILE` to its path, the convention for Docker and Kubernetes secrets mounted as files. That covers `GRAYBOARD_DATABASE_URL`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET`, `GRAYBOARD_OKTA_CLIENT_SECRET`, `GRAYBOARD_OIDC_CLIENT_SECRET`, `GRAYBOARD_GOOGLE_DIRECTORY_KEY`, `GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_SECRET`, `GRAYBOARD_OKTA_DIRECTORY_KEY`, `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN`. The server reads the file once at start and drops trailing line breaks. It refuses to start when `<NAME>` is also set to a different value, or when the file is empty or unreadable; the error names the variable and path, never the contents.

**Waiting for Postgres.** With `GRAYBOARD_DATABASE_URL`, the server waits for the database to answer before it migrates and listens, so a managed database that is resuming, failing over or still booting doesn't fail the start. It retries refused, timed-out and dropped connections, and a server that says it isn't taking connections yet, for `GRAYBOARD_DATABASE_CONNECT_SECONDS` (default 60, a whole number from 0 to 3600; 0 tries once), and logs each failed try. Each try may take 10 seconds to connect, so the start can fail up to 10 seconds past the deadline. A wrong password or a missing database fails the start at once. `GRAYBOARD_DATABASE_WRITERS` (default 8, a whole number from 1 to 64) is how many database connections the server keeps for writes, beside its pool of 10 for reads and one connection that listens for auth changes, so plan for W + 11 connections per server; the startup log's store line says how many, and size the database's `max_connections` to match. For a few hundred sessions on one server, run W = 16: the 300-session load gate passes at 16 and fails at the default 8 ([`docs/future/postgres-server.md`](../future/postgres-server.md) D8). A SQLite store ignores it.

**Verified TLS to Postgres.** TLS settings go in `GRAYBOARD_DATABASE_URL` itself. Without a CA file, `sslmode=require` encrypts the connection but never checks the database's certificate, so anything on the network path can pose as the database. Use `sslmode=verify-full` with `sslrootcert` naming a CA file: grayboard then refuses a database certificate that doesn't chain to that file or doesn't name the URL's host, and refuses a database that declines TLS. For Amazon RDS or Aurora instance and cluster endpoints, the CA file is Amazon's bundle, `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`. It isn't a secret, so ship it in the image or mount it from a ConfigMap. Connect to the endpoint hostname Amazon gives you, not an IP address or your own DNS alias, because the certificate names only the endpoint:

```
GRAYBOARD_DATABASE_URL=postgres://grayboard:<password>@mydb.abc123xyz.us-west-2.rds.amazonaws.com:5432/grayboard?sslmode=verify-full&sslrootcert=/etc/grayboard/rds-global-bundle.pem
```

A certificate from another CA, or one that doesn't name the host, fails the start at once with a TLS error; it isn't retried like an unreachable database. A missing or unreadable CA file also fails the start at once, with an error such as "Unable to access caFile path" that names neither the file nor `sslrootcert`, so check the path first. Without `sslrootcert`, `verify-full` checks against the system's trust store, which doesn't hold Amazon's RDS CAs.

### Attachments in S3

Set `GRAYBOARD_BLOB_S3_BUCKET` to keep attachment bytes in an S3 bucket instead of a directory, with either store; then no volume holds them, and the Postgres store needs no `GRAYBOARD_BLOB_DIR`. Setting both is refused. The region is `GRAYBOARD_BLOB_S3_REGION`, else `AWS_REGION`; with neither, the server doesn't start. `GRAYBOARD_BLOB_S3_PREFIX` puts every object under a key prefix (a `/` is added if it doesn't end in one), and `GRAYBOARD_BLOB_S3_ENDPOINT` points at an S3-compatible service instead of AWS. Each attachment is one object, `<prefix><first two hex digits>/<sha256>`.

Credentials come from the environment, in this order:

1. **The pod's IAM role** (EKS IAM roles for service accounts): when `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_ARN` are set, which EKS does for a service account annotated with `eks.amazonaws.com/role-arn`. The server exchanges the token for temporary keys with STS (`AssumeRoleWithWebIdentity`, at `sts.<AWS_REGION>.amazonaws.com` unless `AWS_ENDPOINT_URL_STS` says otherwise), re-reads the token file at each exchange because the kubelet rotates it, and refreshes the keys when an operation finds them within five minutes of expiry. A refresh that fails while the old keys are still valid keeps using them and logs once; after they expire, attachment uploads and downloads fail until STS answers. `AWS_ROLE_SESSION_NAME` names the session in CloudTrail (default `grayboard-` and a random suffix).
2. **Static keys:** `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with `AWS_SESSION_TOKEN` if they are temporary.

Half of either pair, or neither, keeps the server from starting, and so does `S3_SESSION_TOKEN`: Bun's S3 client would sign with it. At startup the server reads a key under the prefix (`grayboard-startup-check`, which needn't exist) and doesn't start if S3 or STS refuses, with an error that begins `startup failed: Error: attachment store s3://…` (only a failed database open begins `startup failed: opening <store>`, #1609); the startup log names the bucket, prefix and credential source, never a key.

Give the attachments a bucket of their own. The role needs this policy (stand-in names):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::example-bucket/grayboard/blobs/*" },
    { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::example-bucket" }
  ]
}
```

`s3:ListBucket` is not optional: without it, S3 answers a read of a missing object with 403 Access Denied instead of 404, so a swept attachment's download fails as a server error instead of "bytes are gone", and the startup check is refused. A startup refusal with `AccessDenied` on the `grayboard-startup-check` key most likely means `s3:ListBucket` is missing. It is unconditioned on purpose, which is why the bucket should be dedicated: it lets the role list every key in the bucket. Narrowing it with an `s3:prefix` condition is unverified: the check behind a missing object's 404 may not carry `s3:prefix`, so the condition can fail and turn every missing key, the startup check's among them, into 403.

The bucket is the attachments' durability: turn on versioning, with a noncurrent-version expiry, so a deleted or overwritten object can be recovered. `deploy/backup.sh` mirrors a blob directory only; with S3 it has nothing to copy for attachments. Run one replica: uploads and blob sweeps are serialized within one process, and two servers sharing a bucket could sweep bytes the other has just uploaded (#808).

### Admins and roles

Admins come from two places: the emails in `GRAYBOARD_ADMINS`, and people an admin grants the `org_admin` role at runtime. A grant or a revoke takes effect on the next request, with no restart:

```bash
grayboard admin role grant org_admin bob@example.com     # they must have signed in once
grayboard admin role revoke org_admin bob@example.com
grayboard admin role list                                # GRAYBOARD_ADMINS first, then every granted role
grayboard admin role grant team_owner bob@example.com --scope eng   # an owner of a team they're already in
```

`GRAYBOARD_ADMINS` is the way back in: its emails are admins whatever the granted roles say, and they can't be revoked with a command, only by removing the email and restarting. Revoking the last granted admin on a server with `GRAYBOARD_ADMINS` unset leaves nobody who can run admin commands; the command warns when that happens, and setting the variable and restarting fixes it. Team owners are the `team_owner` role, so `admin role list --role team_owner` lists every team's owners; owners still manage their teams with `grayboard team add --role owner|member`. The first start on a database from a release without roles turns each team's existing owners into `team_owner` roles, once; rolling back to such a release afterwards shows the owners as they were before the upgrade, so restore the pre-upgrade snapshot instead. Removing someone from a team, or their leaving it, revokes their ownership. Admin and ownership changes are audit rows (`role.granted`, `role.revoked`), and so is each use of an admin role.

For a lost or stolen device, revoke just that device's sign-ins: `grayboard grants list --user <email>` lists the person's harness sign-ins (by client, such as `grayboard-pi`, with when each was created and last used) and CLI tokens (`cli:<n>`, with their label), and `grayboard grants revoke <id> --user <email>` revokes one. Their other machines keep working; the device signs in again if it's found. The revoke also ends the person's browser sign-ins at the server, so their next harness or CLI sign-in on any machine goes through your identity provider again. If the device may still be signed in to your identity provider, end that session there too (or reset the person's password): otherwise its next sign-in goes straight through. `grayboard admin revoke-session` ends the browser sign-ins the same way. Anyone can do the same for their own sign-ins without `--user`. For someone leaving, `grayboard admin disable-user --email <e>` revokes everything at once; `grayboard admin enable-user --email <e>` lets the account sign in again. A service's credentials show in its list but are revoked with `grayboard admin service credential revoke`.

Disabling someone at your identity provider doesn't reach the server by itself unless the provider has a directory check: Google once you give it a directory key ([Google directory check](#google-directory-check)), a Keycloak realm signed in as `oidc` once you give it a checker client ([Keycloak directory check](#keycloak-directory-check)), or Okta once you give it an API service app ([Okta directory check](#okta-directory-check)). Otherwise grayboard asks the provider about a person only when they sign in. So every person signs in again through the provider every `GRAYBOARD_IDP_REAUTH_DAYS` (default 30; `0` turns it off). When that window runs out, their harnesses' next token refresh fails and the harness opens the sign-in page again, and `grayboard` CLI commands fail until they run `grayboard login`. Someone disabled at the provider can't complete that sign-in, so their access ends within the window even if nobody runs `disable-user`. This applies to Okta without a service app, to other `oidc` providers and Keycloak without a checker client, and to Google without a directory key; the start-up log names them with a line like `IdP re-auth: sign-in every 30 days (no directory check: oidc)`. Run `disable-user` as well when access must end now.

A service principal is a named, non-human account for a pipeline's agents. An admin creates one with at least one owner, a person who answers for it and must have signed in once:

```bash
grayboard admin service create ingest --owner alice@example.com --owner bob@example.com
grayboard admin service list
grayboard admin service disable ingest     # ends its sessions and revokes its grants
grayboard admin service enable ingest
grayboard admin service delete-alias ingest w-3   # a name none of its sessions holds
```

A service's name follows the team name rules and shares their namespace. Its agents bind names in its own scope (`ingest/w-1`) and nowhere else; no person, its owners included, can bind there. Owners are the `service_owner` role (`admin role list --role service_owner`); the last one can't be revoked. A service can't sign in, join a team or hold any role but `service_invoke` (below), and the person commands (`disable-user`, `revoke-session`, `unlink-idp`) refuse it. Disabling a person reports the services left with no enabled owner.

A service's agents sign in with a credential: an OAuth client ID and secret that the launcher (a CI step, a broker, an SDK process) holds and exchanges for a short-lived run token, with no browser. Add one as an admin; the secret is printed once, so put it straight into the launcher's secret store:

```bash
grayboard admin service credential add ingest                     # client_id, client_secret, secret_id
grayboard admin service credential add ingest --source opencode --token-seconds 7200 --expires-days 90
grayboard admin service credential add ingest --rotate svc_…     # a second secret for the same client
grayboard admin service credential revoke --secret 7             # retire the old secret and its tokens
grayboard admin service credential revoke svc_…                  # the whole credential: its sessions end now
```

The launcher mints a token per run with `POST /oauth/token` (`grant_type=client_credentials`, the client ID and secret as HTTP Basic auth) and hands only the token to the agent, which uses it as a bearer on `/mcp`. A token lasts the credential's `--token-seconds` (default an hour), never past `GRAYBOARD_SERVICE_TOKEN_MAX_SECONDS` (default 24 hours) or the credential's expiry; there is no refresh token, so the launcher mints a new one when it runs out. A launcher written in Rust can use the in-repo Rust SDK (`sdk/rust/grayboard`, not on crates.io), which mints and renews these tokens itself and gives typed tool calls and a delivery stream ([`docs/sdk-rust.md`](../sdk-rust.md)). `--source opencode` is for a credential whose sessions are OpenCode's; the default suits the SDK and other generic clients. Rotate without downtime: add a second secret, switch the launcher, then revoke the first secret; sessions continue. Revoking a credential, or disabling the service, ends its sessions at once; enabling the service revives no credential, so add a new one. Each change is an audit row (`service.credential_added`, `service.credential_revoked`, `oauth.token_issued`), none carrying the secret. A credential mints at most `GRAYBOARD_SERVICE_TOKEN_MINTS_PER_MINUTE` tokens a minute (default 60) and holds at most `GRAYBOARD_SERVICE_TOKENS_UNEXPIRED` live ones (default 1000); past either the token route answers `slow_down`, and keeps answering it from memory, without touching the database, for one mint interval (a second at the default rate); a burst of retries writes one audit row. To run OpenCode as the service, see [OpenCode V2 as a service](harnesses.md#opencode-v2-as-a-service-no-browser).

People and other services ask a service for work by posting on its board. A queue board the service's own agents create (`board_create` with `kind: "queue"`) is the service's: each post goes to exactly one of the service's subscribed agents, and their reply wakes the poster. Who may see and post on it is the `service_invoke` role, which an admin grants to a person, a team or another service:

```bash
grayboard admin role grant service_invoke bob@example.com --scope ingest
grayboard admin role grant service_invoke qa --scope ingest       # every member of team qa, as long as they're members
grayboard admin role revoke service_invoke bob@example.com --scope ingest
```

Anyone without the role, the service's owners and admins included, sees no such board and none of the service's names. An agent bound to a team's name (`qa/build`) counts as that team, so it needs the team's grant even when its person holds one. A grant to a team lets the team's owners extend it by adding members. Revoking the role, or removing someone from a holding team, refuses their next post; posts of theirs the service hasn't read yet arrive marked `ungranted`. Every post on a service's board, allowed or refused, is an audit row (`authz.decision`, verb `service.invoke`).

A granted role belongs to the account, not the email: `admin unlink-idp` hands it to the next account that signs in with that email, as it does their teams and names. Revoke a departing person's roles yourself.

### Okta sign-in

`GRAYBOARD_IDPS` lists the sign-in providers, comma-separated, in the order the sign-in page offers them: `google` (the default when it's unset), `okta`, [`oidc`](#other-oidc-sign-in), or several, such as `google,okta`. With one provider the browser goes straight to it; with several, the server first asks which to use. `GRAYBOARD_ORG_DOMAIN` and Google's client pair are needed only when `google` is listed.

In the Okta Admin Console, create an app integration with sign-in method *OIDC - OpenID Connect* and application type *Web Application*:

1. **Grant type** *Authorization Code*, client authentication *Client secret*, and *Require PKCE as additional verification* checked.
2. **Sign-in redirect URI**: exactly your public URL followed by `/oauth/okta/callback`, such as `https://grayboard.example.com/oauth/okta/callback`, keeping any path prefix as for Google. Okta compares it as an exact string. Sign-out redirects aren't used.
3. **Assignments**: the people, or groups, who should sign in.
4. Copy the client ID and client secret, and find the issuer: your org's authorization server, such as `https://example.okta.com` or a custom one like `https://example.okta.com/oauth2/default`, exactly as the `issuer` its `/.well-known/openid-configuration` gives (no trailing slash).

Add to the env file:

```
GRAYBOARD_IDPS=okta                          # or google,okta
GRAYBOARD_OKTA_ISSUER=https://example.okta.com
GRAYBOARD_OKTA_CLIENT_ID=<client id>
GRAYBOARD_OKTA_CLIENT_SECRET=<client secret>
GRAYBOARD_OKTA_ALLOWED_DOMAINS=example.com
```

`GRAYBOARD_OKTA_ALLOWED_DOMAINS` is the comma-separated list of email domains Okta may sign in. Okta vouches that a person is assigned to the app, not that the email in their profile is theirs to use here, so an address outside these domains is refused ("domain isn't allowed"). **Okta must assert that the email is verified** (`email_verified`): there's no override, so if your org's Okta doesn't mark its users' emails verified, every Okta sign-in is refused ("sign-in with the provider failed") until that's fixed in Okta. The server refuses to start with an Okta variable set while `okta` isn't listed, with one missing while it is, with an issuer that isn't plain `https://` (no query, fragment or trailing slash), or with a malformed domain. It contacts Okta only when someone signs in, so an Okta outage doesn't stop the server or Google sign-in.

If Google and Okta share an email domain, the first verified sign-in with an address holds it, and a person signs in to their account from one provider only. Keep each person on one provider, or give each provider its own domains. To move someone from Google to Okta, run `grayboard admin unlink-idp --email <e>`; their next Okta sign-in takes the account.

### Other OIDC sign-in

`oidc` in `GRAYBOARD_IDPS` signs people in through any other OpenID Connect provider (Keycloak, for one) that offers discovery and PKCE S256 and signs ID tokens with an asymmetric key. Register a client for the authorization code flow with PKCE (S256) required and the scopes `openid`, `email` and `profile`, and its redirect URI exactly your public URL followed by `/oauth/oidc/callback`. The client may be **confidential** (it has a secret, sent as HTTP Basic) or **public** (no secret: the provider trusts the code because only the server holds its PKCE verifier). A public client suits a platform whose identity provider issues no secrets to apps.

```
GRAYBOARD_IDPS=oidc                                       # or google,oidc
GRAYBOARD_OIDC_ISSUER=https://sso.example.com/realms/eng  # exactly as discovery's `issuer`
GRAYBOARD_OIDC_CLIENT_ID=<client id>
GRAYBOARD_OIDC_CLIENT_SECRET=<client secret>              # omit for a public client
GRAYBOARD_OIDC_ALLOWED_DOMAINS=example.com
GRAYBOARD_OIDC_LABEL=Example SSO                          # the sign-in page's link text; default "Single sign-on"
```

The rules are Okta's: the allowed domains, the verified email (**the provider must send `email_verified: true`**; users a realm brokers from another provider or imports often have it false until it's set), the start-up checks, and contact only at sign-in. `GRAYBOARD_OIDC_CLIENT_SECRET` set but empty refuses to start rather than make a public client. The `oidc` and `okta` issuers must differ, and `GRAYBOARD_DEV_AUTH=1` refuses to start beside any `GRAYBOARD_OIDC_ISSUER`, secret or not.

### Google directory check

With a directory key, the server asks Google's Admin SDK Directory API about each Google user every `GRAYBOARD_IDP_RECHECK_HOURS` (default 24), at their next harness token refresh or CLI command past that interval, instead of making them sign in again every `GRAYBOARD_IDP_REAUTH_DAYS`. Someone suspended or archived in Google Workspace is then disabled as `grayboard admin disable-user` would (audited `auth.idp_disabled`), without anyone running it. Someone deleted is not: Google answers a deleted user with "not found", but doesn't document that, and a wrong subject mapping or a proxy can answer the same, so the server treats it as a failed check rather than a disable (#1600). Once their last good answer is `GRAYBOARD_IDP_RECHECK_MAX_STALE_HOURS` old they're refused as "temporarily unavailable"; find them by `auth.idp_check_failed` rows with `error_class: google_user_not_found` and disable them with `grayboard admin disable-user`.

1. In the server's Cloud project, enable the **Admin SDK API**, create a **service account**, and create a JSON key for it.
2. Let it read users, one of two ways. Either, in the Google Admin console, assign the service account an admin role with the *Users → Read* privilege (Account → Admin roles); or give it domain-wide delegation for the scope `https://www.googleapis.com/auth/admin.directory.user.readonly` (Security → API controls → Domain-wide delegation) and set `GRAYBOARD_GOOGLE_DIRECTORY_ADMIN` to an admin's email for it to act as.
3. Put the key in the env file, or in a file named by `GRAYBOARD_GOOGLE_DIRECTORY_KEY_FILE`:

```
GRAYBOARD_GOOGLE_DIRECTORY_KEY=<the key file's JSON, on one line>
GRAYBOARD_GOOGLE_DIRECTORY_ADMIN=admin@example.com   # domain-wide delegation only
```

**Without a key.** Where your org forbids service account keys (the `iam.disableServiceAccountKeyCreation` policy), or you'd rather not store one, skip the key in step 1 and let the platform vouch for the server instead. Either way the service account still needs step 2, and the server calls the IAM Credentials API to act as it, so enable the **IAM Service Account Credentials API**; who needs **Service Account Token Creator** (`roles/iam.serviceAccountTokenCreator`) on the service account depends on the platform, below.

- **On GKE with Workload Identity**, bind the server pod's Kubernetes service account to the Google service account (the `iam.gke.io/gcp-service-account` annotation, and `roles/iam.workloadIdentityUser` for that Kubernetes service account on it), give the service account Token Creator on itself (the pod calls IAM Credentials as it), then name it instead of setting a key: `GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT=checker@your-project.iam.gserviceaccount.com`. The server asks the GKE metadata server for its token.
- **Elsewhere (EKS, a VM) with Workload Identity Federation**, create a workload identity pool with an OIDC provider that trusts your platform's tokens (on EKS, the cluster's OIDC issuer), grant the pool's principal for the server `roles/iam.workloadIdentityUser` and Token Creator on the service account, and generate a credential configuration with `gcloud iam workload-identity-pools create-cred-config … --service-account=checker@your-project.iam.gserviceaccount.com --credential-source-file=<the pod's projected token path>` (on EKS, a projected service account token whose audience the provider accepts). That file goes in `GRAYBOARD_GOOGLE_DIRECTORY_KEY` (or `…_KEY_FILE`) in place of the key; it holds no secret. Only file and URL credential sources with an OIDC token are supported, and the configuration must name the service account to impersonate.

`GRAYBOARD_GOOGLE_DIRECTORY_ADMIN` works the same with either. The server refuses to start with both `GRAYBOARD_GOOGLE_DIRECTORY_KEY` and `GRAYBOARD_GOOGLE_DIRECTORY_SERVICE_ACCOUNT` set, or on a credential configuration it couldn't use (a non-Google `token_url`, no service account to impersonate, an AWS or executable source). A refusal (400, 401 or 403, and 404 from the metadata server, IAM Credentials or a URL credential source, which name the service account or token) from any of them or STS is audited `google_token_refused`, with Google's error text in the log; a 5xx or malformed answer from any of them is `google_directory_error`.

The server refuses to start on a key that is neither a service account's nor an `external_account` configuration, on the admin without a key or service account, or on either with no `google` in `GRAYBOARD_IDPS`. The start-up line then reads `IdP re-auth: directory check every 24 h (google)`. A check Google doesn't answer (an outage, a refused key) is audited `auth.idp_check_failed`, with an `error_class` that names it (`google_token_refused`: fix the key, the role or the delegation), and lets the person keep working until their last good answer, or their last sign-in, is `GRAYBOARD_IDP_RECHECK_MAX_STALE_HOURS` old (default 72). After that, refreshes and CLI commands answer "temporarily unavailable" until Google answers again; nobody is signed out. Turning the key on doesn't restart anyone's clock, so with a key Google refuses, everyone who last signed in more than 72 hours ago is refused at once: after turning it on, watch the server log (Google's error text for a refused key is logged) and `auth.idp_check_failed` for the first checks, and if they fail, remove the key and restart, which puts everyone back on the sign-in clock. No user is disabled until Google has answered "active" for someone since the server started, so a key that can't see your users disables nobody. More than `GRAYBOARD_IDP_DISABLE_LIMIT` automatic disables in an hour (default 5) turn them off until a restart. Details: [server-offboarding.md](../server-offboarding.md) §3.

### Keycloak directory check

When `oidc` signs people in through a Keycloak realm, a second client in that realm lets the server ask Keycloak's admin REST API about each `oidc` user every `GRAYBOARD_IDP_RECHECK_HOURS` (default 24), at their next harness token refresh or CLI command past that interval, instead of making them sign in again every `GRAYBOARD_IDP_REAUTH_DAYS`. Someone disabled or deleted in the realm is then disabled as `grayboard admin disable-user` would (audited `auth.idp_disabled`), without anyone running it. Someone locked out by brute-force detection is not: that is an attack on the account, not an offboarding.

In the realm (written for Keycloak 26.8; older releases differ in step 4):

1. Create a client for the check alone, not the sign-in client: **Client authentication** on (confidential), **Service accounts roles** on, **Standard flow** and **Direct access grants** off.
2. On its **Service accounts roles** tab, assign the `realm-management` client role `view-users`.
3. Leave its **Full scope allowed** on (Client scopes → the client's dedicated scope → Scope), or, with it off, add `realm-management` `view-users` to that scope's mappings: otherwise the token doesn't carry the role.
4. On its **Client scopes** tab, add the client scope `kc-admin-api` as **Default**. Since 26.8 the admin API refuses a token without that scope's audience; Keycloak gives it only to its own admin clients.
5. Leave the sign-in client's `sub` alone: the check looks users up by the ID token's `sub`, which Keycloak sets to the user's id. A mapper that rewrites `sub` makes every lookup miss.
6. With brute-force detection's **permanent lockout** on, a locked-out user is shown as disabled; the server tells the two apart and treats any lockout, permanent or temporary, as a failed check. Someone disabled while locked out is disabled at grayboard once the lockout ends; until then they keep working only up to `GRAYBOARD_IDP_RECHECK_MAX_STALE_HOURS`.
7. Users federated from LDAP or Kerberos read as disabled whenever their user storage provider is switched off, so for them a disabled answer is a failed check too, never a disable. Offboard a federated user by deleting them (in the directory, with the provider's *Remove invalid users* on, or in Keycloak), which the check reads as gone. Likewise, a managed member of a disabled organization reads as disabled and is disabled at grayboard.

Then give the server the client's credentials:

```
GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_ID=<the checker client's id>
GRAYBOARD_KEYCLOAK_DIRECTORY_CLIENT_SECRET=<its secret>                 # or …_CLIENT_SECRET_FILE
GRAYBOARD_KEYCLOAK_DIRECTORY_URL=http://keycloak.auth.svc:8080          # optional; see below
```

The server reaches Keycloak at the issuer's base (`GRAYBOARD_OIDC_ISSUER` up to `/realms/`), both for the client's token and for `/admin/realms/<realm>/users/<id>`. A deployment that keeps `/admin` off its public hostname names an address the server can reach it at instead with `GRAYBOARD_KEYCLOAK_DIRECTORY_URL`, Keycloak's base without `/realms/`; plain `http` is allowed there, for an address inside the cluster, and carries the client secret, so keep it on a private network. The server refuses to start when one of the pair is set without the other, when `GRAYBOARD_IDPS` doesn't list `oidc`, or when `GRAYBOARD_OIDC_ISSUER` isn't a Keycloak realm URL. The start-up line then reads `IdP re-auth: directory check every 24 h (oidc)`.

The rest is as for Google: a check Keycloak doesn't answer is audited `auth.idp_check_failed`, with an `error_class` that names it (`keycloak_token_refused`: the client's id, secret or service account; `keycloak_directory_refused`: the `view-users` role, step 3, or the `kc-admin-api` scope; `keycloak_locked_out`: brute-force detection; `keycloak_federated_disabled`: step 7; `keycloak_directory_error`: anything else, an unreachable `GRAYBOARD_KEYCLOAK_DIRECTORY_URL` or a redirect among them), and Keycloak's error text for a refused client is logged. The person keeps working until `GRAYBOARD_IDP_RECHECK_MAX_STALE_HOURS`, then gets "temporarily unavailable"; nobody is disabled until Keycloak has answered "active" for someone since the server started; and turning the check on doesn't restart anyone's clock, so watch the first checks and remove the pair and restart if they fail. Details: [server-offboarding.md](../server-offboarding.md) §3.

### Okta directory check

With an API service app, the server asks Okta's Users API about each Okta user every `GRAYBOARD_IDP_RECHECK_HOURS` (default 24), at their next harness token refresh or CLI command past that interval, instead of making them sign in again every `GRAYBOARD_IDP_REAUTH_DAYS`. Someone suspended, deactivated or deleted in Okta is then disabled as `grayboard admin disable-user` would (audited `auth.idp_disabled`), without anyone running it. Someone locked out or with an expired password is not.

**Not yet tried against a live Okta org.** It follows Okta's documentation, but these points are unconfirmed; each would show up as a failed check (below), never as a wrong disable: whether a check works with *Require DPoP* turned off, whether Okta needs the key's id, which address Okta expects when your org has a custom domain, and whether Okta answers a deleted user with "not found".

In the Okta Admin Console (a super administrator does steps 1–4):

1. Create an app integration with sign-in method **API Services**. It's separate from the sign-in app.
2. Under its client credentials, set **Client authentication** to **Public key / Private key**, and add a key: **Generate new key** gives you an RSA private key as a JSON Web Key (copy it, Okta shows it once), or add your own key's public half and keep its private PEM. Leave **Require Demonstrating Proof of Possession (DPoP)** on.
3. On its **Okta API Scopes** tab, grant `okta.users.read`.
4. On its **Admin roles** tab, assign **Read-only Administrator**, for the whole org. Don't use a role scoped to groups: Okta may refuse a scoped role a suspended or deactivated user, and such users are then never caught (a refusal is a failed check, so nobody is wrongly disabled).
5. Leave the sign-in app's `sub` alone: the check looks users up by the ID token's `sub`, which Okta sets to the user's id.

Then give the server the app's client ID and private key:

```
GRAYBOARD_OKTA_DIRECTORY_CLIENT_ID=<the API service app's client id>
GRAYBOARD_OKTA_DIRECTORY_KEY=<the private JWK on one line, or a PEM>      # or …_KEY_FILE
GRAYBOARD_OKTA_DIRECTORY_KEY_ID=<the key's id>                             # PEM only; a JWK carries its kid
GRAYBOARD_OKTA_DIRECTORY_URL=https://example.okta.com                      # only if your issuer is on a custom domain
```

The server talks to your org at `GRAYBOARD_OKTA_ISSUER`'s address, whichever authorization server signs people in. If that issuer is on a custom domain, set `GRAYBOARD_OKTA_DIRECTORY_URL` to the org's okta.com address. Copy the key ID from the app's key list when you give a PEM. The server refuses to start when one of the pair is set without the other, when `GRAYBOARD_IDPS` doesn't list `okta`, when the key isn't an RSA (at least 2048 bits) or EC private key, or when the issuer isn't an Okta authorization server URL. The start-up line then reads `IdP re-auth: directory check every 24 h (okta)`.

The rest is as for Google: a check Okta doesn't answer is audited `auth.idp_check_failed`, with an `error_class` that names it (`okta_token_refused`: the app's client ID, key, scope grant or DPoP; `okta_directory_refused`: the admin role; `okta_status_unknown`: a user Okta shows as staged or provisioned, neither active nor offboarded; `okta_directory_error`: anything else), and Okta's error text for a refused app is logged. The person keeps working until `GRAYBOARD_IDP_RECHECK_MAX_STALE_HOURS`, then gets "temporarily unavailable"; nobody is disabled until Okta has answered "active" for someone since the server started; and turning the check on doesn't restart anyone's clock, so watch the first checks and remove the pair and restart if they fail. Details: [server-offboarding.md](../server-offboarding.md) §3.

## 4. Start and verify

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now grayboard
sudo systemctl restart caddy
journalctl -u grayboard -n 20 --no-pager     # "grayboard server <version> listening on port 8080"
curl -s localhost:8080/healthz               # {"ok":true,"version":"<version>"}
```

From your laptop:

```bash
curl -s https://grayboard.example.com/healthz                                    # {"ok":true,"version":"<version>"}
curl -s https://grayboard.example.com/.well-known/oauth-authorization-server     # {"issuer":"https://grayboard.example.com",…}
```

If the HTTPS check fails, `journalctl -u caddy -n 50 --no-pager` shows the certificate attempt. The usual causes are a hostname that doesn't resolve to this host yet, or port 80 closed.

## 5. Smoke test with sign-in

On your laptop:

```bash
curl -sSL https://github.com/nolnoch/grayboard/releases/latest/download/install.sh | GRAYBOARD_NO_SETUP=1 bash
grayboard login --server https://grayboard.example.com
grayboard whoami
```

`grayboard login` opens the browser to the server, which signs you in with your identity provider (asking which first, if you listed two) and asks you to authorize *Grayboard for the CLI*; it then writes `~/.grayboard/credentials` (mode `0600`). A `redirect_uri_mismatch` from Google means the client's redirect URI doesn't match the public URL ([Troubleshooting](troubleshooting.md)). Agents reach the server through [hosted MCP](#hosted-mcp-over-http), so the agent messaging trial comes after that. This one proves the server, sign-in and the CLI's HTTP routes:

```bash
grayboard team create trial
grayboard team list
```

**Check:** `whoami` shows your user and teams, and `team list` shows `trial`. The same checks from a second machine, or with a teammate's account, prove the rest; a teammate's identities appear as `them@example.com/<name>`. Claude Code's plugin uses the server's [hosted MCP](#hosted-mcp-over-http); once that's set up, [set up each developer](team.md#per-developer-setup-one-time).

Each user's first sign-in ties their grayboard account to that provider's account (its issuer and stable ID, not the email). A different account from the same provider presenting the same email later, such as a new hire given a departed person's address, is refused rather than inheriting the old account's names, mail and teams; so is a known account that now reports a different email, and so is an account from another provider presenting an email one provider's account holds. If the email should go to the new account (the person's account was recreated, they're moving to another provider, or you're deliberately handing the account on), run `grayboard admin unlink-idp --email <e>`; the next sign-in with that email, from any provider the server accepts, takes the account. When handing an account on, also run `grayboard admin revoke-session --email <e>`: the previous holder's CLI tokens and agent grants outlive the unlink. Upgrading marks every existing account as Google's, so an account from before the Google-account check links to the first Google account that signs in with its email, and a disabled account links to nobody. Rolling back to the previous release on the same database and upgrading again keeps these checks: an account you unlinked stays unlinked. Every link, refusal and unlink writes an audit row.

## Hosted MCP over HTTP

The release's `grayboard-server` serves the hosted endpoint, so a server the installer above set up has it: `curl <server url>/.well-known/oauth-protected-resource/mcp` answers with its metadata. To run your own build instead, `bun install` then `bun run build` on the target platform produces `dist/grayboard-server` and `dist/grayboard`; install those in the service's configured locations, or use the source-mode service described in [step 2](#2-install-the-server).

**Google.** The Web application client from [Configure](#3-configure) serves hosted MCP too. Set `GRAYBOARD_PUBLIC_URL` to your canonical HTTPS issuer, such as `https://grayboard.example.com`, and configure the reverse proxy to serve any path prefix it carries.

A server set up before CLI login moved onto the server may have a *Desktop app* client in `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET` and its Web application client in `GRAYBOARD_MCP_GOOGLE_CLIENT_ID`/`GRAYBOARD_MCP_GOOGLE_CLIENT_SECRET`. That keeps working: when the `GRAYBOARD_MCP_GOOGLE_*` pair is set the server signs everyone in with it and doesn't need the other pair, so you may delete the Desktop client and its two lines. Set both `GRAYBOARD_MCP_GOOGLE_*` values or neither.

Authorization, Google's token exchange, and ID-token audience validation all use the same pair. Grayboard checks Google's issuer, audience, Workspace domain, verified email, and flow nonce (and Okta's or the OIDC provider's issuer, audience, signature, verified email, allowed domain and nonce), then issues its own resource-bound tokens; clients never send the provider's tokens to `/mcp`.

**Native client registration.** This is separate from creating the Google Web application. OpenCode's URL-only profile uses its public client metadata document, `https://opencode.ai/oauth/opencode/client.json`; the server must advertise and support that client metadata flow and tools/delivery consent. The server fetches that document itself when OpenCode signs in, so it needs outbound HTTPS to the document's host; behind an egress firewall that blocks it, OpenCode's sign-in fails and the audit log records `oauth.cimd_failed`. No developer-supplied client ID, client secret or explicit scope block belongs in the default OpenCode configuration. pi's and omp's hosted extensions ([#279](https://github.com/nolnoch/grayboard/issues/279), [#280](https://github.com/nolnoch/grayboard/issues/280)) and Claude Code's plugin ([#281](https://github.com/nolnoch/grayboard/issues/281)) don't need an operator client either: every server already has their public clients built in (`grayboard-pi`, `grayboard-omp` and `grayboard-claude-code`, loopback callbacks only) with the full hosted surface, and `peer_list` shows their sessions as `pi`, `omp` and `claude-code`. They can't be turned off, and a `GRAYBOARD_OAUTH_CLIENTS` entry that reuses one of those IDs, or `grayboard-cli` (the client `grayboard login` signs in as), stops the server at startup until you rename it. Other native clients may sign in as operator-preregistered public clients through `GRAYBOARD_OAUTH_CLIENTS`. Such a client gets unbound reads only (it can list and read boards, claims and peers, but can't bind a name, write, register child sessions, transfer attachments or open delivery) unless you opt it in with `"sessionSource": true`. An opted-in client gets the full hosted surface over plain HTTP MCP, with nothing installed in the harness, by sending its own session ID in `_meta["io.github.nolnoch.grayboard/sessionID"]` on each MCP request; `peer_list` shows its sessions with its client ID as their harness. OpenCode keeps its own key, `_meta["ai.opencode/sessionID"]`, without an opt-in. Of the clients that sign in with a metadata-document URL, the server accepts only OpenCode's unless you set `GRAYBOARD_OAUTH_CIMD_CLIENTS`: `off` accepts none (OpenCode can't sign in), and a comma-separated list of exact `https://` document URLs accepts those (include OpenCode's to keep it). The server never fetches an unlisted URL, and an unlisted client's sign-in is refused with an `oauth.cimd_refused` audit row. A listed client other than OpenCode stays read-only. Earlier servers accepted any metadata-document URL: on upgrade, a client that relied on that stops signing in until you list it, and removing a client from the list stops its refresh at once, while its current access tokens run out within the hour. For example:

```json
[
  {
    "clientId": "native-agent",
    "name": "Native coding client",
    "redirectUris": ["http://127.0.0.1/callback"],
    "scopes": ["grayboard:tools", "grayboard:delivery"],
    "tokenEndpointAuthMethod": "none",
    "allowRefresh": true
  }
]
```

For the systemd env file, put that JSON on one line, enclosed in single quotes:

```text
GRAYBOARD_OAUTH_CLIENTS='[{"clientId":"native-agent","name":"Native coding client","redirectUris":["http://127.0.0.1/callback"],"scopes":["grayboard:tools","grayboard:delivery"],"tokenEndpointAuthMethod":"none","allowRefresh":true}]'
```

Give the client the public ID `native-agent` as its OAuth `client_id`, not the Google client ID or secret. The registration uses public-client authentication (`none`) and authorization code with PKCE S256; no client secret belongs on the developer's machine. The parser bounds the number of clients and redirects; unknown fields or invalid URLs stop server startup. `allowRefresh: true` explicitly allows the native client to receive and rotate refresh tokens.

`sessionSource: true` makes the client write-capable: anyone who signs in through it can bind names, send DMs and take delivery as themselves, so opt in only a client you trust to act for your users. It must be a boolean, and it's refused on a `clientId` that is an `https:` URL (a metadata-document ID, OpenCode's included), so a grant a user approved for a metadata-document client can never turn write-capable because you later register the same ID. It's also refused on a `clientId` longer than 64 characters, since `peer_list` shows the ID as the harness and keeps 64 characters of it. Startup logs the client IDs that have it. Removing it takes effect on restart: from then on the client can only read, and its access tokens keep read access until they expire. Its sessions that already hold a name keep it until their delivery lease ends, an idle check finds them gone, or another bind takes the name; to end them at once, run `grayboard admin revoke-session --email <e>` (which also revokes the user's OAuth grants) or `grayboard admin disable-user --email <e>`.

For manually registered clients, the literal `http://127.0.0.1/callback` registration allows its ephemeral port under RFC 8252. Only the port may vary: another host, path or query is not an alias. Register each client's own redirect URI and allowed scopes rather than assuming it uses this callback; OpenCode's default metadata-document path does not require this manual registration.

After editing the env file, run `sudo systemctl restart grayboard` and check `journalctl -u grayboard -n 20 --no-pager` for configuration errors. Check discovery without sending credentials:

```bash
curl -fsS https://grayboard.example.com/.well-known/oauth-authorization-server
curl -fsS https://grayboard.example.com/.well-known/oauth-protected-resource/mcp
```

For a public URL with a prefix, use `/.well-known/oauth-authorization-server/coordination` and `/.well-known/oauth-protected-resource/coordination/mcp` on the same origin. The returned issuer, resource, and authorization/token URLs must use your configured public URL, not an internal proxy address. The authorization-server metadata's `grayboard_builtin_clients` lists the built-in client IDs, and startup logs them (`grayboard server: built-in clients: …`): a server without them predates the built-in clients and needs [updating](#updating-the-server) before those adapters can sign in to it. Its `grayboard_cli_client` names the CLI's client: `grayboard login` refuses a server without it, which is too old for this CLI's sign-in, before opening a browser.

**Connect from OpenCode V2.** Configure only the remote HTTP MCP type and `https://grayboard.example.com/mcp` URL (or your prefixed public URL plus `/mcp`) as shown in [OpenCode V2](harnesses.md#opencode-v2-native-hosted-mcp-and-packaged-delivery). Start sign-in from `/mcps`, sign in with your Workspace account, and review Grayboard's consent screen before approving. Native OpenCode owns sign-in, token storage and refresh. Each session starts unbound, when it can only list and read boards, claims and peers, and explicitly binds its own mailbox; there is no fixed identity header or automatic name creation. A hosted session holds names as a CLI session does: `bind` adds one (own or team scope) and you send as the oldest, `unbind` releases one, and messages and claims stay with the name for its next holder. Human-approved receiving-root enrollment is separate. It does not need `grayboard login`, `~/.grayboard/credentials`, or a `grayboard mcp` stdio shim for this connection. Never put bearer tokens or secrets in URLs or command arguments.

The endpoint supports MCP `2026-07-28` and the `2025-11-25` / `2025-06-18` HTTP protocols. A client can use tools and read visible board resources without owning delivery. Resource reads and subscription hints do not mark messages delivered or prove an agent processed them. Binding holds the name independently of delivery. For push, its bound root attaches one delivery consumer with `delivery_open`; that consumer must durably admit an item into the host before sending a delivery receipt. A host that starts a turn for every item it admits (Claude Code) passes `context: false`: after the lease's first pull, the inbox then lists non-waking items (not `actionable`) only alongside a waking one, or as a full page with none waking (#854). `dm_ack` remains a separate acknowledgment that a DM has been handled. Digest and team privacy rules still apply; a hint stream is not an exactly-once delivery or replay log. See the [architecture](../server-hosted-mcp.md) and [adapter delivery rules](../adapters-hosted.md) for integration details.

**Files over HTTP.** Hosted clients POST raw bytes with an accurate `Content-Length` to your public URL plus `/mcp/attachments?filename=notes.txt` using the same OAuth grant with `grayboard:tools` and `X-Grayboard-Session: encodeURIComponent(rawCurrentSessionID)`. Downloads and deletes use `/mcp/attachments/<id>` with that same header. MCP calls carry the raw value under the client's session key (`_meta["ai.opencode/sessionID"]` for OpenCode, `_meta["io.github.nolnoch.grayboard/sessionID"]` for the built-in pi, omp and Claude Code clients and a client with `sessionSource`); raw byte routes require its canonical `encodeURIComponent` in the header because they have no MCP envelope. Both map the value the same way: the grant's client selects the key, while the request carries its value. This is routing context, not a mailbox or credential; a token holder can name a raw session under that client, on the same token trust boundary as tool metadata. The registered effective root determines authority; an optional `identity` query only asserts its bound name (403 on mismatch). A client must supply the header to transfer files: one that cannot send it transfers nothing (fail closed), even if OAuth and MCP tools work. Pass uploaded IDs as `attachment_ids` to `dm_send` or `board_post`, not local file paths; check downloaded bytes against the metadata's size and SHA-256 and the response's `Repr-Digest`. The server retains participant/team access checks, byte validation, size limits, and per-user quotas. The local/stdio path-based attachment tools are unchanged, and the session-token `/api/attachments` routes are gone (#475); see [Attachments](reference.md#attachments) for file types and limits.

**OpenCode files.** The V2 package adds local file paths to native `dm_send` and `board_post` through `attachments: ["notes.txt"]` and registers `attachment_get(id, dir?)` to save received files and return their local path. Both direct tools and Code Mode use the host's current native grant and the calling session's context. Relative paths resolve from the OpenCode working directory; explicit save directories must already exist under that directory or `BUS_ATTACH_ROOTS`. The default save location is this bus's folder under `GRAYBOARD_ATTACHMENTS_DIR` (normally `~/.grayboard/attachments`). Shared file checks enforce the server's published size caps, restrict unsafe paths and secret files, and verify downloaded bytes against the server's SHA-256. Already-uploaded `attachment_ids` remain supported; don't combine them with paths in one call. Native prompt URLs and `webfetch` are not authenticated Grayboard transfer paths.

### Sizing the caps

Every hosted cap is per process and bounds memory, not traffic. The defaults suit a few dozen agents; raise them before more sessions than that connect, or the excess are refused with a capacity error rather than queued. One native session that holds delivery costs one hosted session row (plus one per active subagent), one delivery lease, one listener stream, and one resource watch per board it subscribes to. Its listener stream is an HTTP POST that stays open, so it also holds one request slot (`GRAYBOARD_MCP_POST_GLOBAL`/`_PER_USER`) for as long as it's connected. So at 1,000 such sessions the lease cap (default 256), the listener cap (`GRAYBOARD_MCP_LISTEN_GLOBAL`, default 128), the request cap (default 256) and the watch cap (default 1024) bind first; the session-row cap (default 4096) has room. Size each global cap at your peak concurrent sessions times its cost per session, with headroom. Set the request caps, global and per user, to at least the matching listener cap plus the tool calls you expect in flight at once: a request cap at or below the listener cap lets open listeners take every slot, and then every tool call on the server is refused. A request over a request cap gets a 429 carrying `rate_limited` and a wait of 0.5 to 1.5 seconds, which the hosted adapters retry up to eight times, so a reconnect burst a little over the cap slows connects rather than failing them; a cap that stays full for longer fails the connect as an outage, which the adapter's status reports as `server_busy` ("Server at capacity") rather than `server_unreachable`, and keeps retrying with backoff; a delivery loop's reconnect waits no less than the server's retry hint (#1536, #1553). Leave the other per-user caps unless one person runs more sessions, or subagents, than they allow.

The two per-user request buckets are rates, not memory caps. Size the subscriber bucket's rate at about S × (0.2 + r × c × f) requests per second per user, where S is that user's sessions that hold delivery, r is deliveries per session per second, c is requests per delivery and f is fan-out (1 for a DM, the board's other subscribers for a post). The 0.2 is the idle floor: a renew and an inbox read every 10 s. c is 3 for a client from the first release after v2.4.2 (#865) and 4 for an older one. The defaults (40 per second, a burst of 240) cover the default 32 leases per user at a quarter of a delivery per second each at c = 4. Set the burst to at least S × (c + 1), so all of a user's sessions can take one delivery at once, as when a post reaches a board they all subscribe to. Tool calls draw only on `GRAYBOARD_HOSTED_REQUEST_*`: size it at S times the tool calls per second one agent makes. A refusal run is audited `hosted.rate_limited`, with `bucket` naming the bucket (`native` for tool calls, `subscriber` for delivery upkeep), and a rising count of them for one user is the signal to raise that bucket.

A service's sessions, leases and request buckets have their own caps, so one busy pipeline can't use up its owners' or anyone else's: `GRAYBOARD_HOSTED_SESSIONS_PER_SERVICE` (default 1024) and `GRAYBOARD_DELIVERY_LEASES_PER_SERVICE` (default 64), each held under its global cap, and the `GRAYBOARD_HOSTED_REQUEST_SERVICE_*`, `GRAYBOARD_HOSTED_SUBSCRIBER_SERVICE_*` and `GRAYBOARD_HELLO_SERVICE_*` buckets (`_BURST`, `_PER_SEC`). Size a service's as you would a user's, with S its concurrent agents.

Open file descriptors need no tuning: Bun raises its own soft limit to the hard limit, which systemd's default already sets high. Values above the defaults are not load-tested yet; watch memory after raising a cap.

### Metrics

Set `GRAYBOARD_METRICS_ADDR` to serve Prometheus metrics at `/metrics` on a listener of its own. A bare port (`9464`) binds 127.0.0.1; `host:port` or `[v6]:port` binds that address. Unset, there's no listener, and the startup log says `metrics off`. The listener has no authentication, so the bind address is the only access control (why: [`docs/server-deploy.md`](../server-deploy.md)). Keep it on loopback, or on a private interface your scraper reaches, and don't proxy it.

```bash
curl -s localhost:9464/metrics | grep capacity_refusals   # refusals per cap, since start
```

The series cover admissions held per request cap, open leases, watches and board observers, capacity refusals by cap, native tool-call latency by tool, the write queue's wait and hold time by calling site with its depth, event-loop lag, and resident memory. A rising refusal count for one cap is the signal to raise that cap. A write-queue hold sum that grows nearly as fast as wall time (`rate(grayboard_write_queue_hold_seconds_sum[1m])` near 1) means the server's writes are saturated: on Postgres that is the database's round-trip time times the statements per write (`grayboard_write_queue_statements` and `_round_trips`, per body by calling site), not the server's CPU. Then clients time out while their requests wait: a request whose client aborts before its write starts logs `hosted MCP client aborted` with `category` `client_aborted` (not `hosted MCP failed`); one whose write already started finishes and logs nothing. A request the server cut logs `hosted MCP request cut by server` (`category` `server_cut`) instead: a shutdown's cut, or, with `cut` `deadline`, one still unanswered 70 s after its last bytes arrived, which the server ends itself (answered 503) before the listener's 75 s idle timeout would; a run of those lines is a write-queue stall, not a shutdown. And `grayboard_write_queue_skipped_bodies_total` counts the queued writes the server dropped unrun because their connection had gone: a client's timeout, a shutdown's cut or a request deadline. The names and help text are in `src/server/metrics.ts` and `src/server/app.ts`; every counter and gauge is per process.

`/healthz` also fails on sustained event-loop lag, so a load balancer or a monitor can pull a server that has stopped keeping up. The server measures the event loop in 10-second windows; when each of the last `GRAYBOARD_HEALTHZ_LAG_WINDOWS` windows (default 3, at most 60) has a p99 delay over `GRAYBOARD_HEALTHZ_LAG_P99_MS` (default 1000, at most 600000; 0 turns the check off), `/healthz` answers 503 with `{"ok":false,"version":…,"code":"lagging","message":"event loop lagging"}`. It also answers 503 when no window has finished for that many windows' time plus a tenth of a window (31 seconds at the defaults): under CPU saturation with many connections ready at once, Bun's socket loop can answer requests for tens of seconds without running a timer, so no window finishes until the stall ends while `/healthz` is still answered. `grayboard_event_loop_lag_window_age_seconds` on the scrape (`GRAYBOARD_METRICS_ADDR`) shows how long it's been since the last window finished. The route is public, so the `/healthz` body carries neither the window p99s nor that age; they go to the journal. It recovers as soon as one window comes in under the threshold, or, for a stall, as soon as a window finishes. One slow window never fails it, and a server that has just started has too few windows to fail on p99 (a stall of 31 seconds fails it however new it is), so at the default of 3 windows the installer's restart check isn't affected (with 1 window, a slow first 10 seconds can fail it). The check is evaluated when something asks: the journal gets one line, with the p99s or the stall's length, when a request to `/healthz` first sees it failing, and one when a request sees it recovered, so with nothing probing, a stall logs nothing. This works with or without `GRAYBOARD_METRICS_ADDR`. A 503 with `"code":"internal"` instead means the database didn't answer. `scripts/deploy_check.sh` prints the body either way.

## 6. Backups (optional)

On a SQLite server, `deploy/backup.sh` copies a consistent SQLite snapshot to S3 nightly, then mirrors the attachment blob directory (`GRAYBOARD_BLOB_DIR`, else `blobs/` beside the database) to `grayboard/blobs/` in the bucket. Attachments kept in S3 ([Attachments in S3](#attachments-in-s3)) are not copied: their bucket's versioning is their backup. It needs the `sqlite3` package, the AWS CLI, and credentials that can list, write and delete in the bucket (on EC2, an instance profile with `s3:ListBucket`, `s3:PutObject` and `s3:DeleteObject`). Set an S3 lifecycle rule for retention, and turn on bucket versioning with a noncurrent-version expiry matching it. Why the blob mirror and versioning are needed: [`docs/server-deploy.md`](../server-deploy.md).

```bash
echo "0 3 * * * grayboard S3_BUCKET=<bucket> /usr/local/bin/grayboard-backup" | sudo tee /etc/cron.d/grayboard-backup
```

On a Postgres server, the database's own backups replace `backup.sh` (on RDS, automated backups with point-in-time recovery). They don't hold attachment bytes, so back up `GRAYBOARD_BLOB_DIR` as well, for example with snapshots of its volume. To restore, pick a blob snapshot and restore the database to a time just before it was taken, keeping the gap as small as the backups allow: the server deletes an attachment's bytes as soon as nothing names it, so an attachment the restored database names but whose bytes were released and swept in the gap comes back without bytes. With attachments in S3, the bucket's versioning covers them instead: set the noncurrent-version expiry at least as long as the oldest database backup you might restore (the point-in-time window, or longer for kept snapshots), and after restoring the database to time T, remove the delete markers the server's sweeps placed after T, so the objects its attachments name are current again.

## Browsing the server's data (admin)

The read-only web view from [Boards and claims](local.md#boards-and-claims), `scripts/inspect.ts`, also reads the server's database. There it adds users (with their sessions, teams and last activity), teams and their members, and the audit log. The server install puts it at `/usr/local/bin/grayboard-inspect` and every update replaces it with the server, so it always reads the schema the running server writes. It listens on the host's loopback only, so you reach it through an SSH tunnel and nothing new is exposed:

```bash
ssh -t -L 4777:127.0.0.1:4777 <host> 'sudo -u grayboard grayboard-inspect --db /var/lib/grayboard/bus.db'
```

Then open http://127.0.0.1:4777; Ctrl-C closes both the viewer and the tunnel. It runs as `grayboard` because the database and its WAL files belong to the service user. It shows every DM and every team board, including teams you aren't in. It reads a backup snapshot the same way, if you'd rather browse a copy. It reads SQLite only: on a Postgres server, use `psql`.

## Reclaiming disk space

This section is for a SQLite server. The nightly retention run returns the pages it freed to the filesystem, up to 16,384 pages (64 MiB at the default 4 KiB page) per night, so a large backlog drains over several nights. That needs `auto_vacuum=INCREMENTAL`, which a database gets only when it's created (v2.0.0 and later; #170). An older database file keeps `auto_vacuum=NONE` and never shrinks: the server logs `free pages it can't reclaim` after each retention run while it has any. Convert it once, with the service stopped, a snapshot taken (§6) and free disk space for a second copy of the database:

```bash
sudo systemctl stop grayboard
sudo -u grayboard sqlite3 /var/lib/grayboard/bus.db 'PRAGMA auto_vacuum = INCREMENTAL; VACUUM;'
sudo systemctl start grayboard
```

## Updating the server

```bash
curl -sSL https://github.com/nolnoch/grayboard/releases/latest/download/install.sh \
  | sudo INSTALL_SERVER=1 INSTALL_DIR=/usr/local/bin bash
scripts/deploy_check.sh https://grayboard.example.com vX.Y.Z   # from a checkout, anywhere
```

The installer prints the release it installs, restarts the `grayboard` service, and waits up to 30 seconds for `/healthz` on the local port to report that release. If it doesn't, the installer exits 1 with the version it saw and prints the `journalctl` command and a one-line rollback to the binary it replaced (kept as `grayboard-server.prev`). A stopped unit isn't started, and a unit whose `ExecStart` is a different binary than the one installed isn't restarted. To pin a release, add `GRAYBOARD_VERSION=vX.Y.Z` after `sudo`. A release from before signed checksums (v1.x) has no `SHA256SUMS`, so this `install.sh` refuses it; to pin one, run that release's own `install.sh` (`https://github.com/nolnoch/grayboard/releases/download/v1.x.y/install.sh`). Hosted clients resume on their own after the restart, which drops them for a few seconds. The first start of a server upgraded from 2.2 or earlier ends every session the removed WebSocket transport left unended: each is audited `id.ended` (`why: "wss_removed"`) with a `released` event per alias it held, and unread mail to its ID bounces to the senders. An upgrade from a 1.x release has none to end. `scripts/deploy_check.sh` repeats the check from outside the host, through Caddy: it exits 1 unless `/healthz` answers ok with the release you name. From an address the server is rate-limiting after repeated authentication failures, every request gets 429, `/healthz` included; the check says so, and passes from another address or after the wait. Stopping or restarting the server waits up to 10 seconds for requests in flight and background passes already running (an access re-check, the nightly retention, a claim expiry sweep, and the wakes, board-change fan-out and blob sweeps they or a request's commit set off) before it closes the database; any that outlast that are logged, a request by method and path and a pass by name, and the server exits 1, which systemd records as a failed stop.

The installer also refreshes the release's deploy files (see the install step above): `grayboard-backup` is replaced, and a unit or Caddyfile you have edited is kept, with a line saying so. Add `GRAYBOARD_DEPLOY_REPLACE=1` after `sudo` to take the release's copy instead (the old one is kept as `<file>.prev`, or `<file>.prev.<UTC time>` if a `.prev` is already there). On an update that swaps your Caddyfile's real hostname for the placeholder and reloads nothing: redo the hostname edit, then `sudo systemctl reload caddy`. The installer stages and backs up every file before it replaces any; if `systemctl daemon-reload` fails, it exits 1 with the binaries still the old release.

Update the server first, then have every developer run `grayboard update`. A `grayboard login` refuses a server too old for its sign-in, before opening a browser, and an older CLI may not work against a newer server: a 2.4.x `grayboard login` can't sign in to a 3.x server, whose sign-in moved onto its OAuth, and a 2.4.x `grayboard claim` is refused with `bad_request`. Credentials an older CLI already holds keep working until they expire. A script that posts to `/api/claims/call` sends `as`, not `identity`. Read the release notes' breaking changes before a major upgrade. Two that need an admin's action on a 2.x server: first, a server whose `GOOGLE_OAUTH_CLIENT_*` pair is a *Desktop app* client and that has no `GRAYBOARD_MCP_GOOGLE_*` pair needs a Web application client before anyone can sign in ([Hosted MCP over HTTP](#hosted-mcp-over-http)). Second, another user's DM or push (a mention, a thread reply, a push-mode subscription) wakes an agent only when the two users share a team whose policy is `collaborative` or `delegating`; otherwise it waits as mail for the agent's next turn. Teams start `open`, so teammates who relied on waking each other's agents lose that until an owner or admin runs `grayboard team policy <team> collaborative` (`delegating` also lets members `delegate` to each other's launchers; [Teams and boards](team.md#teams-and-boards)).

## Container image

Each release also publishes the server as an image, `ghcr.io/nolnoch/grayboard-server:vX.Y.Z` (linux/amd64 and linux/arm64), for a container platform in place of the host install above. It holds the release's own `grayboard-server` binary, checked against the signed `SHA256SUMS` before it goes in, on a distroless base that runs it as uid 65532 (numeric, so `runAsNonRoot: true` accepts it). Each image is attested before its tag is published. There is no `latest` tag: pin a version. Check one with `gh attestation verify oci://ghcr.io/nolnoch/grayboard-server:vX.Y.Z -R nolnoch/grayboard`.

Configure it with the same environment as [3. Configure](#3-configure); mount secrets as files and point `<NAME>_FILE` at them. It listens on 8080 and has no Caddy: terminate TLS in front of it (an ingress or load balancer), add that proxy's addresses to `GRAYBOARD_TRUSTED_PROXIES`, and probe `/healthz`. `GRAYBOARD_DB_PATH` and `GRAYBOARD_BLOB_DIR` need a writable volume that outlives the container (attachments in S3 need none, [Attachments in S3](#attachments-in-s3)): the image doesn't stop the server writing to its own home or `/tmp`, where data is lost on restart, so set `readOnlyRootFilesystem: true` and drop every capability in the pod's security context. Run one replica, on Kubernetes with `strategy: Recreate`: the server is one process that owns its store.

## Limitations and non-goals (distributed mode)

- Single backend instance, on SQLite or Postgres alike (see [Postgres](#3-configure)). A restart drops clients for a few seconds; they reconnect and re-drain. Hosted delivery leases and idle-ownership timers don't count a longer outage: on start the server pushes a live lease out by the time it was down (at most one lease TTL past the restart) and an idle timer by the same amount (at most to the restart) (#423). An OpenCode V2 host that restarts while the server is down retries each saved root on its outage backoff instead of pausing it until a reload (#424); hosted pi, omp and Claude Code retry their root's resume the same way (#895).
- No HA, no multi-AZ, no horizontal scaling.
- No web admin UI — CLI only.
- No quotas on messages or posts. What is limited: the rate of each user's binds, hosted requests and delegations (a service's binds and requests have buckets of their own), the names each user or team holds, authentication failures per client address ([§3](#3-configure)), and each user's attachments: bytes uploaded but unsent, and bytes stored in all (`GRAYBOARD_ATTACHMENT_USER_QUOTA_BYTES`).
- No defense against intra-company abuse — treated as an acceptable-use matter.
- CLI tokens expire after `GRAYBOARD_CLI_TOKEN_IDLE_DAYS` of disuse (default 30), and both CLI tokens and harness sign-ins stop working `GRAYBOARD_IDP_REAUTH_DAYS` after the person last signed in through the identity provider (default 30, [Admins and roles](#admins-and-roles)), unless the provider has a directory check ([Google](#google-directory-check), [Keycloak](#keycloak-directory-check), [Okta](#okta-directory-check)), each refusal audited `auth.reauth_required` with the person as target (at most one row per person and credential kind an hour); otherwise rotation is logout, `grayboard grants revoke`, or admin revocation. Hosted OAuth access tokens last an hour, refresh tokens 30 days of disuse, and a grant at most 90 days; native clients refresh and reauthorize on their own.

Both stores sit behind the repository facade in `src/server/db.ts`; see [`docs/architecture.md`](../architecture.md).
