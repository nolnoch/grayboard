#!/bin/sh
# A grayboard that stops reading while it still runs: `tools` runs the command
# it's given; anything else answers the adapter's initialize (id 1), closes
# stdin, and lingers, so the adapter's next write (notifications/initialized)
# fails with EPIPE.
for a in "$@"; do [ "$a" = tools ] && exec "$@"; done
read -r _
exec 0<&-
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"stub","version":"0"}}}\n'
exec sleep 15
