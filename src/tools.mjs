/**
 * Tool definitions: what this server exposes, how it is described, and how
 * loosely spelled arguments are read.
 *
 * Kept out of index.mjs so the shape of the tool surface can be asserted
 * without starting a server (see test/tools.test.mjs).
 */

// The nine tools this server exposes by default. Deliberately excludes
// upstream's tenth, attach_file_to_task: it uploads a local file into ClickUp,
// which turns any prompt injection an agent reads into a data-egress path.
// Set ENABLED_TOOLS yourself to include it.
export const DEFAULT_TOOLS = [
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

export const NATIVE_TOOLS = [
  {
    name: 'get_task_tree',
    description:
      'Read a task together with ALL its nested subtasks, at every depth, in ' +
      'ONE call (READ-ONLY). Use this whenever the question involves subtasks, ' +
      'children, breakdown or progress of a task, and never fetch subtasks one ' +
      'by one. Returns a compact indented tree (id, status, name, assignees) ' +
      'plus a status tally, not full task objects.',
    annotations: {
      title: 'Task tree with all nested subtasks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
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
  {
    name: 'get_task_activity',
    description:
      'Read the FULL activity log of a task in ONE call (READ-ONLY): every ' +
      'system event — status changes, due/start date moves, assignees, ' +
      'watchers, tags, priority, name and description edits, custom fields, ' +
      'list/folder moves, attachments, checklists, time estimates, task ' +
      'relationships — merged with the comments into one chronological view ' +
      'with who did what and when. Use this for any question about the ' +
      'history of a task ("who changed the deadline", "when did it move to in ' +
      'progress", "who assigned this", "what happened last week"). ' +
      'task_comments only returns comments and answers none of those.',
    annotations: {
      title: 'Full task activity log',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description:
            'REQUIRED: id of the task, e.g. "86capt3b". Works with both ' +
            'regular and custom ids.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default: 100)',
        },
        include_comments: {
          type: 'boolean',
          description:
            'Include comments alongside the system events (default: true)',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Only return these event kinds. Use the raw ClickUp field names: ' +
            'status, assignee_add, assignee_rem, watcher_add, watcher_rem, ' +
            'due_date, start_date, priority, tag, name, content, comment, ' +
            'section_moved, subcategory, attachment, checklist, ' +
            'checklist_item, time_estimate, time_spent, custom_field, ' +
            'task_creation, linked_task, dependency. Omit for everything.',
        },
        since: {
          type: 'string',
          description:
            'Only events at or after this point. ISO date ("2026-01-31") or a ' +
            'millisecond timestamp.',
        },
        oldest_first: {
          type: 'boolean',
          description:
            'Render oldest event first instead of newest first (default: false)',
        },
      },
      required: ['taskId'],
    },
  },
];

export const NATIVE_TOOL_NAMES = new Set(NATIVE_TOOLS.map((t) => t.name));

export const DESCRIPTION_OVERRIDES = {
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

// Appended, not replaced: the upstream text still carries the write-side rules
// for these tools, and only the routing hint is missing.
export const DESCRIPTION_SUFFIXES = {
  task_comments:
    '\n\nREADING NOTE: this returns comments ONLY. For the history of a task — ' +
    'status changes, due-date moves, assignees, tags, priority, custom ' +
    'fields — call get_task_activity, which returns those events and the ' +
    'comments together.',
};

// ── Tool annotations ───────────────────────────────────────────────────────
//
// MCP hosts use these to decide what to warn about before a call: a read-only
// tool can run unattended, a destructive one should not. Upstream ships none,
// so they are declared here, from the same reading of each tool that produced
// the access column in the README. Four hints on every tool, explicitly true
// or false — a missing hint is not the same claim as `false`, and directories
// (OpenAI's among them) reject tools that leave any of them out.
//
// readOnlyHint    the tool cannot modify the workspace
// destructiveHint the tool can remove or overwrite something that existed
// idempotentHint  repeating the same call changes nothing further
// openWorldHint   the tool reaches an external system (always true here: every
//                 one of them talks to the ClickUp API)
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};
const ADDITIVE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};
const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export const TOOL_ANNOTATIONS = {
  // read
  get_workspace_hierarchy: { title: 'Workspace hierarchy', ...READ_ONLY },
  search_tasks: { title: 'Find tasks', ...READ_ONLY },
  get_container: { title: 'Read a list or folder', ...READ_ONLY },
  find_members: { title: 'Find a workspace member', ...READ_ONLY },
  // write, additive
  task_comments: { title: 'Read and add comments', ...ADDITIVE },
  attach_file_to_task: { title: 'Upload a file to a task', ...ADDITIVE },
  // write, can delete
  manage_task: { title: 'Create, update, move or delete a task', ...DESTRUCTIVE },
  manage_container: {
    title: 'Create, update or delete a list or folder',
    ...DESTRUCTIVE,
  },
  operate_tags: { title: 'List, create, update or delete tags', ...DESTRUCTIVE },
  task_time_tracking: {
    title: 'Read, start, stop or delete time entries',
    ...DESTRUCTIVE,
  },
  // documents, exposed only when DOCUMENT_SUPPORT is on
  list_documents: { title: 'List documents', ...READ_ONLY },
  list_document_pages: { title: 'List document pages', ...READ_ONLY },
  get_document_pages: { title: 'Read document pages', ...READ_ONLY },
  create_document: { title: 'Create a document', ...ADDITIVE },
  create_document_page: { title: 'Create a document page', ...ADDITIVE },
  update_document_page: { title: 'Update a document page', ...DESTRUCTIVE },
};

// One pass over the tool list the child returns: the descriptions this server
// rewrites, then the annotations. Upstream's own annotation wins wherever it
// declares one — this fills gaps, it does not overrule the server that
// implements the tool.
export function decorateChildTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((tool) => {
    if (!tool || typeof tool !== 'object') return tool;
    const override = DESCRIPTION_OVERRIDES[tool.name];
    const suffix = DESCRIPTION_SUFFIXES[tool.name];
    const defaults = TOOL_ANNOTATIONS[tool.name];
    if (!override && !suffix && !defaults) return tool;

    const base = override ?? tool.description ?? '';
    const decorated = { ...tool };
    if (override || suffix) {
      decorated.description = suffix ? `${base}${suffix}` : base;
    }
    if (defaults) {
      decorated.annotations = { ...defaults, ...(tool.annotations || {}) };
    }
    return decorated;
  });
}

export const foldKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

// Spellings that do not fold to the canonical name on their own.
export const ARG_SYNONYMS = { id: 'taskId', task: 'taskId' };

const NATIVE_ARG_SPECS = new Map(
  NATIVE_TOOLS.map((tool) => {
    const props = tool.inputSchema?.properties || {};
    const byFold = new Map(
      Object.keys(props).map((name) => [foldKey(name), name]),
    );
    return [tool.name, { byFold, props }];
  }),
);

export function coerceArg(value, type) {
  if (value === null || value === undefined) return value;
  if (type === 'number' && typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === 'boolean' && typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'yes' || v === '1') return true;
    if (v === 'false' || v === 'no' || v === '0') return false;
  }
  if (type === 'array' && typeof value === 'string') {
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  if (type === 'array' && !Array.isArray(value)) return [value];
  return value;
}

export function normaliseArgs(name, args) {
  const spec = NATIVE_ARG_SPECS.get(name);
  if (!spec || !args || typeof args !== 'object') {
    return { args: args && typeof args === 'object' ? args : {}, renamed: [] };
  }

  const out = {};
  const renamed = [];
  for (const [key, value] of Object.entries(args)) {
    const fold = foldKey(key);
    const canonical = spec.byFold.get(fold) || ARG_SYNONYMS[fold];
    if (!canonical) {
      out[key] = value; // unknown key: hand it over untouched
      continue;
    }
    // Both spellings can arrive at once; the one carrying a value wins.
    const held = out[canonical];
    if (held !== undefined && held !== null && held !== '') continue;
    if (canonical !== key) renamed.push(`${key}->${canonical}`);
    out[canonical] = coerceArg(value, spec.props[canonical]?.type);
  }
  return { args: out, renamed };
}
