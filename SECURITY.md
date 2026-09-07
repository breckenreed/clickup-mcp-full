# Security

## Reporting

Report a vulnerability through GitHub's private advisory form:
<https://github.com/breckenreed/clickup-mcp-full/security/advisories/new>, or by
opening an issue if the problem is not sensitive. Please do not post working
exploit detail in a public issue.

## What this server handles

`CLICKUP_API_KEY` is a ClickUp *personal* token. It has no scopes: it acts as
the user who created it, with that user's permissions across the whole
workspace. Treat it as a password, keep it in your MCP client's configuration
rather than in a checked-in file, and create it under a view-only ClickUp
account if the agent should not be able to write.

`CLICKUP_TEAM_ID` is not secret.

## Where the credential can go

- The token is sent only to `https://api.clickup.com`. Requests are constructed
  as `URL` objects and the origin is compared to that constant *before* the
  `Authorization` header is attached; anything else throws
  (`src/index.mjs`, `clickupGet`).
- The native tools (`get_task_tree`, `get_task_activity`) issue `GET` only. The
  method is hardcoded in the one helper they share.
- The child process (`@twofeetup/clickup-mcp`) is resolved from this package's
  own dependency. `CLICKUP_MCP_ENTRY` is honoured only when it resolves inside
  that installed package, so it cannot be used to hand the token to arbitrary
  code.
- The child receives an allowlisted environment — the ClickUp variables, the
  tool selection, `REQUEST_SPACING`, `LOG_LEVEL`, `DOCUMENT_*`, and the
  platform variables Node needs — not the full environment of the editor that
  launched the server. `NODE_OPTIONS` is excluded on purpose.
- The token is never written to stdout, stderr, or a tool result. Errors log a
  status code and path.

## Network and transport

The server speaks JSON-RPC over stdio and opens no listening socket:
`ENABLE_SSE=false` and `ENABLE_STDIO=true` are set for the child regardless of
the inherited environment. JSON-RPC batches are refused rather than forwarded.

## Tool surface

Nine upstream tools are exposed by default. Upstream's `attach_file_to_task` is
off unless you enable it explicitly: it uploads a local file into ClickUp,
which turns any prompt injection an agent reads into a data-egress path.

The write tools that *are* enabled (`manage_task`, `manage_container`,
`operate_tags`, `task_comments`, `task_time_tracking`) act with the token's full
permissions. An agent reading task descriptions is reading untrusted text; run
it with per-action confirmation, a view-only token, or a reduced `ENABLED_TOOLS`
list if that matters for your workspace.

## Supported versions

Fixes land on `main` and are released from it. There are no maintained release
branches.
