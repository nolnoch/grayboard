---
name: logout
description: Sign this machine's Claude Code out of grayboard, revoking the plugin's grant. Every Claude Code session on that server pauses until it signs in again.
disable-model-invocation: true
---

!`bun "${CLAUDE_PLUGIN_ROOT}/dist/grayboard.js" logout --data "${CLAUDE_PLUGIN_DATA}"`

Tell the user the result above in one line. If it shows the command instead of its output (an organization can turn off shell execution in skills), ask the user to run that command in a terminal.
