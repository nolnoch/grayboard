#!/bin/sh
# A grayboard that stops reading while it still runs: `tools` runs the command
# it's given; anything else answers the adapter's initialize (id 1), closes
# stdin, and lingers, so the adapter's next write (notifications/initialized)
# fails with EPIPE.
for a in "$@"; do [ "$a" = tools ] && exec "$@"; done
# OpenCode's Bun host needs a large tool write to surface EPIPE. Serve its
# complete handshake first; ignoring SIGTERM keeps the old owner alive until
# the adapter's force-kill deadline, so an unawaited stop visibly overlaps.
if [ "$BUS_TEST_OPENCODE_STDIO" = epipe ] || [ "$BUS_TEST_OPENCODE_STDIO" = channel ]; then
  tools=$("$1" "$2" tools --mode local) || exit 1
  read -r _
  printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"stub","version":"0"}}}\n'
  read -r _
  read -r _
  printf '{"jsonrpc":"2.0","id":2,"result":{"tools":%s}}\n' "$tools"
  read -r association
  "$1" -e 'const r = JSON.parse(process.argv[1]); console.log(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: { id: "id:stdio-fixture", session: r.params.session, epoch: r.params.epoch, instructions: [] } }));' "$association" || exit 1
  read -r ready
  reply=$("$1" -e 'const r = JSON.parse(process.argv[1]); console.log(JSON.stringify({ jsonrpc: "2.0", id: r.id, result: {} }));' "$ready") || exit 1
  if [ "$BUS_TEST_OPENCODE_STDIO" = epipe ]; then
    trap '' TERM
    exec 0<&-
    printf '%s\n' "$reply"
    exec sleep 15
  fi
  printf '%s\n' "$reply"
  read -r _
  printf '{"jsonrpc":"2.0","method":"notifications/claude/channel","params":{"content":"buffered before exit","meta":{"kind":"direct"}}}\n'
  exit 0
fi
read -r _
exec 0<&-
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"stub","version":"0"}}}\n'
exec sleep 15
