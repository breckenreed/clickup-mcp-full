// End-to-end over the real stdio protocol: the server is spawned exactly as a
// host would spawn it. Credentials are fake and nothing here reaches ClickUp —
// every case is answered before the first request would be made.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const SERVER = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
const ENV = { CLICKUP_API_KEY: 'pk_fake', CLICKUP_TEAM_ID: '9012345678' };

// Feeds the server a list of messages, collects what it writes back, and
// resolves once it has answered every id it was given.
function talk(messages, { env = {}, expected = messages.length } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...ENV, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const replies = [];
    let out = '';
    let err = '';
    const done = (value) => {
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(
      () => done({ replies, stderr: err, code: null, timedOut: true }),
      15000,
    );

    child.stdout.on('data', (chunk) => {
      out += chunk;
      const lines = out.split('\n');
      out = lines.pop();
      for (const line of lines) {
        if (line.trim()) replies.push(JSON.parse(line));
      }
      if (replies.length >= expected) done({ replies, stderr: err, code: null });
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => done({ replies, stderr: err, code }));

    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

let handshake;
const shared = async () => {
  handshake ??= await talk([initialize, listTools]);
  return handshake;
};

test('initialize answers as this server, not as the one it wraps', async () => {
  const { replies } = await shared();
  const info = replies.find((r) => r.id === 1)?.result?.serverInfo;

  assert.equal(info.name, 'clickup-mcp-full');
  assert.match(info.version, /^\d+\.\d+\.\d+$/);
});

test('tools/list returns the documented set, native tools included', async () => {
  const { replies } = await shared();
  const names = replies.find((r) => r.id === 2).result.tools.map((t) => t.name);

  assert.equal(names.length, 11);
  for (const expected of [
    'get_task_tree',
    'get_task_activity',
    'get_workspace_hierarchy',
    'search_tasks',
    'manage_task',
    'task_comments',
    'get_container',
    'manage_container',
    'find_members',
    'operate_tags',
    'task_time_tracking',
  ]) {
    assert.ok(names.includes(expected), `${expected} is exposed`);
  }
  assert.ok(!names.includes('attach_file_to_task'), 'file upload stays off');
});

test('every exposed tool carries all four annotation hints', async () => {
  const { replies } = await shared();
  const tools = replies.find((r) => r.id === 2).result.tools;

  for (const tool of tools) {
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.equal(
        typeof tool.annotations?.[hint],
        'boolean',
        `${tool.name} declares ${hint}`,
      );
    }
  }
});

test('search_tasks carries the rewritten description', async () => {
  const { replies } = await shared();
  const tools = replies.find((r) => r.id === 2).result.tools;
  const search = tools.find((t) => t.name === 'search_tasks');
  const comments = tools.find((t) => t.name === 'task_comments');

  assert.match(search.description, /Pick ONE of three modes/);
  assert.match(comments.description, /call get_task_activity/);
});

test('a native tool reports a missing taskId instead of calling ClickUp', async () => {
  const { replies } = await talk(
    [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_task_tree', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_task_activity', arguments: {} } },
    ],
    { expected: 2 },
  );

  for (const reply of replies) {
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /taskId is required/);
  }
});

test('a native tool call with no arguments at all is answered, not dropped', async () => {
  const { replies } = await talk(
    [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_task_tree' } }],
    { expected: 1 },
  );

  assert.equal(replies[0].result.isError, true);
});

test('a JSON-RPC batch is refused rather than forwarded', async () => {
  const { replies } = await talk(
    [[{ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }]],
    { expected: 1 },
  );

  assert.equal(replies[0].id, 7);
  assert.equal(replies[0].error.code, -32600);
});

test('missing credentials stop the server with a message naming them', async () => {
  const { code, stderr } = await talk([], { env: { CLICKUP_API_KEY: '' }, expected: 0 });

  assert.equal(code, 1);
  assert.match(stderr, /missing required environment: CLICKUP_API_KEY/);
});

test('CLICKUP_MCP_ENTRY cannot point the token at code outside the package', async () => {
  const { code, stderr } = await talk([], {
    env: { CLICKUP_MCP_ENTRY: '/tmp/not-the-server.js' },
    expected: 0,
  });

  assert.equal(code, 1);
  assert.match(stderr, /refusing CLICKUP_MCP_ENTRY/);
});

test('--version prints the version and exits', async () => {
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, '--version'], {
      env: { PATH: process.env.PATH, ...ENV },
    });
    let text = '';
    child.stdout.on('data', (c) => (text += c));
    child.on('exit', () => resolve(text));
  });

  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});

after(() => {
  handshake = null;
});
