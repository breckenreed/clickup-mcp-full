import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_TOOLS,
  decorateChildTools,
  DESCRIPTION_OVERRIDES,
  DESCRIPTION_SUFFIXES,
  NATIVE_TOOLS,
  TOOL_ANNOTATIONS,
  coerceArg,
  normaliseArgs,
} from '../src/tools.mjs';

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

test('every native tool declares a name, a description and a schema', () => {
  for (const tool of NATIVE_TOOLS) {
    assert.ok(tool.name, 'tool has a name');
    assert.ok(tool.description.length > 40, `${tool.name} describes itself`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.deepEqual(tool.inputSchema.required, ['taskId']);
  }
});

test('every native tool declares all four annotation hints as booleans', () => {
  for (const tool of NATIVE_TOOLS) {
    for (const hint of HINTS) {
      assert.equal(
        typeof tool.annotations?.[hint],
        'boolean',
        `${tool.name} declares ${hint}`,
      );
    }
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} only reads`);
    assert.equal(tool.annotations.destructiveHint, false);
  }
});

test('every default tool has an annotation to hand the host', () => {
  for (const name of DEFAULT_TOOLS) {
    const annotations = TOOL_ANNOTATIONS[name];
    assert.ok(annotations, `${name} is annotated`);
    for (const hint of HINTS) {
      assert.equal(typeof annotations[hint], 'boolean', `${name} declares ${hint}`);
    }
  }
});

test('a tool that can delete is not marked read-only', () => {
  for (const name of ['manage_task', 'manage_container', 'operate_tags', 'task_time_tracking']) {
    assert.equal(TOOL_ANNOTATIONS[name].readOnlyHint, false);
    assert.equal(TOOL_ANNOTATIONS[name].destructiveHint, true);
  }
  assert.equal(TOOL_ANNOTATIONS.task_comments.destructiveHint, false);
});

test('decorateChildTools rewrites the description that misleads small models', () => {
  const [tool] = decorateChildTools([{ name: 'search_tasks', description: 'Works 3 ways...' }]);

  assert.equal(tool.description, DESCRIPTION_OVERRIDES.search_tasks);
  assert.equal(tool.annotations.readOnlyHint, true);
});

test('decorateChildTools appends rather than replaces where upstream still rules', () => {
  const [tool] = decorateChildTools([{ name: 'task_comments', description: 'Upstream text.' }]);

  assert.ok(tool.description.startsWith('Upstream text.'));
  assert.ok(tool.description.endsWith(DESCRIPTION_SUFFIXES.task_comments));
});

test('an annotation upstream declares itself wins over ours', () => {
  const [tool] = decorateChildTools([
    { name: 'manage_task', description: 'x', annotations: { destructiveHint: false } },
  ]);

  assert.equal(tool.annotations.destructiveHint, false, 'upstream wins');
  assert.equal(tool.annotations.readOnlyHint, false, 'the rest is still filled in');
});

test('decorateChildTools leaves an unknown tool untouched', () => {
  const input = [{ name: 'something_new', description: 'x' }];
  const [tool] = decorateChildTools(input);

  assert.equal(tool, input[0]);
});

test('normaliseArgs accepts the spellings a small model reaches for', () => {
  const { args, renamed } = normaliseArgs('get_task_tree', {
    task_id: '86capt3b',
    'include-closed': 'false',
    maxDepth: '3',
  });

  assert.equal(args.taskId, '86capt3b');
  assert.equal(args.include_closed, false);
  assert.equal(args.max_depth, 3);
  assert.ok(renamed.length >= 2);
});

test('normaliseArgs reads a bare id or task as the task id', () => {
  assert.equal(normaliseArgs('get_task_tree', { id: 'abc' }).args.taskId, 'abc');
  assert.equal(normaliseArgs('get_task_activity', { task: 'abc' }).args.taskId, 'abc');
});

test('normaliseArgs keeps the spelling that carries a value', () => {
  const { args } = normaliseArgs('get_task_tree', { taskId: '', task_id: 'abc' });

  assert.equal(args.taskId, 'abc');
});

test('normaliseArgs hands an unknown key over untouched', () => {
  const { args } = normaliseArgs('get_task_tree', { taskId: 'a', whatever: 1 });

  assert.equal(args.whatever, 1);
});

test('normaliseArgs leaves a tool it does not own alone', () => {
  const { args, renamed } = normaliseArgs('manage_task', { task_id: 'a' });

  assert.deepEqual(args, { task_id: 'a' });
  assert.deepEqual(renamed, []);
});

test('coerceArg turns a string into the declared type', () => {
  assert.equal(coerceArg('true', 'boolean'), true);
  assert.equal(coerceArg('no', 'boolean'), false);
  assert.equal(coerceArg('12', 'number'), 12);
  assert.deepEqual(coerceArg('status, tag', 'array'), ['status', 'tag']);
  assert.deepEqual(coerceArg('status', 'array'), ['status']);
  assert.equal(coerceArg('not a number', 'number'), 'not a number');
});
