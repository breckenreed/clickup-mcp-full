# clickup-mcp-full

A ClickUp MCP server that can read a whole nested subtask tree in **one call**.

It wraps [`@twofeetup/clickup-mcp`](https://www.npmjs.com/package/@twofeetup/clickup-mcp)
rather than forking it, so upstream fixes arrive with a dependency bump. On top
of that server it adds `get_task_tree`, rewrites one tool description that
reliably misleads smaller models, and pins a sensible default tool set.

## Why

Upstream's only route to subtasks is `search_tasks` with `include_subtasks`,
which calls `GET /task/{id}?subtasks=true` and returns **full task objects for
the direct children only**. On a task with fifty subtasks nested several levels
deep that is both incomplete and ruinous for an agent's context window. The
alternative, one request per node, is worse.

`get_task_tree` walks the containing list once instead. ClickUp's
`GET /list/{id}/task?subtasks=true` returns every task in the list along with
its `parent` pointer, so the tree is reassembled locally: two requests total
regardless of depth or width, and the output is one compact line per task.

```
Task tree for 86capt3b: 23 task(s) including the root.
Statuses: in progress: 3, open: 14, complete: 6
List: Q3 Delivery

86capt3b  [in progress]  Migrate billing service  <ivan>
  86captk1  [complete]  Audit current schema  <olena>
  86captk2  [in progress]  Write migration scripts  <ivan>
    86captm7  [open]  Handle partial refunds
    86captm8  [open]  Backfill historical rows
  86captk3  [open]  Cutover plan
```

## Install

Nothing to clone or build. Point your agent at the package and it is fetched on
first launch.

**Claude Code**

```bash
claude mcp add clickup_full_local \
  --env CLICKUP_API_KEY=pk_your_token \
  --env CLICKUP_TEAM_ID=9012345678 \
  -- npx -y github:breckenreed/clickup-mcp-full
```

**Claude Desktop, Cursor, Windsurf, or any client using `mcpServers` JSON**

```json
{
  "mcpServers": {
    "clickup_full_local": {
      "command": "npx",
      "args": ["-y", "github:breckenreed/clickup-mcp-full"],
      "env": {
        "CLICKUP_API_KEY": "pk_your_token",
        "CLICKUP_TEAM_ID": "9012345678"
      }
    }
  }
}
```

**Hermes** (`~/.hermes/config.yaml`)

```yaml
mcp_servers:
  clickup_full_local:
    command: npx
    args: ["-y", "github:breckenreed/clickup-mcp-full"]
    env:
      CLICKUP_API_KEY: "${CLICKUP_API_KEY}"
      CLICKUP_TEAM_ID: "${CLICKUP_TEAM_ID}"
    connect_timeout: 60
    keepalive_interval: 60
    idle_timeout_seconds: 1800
```

**Global install**, if you would rather not resolve from GitHub on every launch:

```bash
npm install -g github:breckenreed/clickup-mcp-full
```

then use `clickup-mcp-full` as the command with no arguments.

## Credentials

| Variable | Where to get it |
|---|---|
| `CLICKUP_API_KEY` | ClickUp, Settings, Apps, API Token. Starts with `pk_`. |
| `CLICKUP_TEAM_ID` | The number in your ClickUp URL, or `curl -H "Authorization: $CLICKUP_API_KEY" https://api.clickup.com/api/v2/team` and read `.teams[].id`. |

A ClickUp personal token has no scopes of its own. It acts as the user who
created it and inherits that user's permissions, so if you want an agent that
cannot write, create the token under a view-only ClickUp account rather than
relying on tool selection.

## Tools

| Tool | Access | What it does |
|---|---|---|
| `get_task_tree` | read | Task plus all nested subtasks, any depth, one call |
| `get_workspace_hierarchy` | read | Spaces, folders, lists as a tree |
| `search_tasks` | read | One task by id, one list, or workspace-wide filters |
| `get_container` | read | Details of a single list or folder |
| `find_members` | read | Resolve a name or email to an assignee id |
| `task_comments` | read, write | Get and add comments |
| `manage_task` | write | Create, update, delete, move, duplicate |
| `manage_container` | write | Create, update, delete lists and folders |
| `operate_tags` | read, write | List, create, update, delete tags |
| `task_time_tracking` | read, write | Get, start, stop, add, delete entries |

Upstream also ships `attach_file_to_task`, which uploads a local file into
ClickUp. It is **off by default** here: for an agent that runs without
per-action confirmation, it turns any prompt injection the agent reads into a
data-egress path. Enable it deliberately if you need it:

```
ENABLED_TOOLS=get_workspace_hierarchy,search_tasks,manage_task,task_comments,get_container,manage_container,find_members,operate_tags,task_time_tracking,attach_file_to_task
```

## Options

| Variable | Default | Effect |
|---|---|---|
| `ENABLED_TOOLS` | the nine above | Comma-separated allowlist. Overrides the default set. `get_task_tree` is always available. |
| `DISABLED_TOOLS` | unset | Comma-separated blocklist. Ignored when `ENABLED_TOOLS` is set. |
| `REQUEST_SPACING` | `100` | Milliseconds between ClickUp API calls. See below. |
| `DOCUMENT_SUPPORT` | `false` | `true` exposes upstream's document tools. |

**Raise `REQUEST_SPACING` on a shared workspace.** The default allows about ten
requests per second, while ClickUp's per-token limit is roughly 100 per minute
on most plans. The limit is counted against the token, not the tool, so an
agent that exhausts it also breaks every other integration running under the
same token. `700` keeps you under a 100 per minute ceiling.

## Notes on behaviour

**Subtasks in another list.** The tree is built by walking the list that
contains the root task. If your workspace places subtasks in a different list
from their parent, those will not appear, and the server falls back to the
direct children reported by the task endpoint. Open an issue if you hit this
and it matters.

**`search_tasks` descriptions.** The upstream description ("Works 3 ways")
leads smaller models to put a plain id like `86capt3b` into `customTaskId`,
which is only for prefixed ids like `DEV-123`. Such a call falls through to the
workspace-search branch and fails with "At least one filter parameter is
required", an error that names the wrong problem, after which the model tends
to invent filters instead of fixing the field. This server replaces that
description with the single rule the model actually needs.

**Running inside Docker with a bind-mounted home.** If your agent launches MCP
servers with `HOME` pointing at a bind mount, `npx` rebuilds its package cache
across that mount on every connect, which can take minutes and time out. Install
globally inside the image instead and point `command:` at the binary.

## Troubleshooting

Check that the server starts and lists its tools:

```bash
CLICKUP_API_KEY=pk_... CLICKUP_TEAM_ID=... npx -y github:breckenreed/clickup-mcp-full --help
```

`Missing required environment` means the variables did not reach the process:
most clients require them in the server's own `env` block, not your shell.

A 401 from any tool means the token is wrong or was revoked. A 429 means you
are hitting the rate limit, so raise `REQUEST_SPACING`.

## License

MIT, like the upstream server it wraps. `@twofeetup/clickup-mcp` is the
MIT-licensed community continuation of the pre-paid tree of
`@taazkareem/clickup-mcp-server`.
