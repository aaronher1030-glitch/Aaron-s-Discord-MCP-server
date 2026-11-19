import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const EPOCH = 1420070400000n;

function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  let stderr = '';
  const waiters = new Map();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w.resolve(msg); }
    }
  });
  let id = 0;
  return {
    stderr: () => stderr,
    request(method, params) {
      const rid = ++id;
      const p = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout: ${method}\n${stderr}`)), 15000);
        waiters.set(rid, { resolve: (m) => { clearTimeout(timer); resolve(m); } });
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rid, method, params }) + '\n');
      return p;
    },
    close() { child.kill(); },
  };
}

async function mockDiscord(routes) {
  const seen = [];
  const srv = createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    seen.push({ method: req.method, pathname: url.pathname, search: url.search, auth: req.headers.authorization });
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'not found' }));
      return;
    }
    Promise.resolve(handler(url, req)).then(({ status = 200, body }) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address();
  return { base: `http://127.0.0.1:${port}`, seen, close: () => srv.close() };
}

const sf = (iso) => ((BigInt(Date.parse(iso)) - EPOCH) << 22n).toString();

test('initialize echoes protocol version and tools/list exposes the five tools', async () => {
  const s = startServer({ DISCORD_TOKEN: '' });
  try {
    const init = await s.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'discord-mcp-lite');

    const list = await s.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'find_channel',
      'list_channels',
      'list_guilds',
      'list_threads',
      'read_messages',
    ]);
  } finally {
    s.close();
  }
});

test('tool calls without a token fail with a clear message and no network access', async () => {
  const s = startServer({ DISCORD_TOKEN: '' });
  try {
    await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const resp = await s.request('tools/call', { name: 'list_guilds', arguments: {} });
    assert.equal(resp.result.isError, true);
    assert.match(resp.result.content[0].text, /DISCORD_TOKEN/);
  } finally {
    s.close();
  }
});

test('read_messages paginates past 100, filters by since, and renders chronologically', async () => {
  const messages = Array.from({ length: 120 }, (_, i) => {
    const t = Date.parse('2026-11-18T09:00:00Z') + i * 60000;
    return {
      id: ((BigInt(t) - EPOCH) << 22n).toString(),
      content: `msg ${i}`,
      author: { username: `user${i}` },
    };
  }).reverse();

  const mock = await mockDiscord({
    'GET /channels/10/messages': (url) => {
      const limit = Number(url.searchParams.get('limit') || '50');
      const before = url.searchParams.get('before');
      let list = messages;
      if (before) list = messages.filter((m) => BigInt(m.id) < BigInt(before));
      return { body: list.slice(0, Math.min(limit, 100)) };
    },
  });
  const s = startServer({ DISCORD_TOKEN: 'test-token', DISCORD_API_BASE: mock.base });
  try {
    await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const resp = await s.request('tools/call', {
      name: 'read_messages',
      arguments: { channel_id: '10', limit: 120 },
    });
    const text = resp.result.content[0].text;
    assert.notEqual(resp.result.isError, true, text);
    const lines = text.split('\n').filter((l) => l.startsWith('['));
    assert.equal(lines.length, 120);
    assert.match(lines[0], /msg 0\b/);
    assert.match(lines[119], /msg 119\b/);
    assert.match(text, /Oldest id:/);
    assert.equal(mock.seen[0].auth, 'Bot test-token');

    const filtered = await s.request('tools/call', {
      name: 'read_messages',
      arguments: { channel_id: '10', limit: 500, since: '2026-11-18T09:02:30Z' },
    });
    const lines2 = filtered.result.content[0].text.split('\n').filter((l) => l.startsWith('['));
    assert.equal(lines2.length, 117);
    assert.match(lines2[0], /msg 3\b/);
  } finally {
    s.close();
    mock.close();
  }
});

test('429 responses are retried after the advertised delay', async () => {
  let calls = 0;
  const mock = await mockDiscord({
    'GET /guilds': () => {
      calls += 1;
      if (calls === 1) return { status: 429, body: { retry_after: 0.05, global: false } };
      return { body: [{ id: '1', name: 'BetterGov' }] };
    },
  });
  const s = startServer({ DISCORD_TOKEN: 'test-token', DISCORD_API_BASE: mock.base });
  try {
    await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const started = Date.now();
    const resp = await s.request('tools/call', { name: 'list_guilds', arguments: {} });
    assert.notEqual(resp.result.isError, true);
    assert.match(resp.result.content[0].text, /BetterGov/);
    assert.equal(calls, 2);
    assert.ok(Date.now() - started >= 100, 'expected retry_after to be honoured');
  } finally {
    s.close();
    mock.close();
  }
});

test('find_channel searches every guild when no guild_id is given', async () => {
  const mock = await mockDiscord({
    'GET /guilds': () => ({ body: [{ id: '1', name: 'BetterGov' }, { id: '2', name: 'Other' }] }),
    'GET /guilds/1/channels': () => ({
      body: [
        { id: '4', name: 'Community', type: 4 },
        { id: '10', name: 'general', type: 0, parent_id: '4' },
        { id: '11', name: 'tax-discussion', type: 0, parent_id: '4' },
      ],
    }),
    'GET /guilds/2/channels': () => ({
      body: [{ id: '20', name: 'tax-help', type: 0 }],
    }),
  });
  const s = startServer({ DISCORD_TOKEN: 'test-token', DISCORD_API_BASE: mock.base });
  try {
    await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const resp = await s.request('tools/call', {
      name: 'find_channel',
      arguments: { query: 'tax' },
    });
    const text = resp.result.content[0].text;
    assert.match(text, /tax-discussion/);
    assert.match(text, /tax-help/);
    assert.match(text, /BetterGov/);
    assert.doesNotMatch(text, /general/);
  } finally {
    s.close();
    mock.close();
  }
});

test('find_channel surfaces auth failures instead of reporting no matches', async () => {
  const mock = await mockDiscord({
    'GET /guilds/1/channels': () => ({ status: 401, body: { message: '401: Unauthorized', code: 0 } }),
  });
  const s = startServer({ DISCORD_TOKEN: 'bad-token', DISCORD_API_BASE: mock.base });
  try {
    await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const resp = await s.request('tools/call', {
      name: 'find_channel',
      arguments: { query: 'tax', guild_id: '1' },
    });
    assert.equal(resp.result.isError, true);
    assert.match(resp.result.content[0].text, /401/);
  } finally {
    s.close();
    mock.close();
  }
});

test('list_threads reads active guild threads and archived threads for a channel', async () => {
  const mock = await mockDiscord({
    'GET /guilds/1/threads/active': () => ({
      body: {
        threads: [{ id: '900', name: 'tax talk', parent_id: '11', type: 11 }],
        members: [],
      },
    }),
    'GET /channels/11/threads/archived/public': () => ({
      body: {
        threads: [{ id: '901', name: 'old tax thread', parent_id: '11', type: 11 }],
        members: [],
        has_more: false,
      },
    }),
  });
  const s = startServer({ DISCORD_TOKEN: 'test-token', DISCORD_API_BASE: mock.base });
  try {
    await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const active = await s.request('tools/call', {
      name: 'list_threads',
      arguments: { guild_id: '1' },
    });
    assert.match(active.result.content[0].text, /tax talk/);

    const both = await s.request('tools/call', {
      name: 'list_threads',
      arguments: { guild_id: '1', channel_id: '11' },
    });
    assert.match(both.result.content[0].text, /old tax thread/);
  } finally {
    s.close();
    mock.close();
  }
});

test('list_channels hides categories and voice channels but keeps their names as context', async () => {
  const mock = await mockDiscord({
    'GET /guilds/1/channels': () => ({
      body: [
        { id: '4', name: 'Community', type: 4 },
        { id: '10', name: 'general', type: 0, parent_id: '4' },
        { id: '12', name: 'Voice', type: 2, parent_id: '4' },
        { id: '13', name: 'announce', type: 5 },
      ],
    }),
  });
  const s = startServer({ DISCORD_TOKEN: 'test-token', DISCORD_API_BASE: mock.base });
  try {
    await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    const resp = await s.request('tools/call', {
      name: 'list_channels',
      arguments: { guild_id: '1' },
    });
    const text = resp.result.content[0].text;
    assert.match(text, /#general/);
    assert.match(text, /under Community/);
    assert.match(text, /#announce/);
    assert.doesNotMatch(text, /#Voice/);
  } finally {
    s.close();
    mock.close();
  }
});
