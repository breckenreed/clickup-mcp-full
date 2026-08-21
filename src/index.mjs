#!/usr/bin/env node
/**
 * clickup-mcp-full — ClickUp MCP server with a one-call nested subtask tree.
 *
 * This is a thin stdio proxy in front of @twofeetup/clickup-mcp rather than a
 * fork of it. It spawns that server as a child, speaks the same newline-
 * delimited JSON-RPC in both directions, and changes exactly three things:
 *
 *   1. adds `get_task_tree`, implemented here, which reads a task and ALL of
 *      its nested subtasks at every depth in one call;
 *   2. rewrites the `search_tasks` description, whose "Works 3 ways" phrasing
 *      reliably walks smaller models into a dead end (see below);
 *   3. defaults the exposed tool set to the nine documented in the README,
 *      unless you set ENABLED_TOOLS / DISABLED_TOOLS yourself.
 *
 * Everything else — every other tool, initialize, prompts, notifications — is
 * passed through untouched, so upstream fixes and new tools arrive with a
 * dependency bump instead of a merge.
 *
 * Why get_task_tree exists
 * ------------------------
 * Upstream's only route to subtasks is search_tasks + include_subtasks, which
 * calls GET /task/{id}?subtasks=true and returns FULL task objects for the
 * DIRECT children only. On a task with fifty nested subtasks that is both
 * incomplete (one level) and ruinous for an agent's context window, and the
 * alternative — one request per node — is worse.
 *
 * This walks the containing list once instead. ClickUp's
 * GET /list/{id}/task?subtasks=true returns every task in the list with its
 * `parent` pointer, so the whole tree is reassembled locally: two-ish requests
 * regardless of depth or width. Output is one indented line per task rather
 * than task objects, because an agent planning work needs ids, names and
 * statuses, not custom-field arrays.
 *
 * Why the search_tasks description is rewritten
 * ---------------------------------------------
 * Upstream says "Works 3 ways: (1) Single task by taskId/taskName/
 * customTaskId". Smaller models read that and put a plain id (86capt3b) into
 * customTaskId, which is only for prefixed ids like DEV-123. Such a call falls
 * through to the workspace-search branch and dies on "At least one filter
 * parameter is required" — an error naming the wrong problem, so the model
 * then invents filters instead of fixing the field, and burns a dozen calls.
 * The rule it actually needs is one sentence, so this states it as one.
 *
 * MIT licensed, like the upstream server it wraps.
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const VERSION = '1.0.0';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stderr.write(
    `clickup-mcp-full ${VERSION}\n\n` +
      'An MCP server. Agents launch it over stdio; there is nothing to run by hand.\n\n' +
      'Required environment:\n' +
      '  CLICKUP_API_KEY   ClickUp personal API token (Settings -> Apps -> API Token)\n' +
      '  CLICKUP_TEAM_ID   Workspace id (the number in your ClickUp URL)\n\n' +
      'Optional:\n' +
      '  ENABLED_TOOLS     comma-separated allowlist (overrides the default set)\n' +
      '  DISABLED_TOOLS    comma-separated blocklist\n' +
      '  REQUEST_SPACING   ms between ClickUp API calls (default 100)\n' +
      '  DOCUMENT_SUPPORT  "true" to expose the document tools\n\n' +
      'See https://github.com/breckenreed/clickup-mcp-full\n',
  );
  process.exit(0);
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const log = (...parts) => console.error('[clickup-mcp-full]', ...parts);

// ── Configuration ──────────────────────────────────────────────────────────

// The nine tools this server exposes by default. Deliberately excludes
// upstream's tenth, attach_file_to_task: it uploads a local file into ClickUp,
// which turns any prompt injection an agent reads into a data-egress path.
// Set ENABLED_TOOLS yourself to include it.
const DEFAULT_TOOLS = [
  'get_workspace_hierarchy', // read:  spaces -> folders -> lists
  'search_tasks',            // read:  by id, by list, or workspace-wide filters
  'manage_task',             // write: create / update / delete / move / duplicate
  'task_comments',           // read+write: get / add comments
  'get_container',           // read:  details of one list or folder
  'manage_container',        // write: create / update / delete lists and folders
  'find_members',            // read:  resolve a name or email to an assignee id
  'operate_tags',            // read+write: list / create / update / delete tags
  'task_time_tracking',      // read+write: get / start / stop / add / delete entries
];

const missing = ['CLICKUP_API_KEY', 'CLICKUP_TEAM_ID'].filter(
  (key) => !String(process.env[key] || '').trim(),
);
if (missing.length) {
  log(
    `missing required environment: ${missing.join(', ')}. ` +
      'Set them in your MCP client config and restart. Run with --help for details.',
  );
  process.exit(1);
}

let childEntry;
try {
  childEntry =
    process.env.CLICKUP_MCP_ENTRY ||
    require.resolve('@twofeetup/clickup-mcp/build/index.js');
} catch {
  log(
    'could not resolve @twofeetup/clickup-mcp. Reinstall this package so its ' +
      'dependency is present (npx -y github:breckenreed/clickup-mcp-full).',
  );
  process.exit(1);
}

// Respect an explicit tool selection; otherwise pin the documented default set.
const childEnv = { ...process.env };
if (!childEnv.ENABLED_TOOLS && !childEnv.DISABLED_TOOLS) {
  childEnv.ENABLED_TOOLS = DEFAULT_TOOLS.join(',');
}
// stdio only: an inherited ENABLE_SSE must not open a listening socket.
childEnv.ENABLE_SSE = 'false';
childEnv.ENABLE_STDIO = 'true';

const child = spawn(process.execPath, [childEntry], {
  stdio: ['pipe', 'pipe', 'inherit'], // child stderr flows to ours, for host logs
  env: childEnv,
});

child.on('error', (err) => {
  log(`could not spawn ${childEntry}: ${err.message}`);
  process.exit(1);
});

// ── Native tools ───────────────────────────────────────────────────────────

const NATIVE_TOOLS = [
  {
    name: 'get_task_tree',
    description:
      'Read a task together with ALL its nested subtasks, at every depth, in ' +
      'ONE call (READ-ONLY). Use this whenever the question involves subtasks, ' +
      'children, breakdown or progress of a task, and never fetch subtasks one ' +
      'by one. Returns a compact indented tree (id, status, name, assignees) ' +
      'plus a status tally, not full task objects.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description:
            'REQUIRED: id of the root task, e.g. "86capt3b". Works with both ' +
            'regular and custom ids.',
        },
        include_closed: {
          type: 'boolean',
          description: 'Include closed/done subtasks (default: true)',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum nesting depth to walk (default: 10)',
        },
      },
      required: ['taskId'],
    },
  },
];

const NATIVE_TOOL_NAMES = new Set(NATIVE_TOOLS.map((t) => t.name));

const DESCRIPTION_OVERRIDES = {
  search_tasks:
    'Find tasks. Pick ONE of three modes:\n' +
    '(1) ONE known task: pass taskId. A plain id like "86capt3b" is a taskId — ' +
    'it handles regular AND custom ids, so use it by default. Only use ' +
    'customTaskId for ids with a project prefix like "DEV-123". Putting a ' +
    'plain id in customTaskId fails with a misleading "filter required" error.\n' +
    '(2) One list: pass listId or listName.\n' +
    '(3) Across the workspace: pass at least one real filter (tags, statuses, ' +
    'assignees, list_ids, folder_ids, space_ids, or a date filter). A task id ' +
    'is NOT a filter.\n' +
    'For the subtasks of a task do NOT use this tool — call get_task_tree, ' +
    'which returns the whole nested tree in one compact call.',
};

// ── ClickUp REST (native tools only) ───────────────────────────────────────

const CLICKUP_API = 'https://api.clickup.com/api/v2';

// The single network path for native tools. GET is hardcoded, and callers only
// supply a path, so nothing here can become a write.
async function clickupGet(path) {
  const res = await fetch(`${CLICKUP_API}${path}`, {
    method: 'GET',
    headers: {
      Authorization: process.env.CLICKUP_API_KEY || '',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `ClickUp API ${res.status} ${res.statusText} on ${path}` +
        (body ? `: ${body.slice(0, 200)}` : ''),
    );
  }
  return res.json();
}

// ClickUp caps a list page at 100 tasks and flags the end with last_page.
async function fetchListTasks(listId, includeClosed) {
  const collected = [];
  for (let page = 0; page < 25; page++) {
    const data = await clickupGet(
      `/list/${encodeURIComponent(listId)}/task?subtasks=true` +
        `&include_closed=${includeClosed ? 'true' : 'false'}&page=${page}`,
    );
    const tasks = data.tasks || [];
    collected.push(...tasks);
    if (data.last_page || tasks.length === 0) break;
  }
  return collected;
}

function renderTree(root, childrenBy, maxDepth) {
  const lines = [];
  const tally = new Map();
  const seen = new Set();
  let count = 0;

  const walk = (task, depth) => {
    if (seen.has(task.id)) return; // a cycle would otherwise recurse forever
    seen.add(task.id);

    const status = task.status?.status || 'no status';
    tally.set(status, (tally.get(status) || 0) + 1);
    count++;

    const who = (task.assignees || [])
      .map((a) => a.username || a.email)
      .filter(Boolean)
      .join(', ');
    const custom = task.custom_id ? ` (${task.custom_id})` : '';
    lines.push(
      `${'  '.repeat(depth)}${task.id}${custom}  [${status}]  ${task.name}` +
        (who ? `  <${who}>` : ''),
    );

    const children = childrenBy.get(task.id) || [];
    if (depth >= maxDepth) {
      if (children.length) {
        lines.push(
          `${'  '.repeat(depth + 1)}... ${children.length} more, depth limit reached`,
        );
      }
      return;
    }
    for (const child of children) walk(child, depth + 1);
  };

  walk(root, 0);
  const summary = [...tally.entries()].map(([s, n]) => `${s}: ${n}`).join(', ');
  return { text: lines.join('\n'), count, summary };
}

async function getTaskTree(args) {
  const taskId = String(args?.taskId || '').trim();
  if (!taskId) throw new Error('taskId is required');
  const includeClosed = args?.include_closed !== false;
  const maxDepth = Number.isFinite(args?.max_depth) ? Number(args.max_depth) : 10;

  const root = await clickupGet(
    `/task/${encodeURIComponent(taskId)}?include_subtasks=true`,
  );
  const listId = root.list?.id;

  // Walking the list yields every descendant with its parent pointer. If the
  // task has no list, or the list read fails, fall back to whatever the task
  // endpoint itself returned: one level, but better than an error.
  let pool = [];
  if (listId) {
    try {
      pool = await fetchListTasks(listId, includeClosed);
    } catch (err) {
      log(`list walk failed (${err.message}); falling back to direct subtasks`);
    }
  }
  if (pool.length === 0) pool = [root, ...(root.subtasks || [])];

  const childrenBy = new Map();
  for (const task of pool) {
    if (!task.parent) continue;
    if (!childrenBy.has(task.parent)) childrenBy.set(task.parent, []);
    childrenBy.get(task.parent).push(task);
  }

  const { text, count, summary } = renderTree(root, childrenBy, maxDepth);
  const header =
    `Task tree for ${root.id}${root.custom_id ? ` (${root.custom_id})` : ''}: ` +
    `${count} task(s) including the root.\n` +
    (summary ? `Statuses: ${summary}\n` : '') +
    (listId ? `List: ${root.list?.name || listId}\n` : '');
  return `${header}\n${text}`;
}

const NATIVE_HANDLERS = { get_task_tree: getTaskTree };

// ── JSON-RPC plumbing ──────────────────────────────────────────────────────

const writeLine = (stream, msg) => stream.write(`${JSON.stringify(msg)}\n`);
const toClient = (msg) => writeLine(process.stdout, msg);
const toChild = (msg) => writeLine(child.stdin, msg);

// ids may be numbers or strings; keep the type in the key so 1 and "1" differ.
const idKey = (id) => `${typeof id}:${id}`;
const pendingListTools = new Set();
const pendingInitialize = new Set();

function runNativeTool(id, name, args) {
  NATIVE_HANDLERS[name](args)
    .then((text) => {
      toClient({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    })
    .catch((err) => {
      log(`${name} failed: ${err.message}`);
      toClient({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `${name} failed: ${err.message}` }],
        },
      });
    });
}

function handleFromClient(line) {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log('dropped unparsable client message');
    return;
  }

  // JSON-RPC batching was removed from MCP; refuse rather than let a batch slip
  // past the per-message routing below.
  if (Array.isArray(msg)) {
    log('refused a JSON-RPC batch (not supported)');
    for (const item of msg) {
      if (item && item.id !== undefined && item.id !== null) {
        toClient({
          jsonrpc: '2.0',
          id: item.id,
          error: { code: -32600, message: 'Batched requests are not supported.' },
        });
      }
    }
    return;
  }

  // Native tools are answered here and never reach the child.
  if (msg.method === 'tools/call' && NATIVE_TOOL_NAMES.has(msg.params?.name)) {
    if (msg.id !== undefined && msg.id !== null) {
      runNativeTool(msg.id, msg.params.name, msg.params?.arguments || {});
    }
    return;
  }

  if (msg.id !== undefined && msg.id !== null) {
    if (msg.method === 'tools/list') pendingListTools.add(idKey(msg.id));
    else if (msg.method === 'initialize') pendingInitialize.add(idKey(msg.id));
  }

  toChild(msg);
}

function handleFromChild(line) {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log('dropped unparsable server message');
    return;
  }

  const key = msg.id === undefined || msg.id === null ? null : idKey(msg.id);

  if (key !== null && pendingListTools.delete(key)) {
    if (Array.isArray(msg.result?.tools)) {
      msg.result.tools = msg.result.tools.map((tool) =>
        DESCRIPTION_OVERRIDES[tool?.name]
          ? { ...tool, description: DESCRIPTION_OVERRIDES[tool.name] }
          : tool,
      );
      msg.result.tools.push(...NATIVE_TOOLS);
    }
  } else if (key !== null && pendingInitialize.delete(key)) {
    if (msg.result?.serverInfo?.name) {
      msg.result.serverInfo.name = 'clickup-mcp-full';
      msg.result.serverInfo.version = VERSION;
    }
  }

  toClient(msg);
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

// The upstream server ignores a closed stdin and keeps running, so closing our
// end is not enough to end it: escalate, or a recycled server leaks a process.
function shutdownChild() {
  child.stdin.end();
  setTimeout(() => child.kill('SIGTERM'), 2000).unref();
  setTimeout(() => child.kill('SIGKILL'), 6000).unref();
}

const fromClient = createInterface({ input: process.stdin, crlfDelay: Infinity });
fromClient.on('line', handleFromClient);
fromClient.on('close', shutdownChild);

const fromChild = createInterface({ input: child.stdout, crlfDelay: Infinity });
fromChild.on('line', handleFromChild);

// EPIPE on either pipe just means the other side went away first.
child.stdin.on('error', () => {});
process.stdout.on('error', () => {});

child.on('exit', (code, signal) => {
  if (signal) log(`server exited on ${signal}`);
  // Let the loop drain what is already queued instead of exiting mid-write.
  process.exitCode = code ?? (signal ? 143 : 0);
  fromClient.close();
  process.stdin.pause();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  });
}
