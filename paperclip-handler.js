const https = require('https');
const http = require('http');

function paperclipRequest(method, path, body) {
  const apiUrl = process.env.PAPERCLIP_API_URL;
  const apiKey = process.env.PAPERCLIP_API_KEY;
  if (!apiUrl || !apiKey) throw new Error('PAPERCLIP_API_URL or PAPERCLIP_API_KEY not configured');

  const url = new URL(path, apiUrl);
  const lib = url.protocol === 'https:' ? https : http;
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = lib.request(url.toString(), {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Paperclip request timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function getCompanyId() {
  return process.env.PAPERCLIP_COMPANY_ID;
}

async function executeTool(toolName, toolInput) {
  const companyId = getCompanyId();

  if (toolName === 'paperclip_get_dashboard') {
    const data = await paperclipRequest('GET', `/api/companies/${companyId}/dashboard`);
    return JSON.stringify(data, null, 2);
  }

  if (toolName === 'paperclip_list_issues') {
    const params = new URLSearchParams();
    if (toolInput.status) params.set('status', toolInput.status);
    if (toolInput.assigneeAgentId) params.set('assigneeAgentId', toolInput.assigneeAgentId);
    if (toolInput.q) params.set('q', toolInput.q);
    if (toolInput.priority) params.set('priority', toolInput.priority);
    const data = await paperclipRequest('GET', `/api/companies/${companyId}/issues?${params}`);
    return JSON.stringify(data, null, 2);
  }

  if (toolName === 'paperclip_get_issue') {
    const data = await paperclipRequest('GET', `/api/issues/${toolInput.issueId}`);
    return JSON.stringify(data, null, 2);
  }

  if (toolName === 'paperclip_list_agents') {
    const data = await paperclipRequest('GET', `/api/companies/${companyId}/agents`);
    return JSON.stringify(data, null, 2);
  }

  if (toolName === 'paperclip_update_issue') {
    const { issueId, ...updates } = toolInput;
    const data = await paperclipRequest('PATCH', `/api/issues/${issueId}`, updates);
    return JSON.stringify(data, null, 2);
  }

  if (toolName === 'paperclip_create_issue') {
    const data = await paperclipRequest('POST', `/api/companies/${companyId}/issues`, toolInput);
    return JSON.stringify(data, null, 2);
  }

  if (toolName === 'paperclip_get_comments') {
    const data = await paperclipRequest('GET', `/api/issues/${toolInput.issueId}/comments`);
    return JSON.stringify(data, null, 2);
  }

  throw new Error(`Unknown tool: ${toolName}`);
}

function isPaperclipAvailable() {
  return !!(process.env.PAPERCLIP_API_URL && process.env.PAPERCLIP_API_KEY && process.env.PAPERCLIP_COMPANY_ID);
}

const TOOLS = [
  {
    name: 'paperclip_get_dashboard',
    description: 'Get the Paperclip company dashboard with open issues, agent activity, and project summaries.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'paperclip_list_issues',
    description: 'List issues from Paperclip. Can filter by status, assignee, priority, or search query.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: todo, in_progress, in_review, blocked, done, cancelled, backlog' },
        q: { type: 'string', description: 'Search query to filter issues by title/description' },
        priority: { type: 'string', description: 'Filter by priority: critical, high, medium, low' },
        assigneeAgentId: { type: 'string', description: 'Filter by agent ID' },
      },
      required: [],
    },
  },
  {
    name: 'paperclip_get_issue',
    description: 'Get details of a specific Paperclip issue by its ID or identifier (e.g. SCH-10).',
    input_schema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'The issue ID (UUID) or identifier like SCH-10' },
      },
      required: ['issueId'],
    },
  },
  {
    name: 'paperclip_list_agents',
    description: 'List all agents in the Paperclip company.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'paperclip_update_issue',
    description: 'Update a Paperclip issue — change status, priority, add a comment, or reassign.',
    input_schema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'The issue ID or identifier' },
        status: { type: 'string', description: 'New status: todo, in_progress, in_review, blocked, done, cancelled' },
        priority: { type: 'string', description: 'New priority: critical, high, medium, low' },
        comment: { type: 'string', description: 'Comment to add to the issue' },
        title: { type: 'string', description: 'New title' },
      },
      required: ['issueId'],
    },
  },
  {
    name: 'paperclip_create_issue',
    description: 'Create a new issue in Paperclip.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Issue title' },
        description: { type: 'string', description: 'Issue description (markdown)' },
        status: { type: 'string', description: 'Initial status (default: todo)' },
        priority: { type: 'string', description: 'Priority: critical, high, medium, low' },
        assigneeAgentId: { type: 'string', description: 'Agent ID to assign to' },
      },
      required: ['title'],
    },
  },
  {
    name: 'paperclip_get_comments',
    description: 'Get all comments on a Paperclip issue.',
    input_schema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'The issue ID or identifier' },
      },
      required: ['issueId'],
    },
  },
];

module.exports = { executeTool, isPaperclipAvailable, TOOLS };
