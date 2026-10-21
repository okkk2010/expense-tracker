import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';

const providerKeys = ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'];
let previousProvider;
beforeEach(() => {
  previousProvider = Object.fromEntries(providerKeys.map(key => [key, process.env[key]]));
  for (const key of providerKeys) delete process.env[key];
});
afterEach(() => {
  for (const key of providerKeys) {
    if (previousProvider[key] === undefined) delete process.env[key];
    else process.env[key] = previousProvider[key];
  }
});

async function temporaryApp(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'moa-api-'));
  let app;
  t.after(async () => {
    if (app) await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const options = {
    dbPath: join(directory, 'ledger.sqlite3'), accessToken: '',
    corsOrigins: ['http://127.0.0.1:5173'], environment: 'development',
    restoreMaxBytes: 10 * 1024 * 1024, ...overrides,
  };
  app = await createApp(options);
  return { app, options };
}

function transaction(changes = {}) {
  return {
    date: '2026-10-05', amount: 10000, kind: 'expense', account_id: 'account-kb',
    category_id: 'category-food', tag_ids: [], note: '점심', ...changes,
  };
}

async function request(app, method, url, payload, status = 200, headers = {}) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers });
  assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);
  return status === 204 ? undefined : response.json();
}
const get = (app, url) => request(app, 'GET', url);
async function create(app, ...items) {
  return (await request(app, 'POST', '/api/transactions/batch', { items }, 201)).items;
}
async function tag(app, name) {
  return (await request(app, 'POST', '/api/tags', { name, color: '#123abc' }, 201)).id;
}

test('a fresh database has four agreed accounts and no sample transactions', async t => {
  const { app } = await temporaryApp(t);
  const bootstrap = await get(app, '/api/bootstrap');
  assert.deepEqual(bootstrap.accounts.map(account => account.name), ['기업은행', '국민카드', '토스 카드', '여유 생활비']);
  assert.deepEqual(await get(app, '/api/transactions'), { items: [], total: 0 });
  const dashboard = await get(app, '/api/dashboard?month=2026-10');
  assert.equal(dashboard.total_expense, 0);
  assert.equal(dashboard.transaction_count, 0);
  assert.equal(dashboard.daily.length, 31);
});

test('batch writes are atomic and repeated tag IDs are stored once', async t => {
  const { app } = await temporaryApp(t);
  const firstTag = await tag(app, '외식');
  await request(app, 'POST', '/api/transactions/batch', { items: [
    transaction({ tag_ids: [firstTag, firstTag] }), transaction({ account_id: 'missing' }),
  ] }, 422);
  assert.equal((await get(app, '/api/transactions')).total, 0);
  const items = await create(app, transaction({ tag_ids: [firstTag, firstTag] }), transaction());
  assert.deepEqual(items[0].tag_ids, [firstTag]);
  assert.equal(items.length, 2);
});

test('transaction validation rejects invalid dates, values, types and references', async t => {
  const { app } = await temporaryApp(t);
  for (const changes of [
    { date: '2026-02-30' }, { date: 0 }, { date: '2026-10-05T00:00:00' },
    { amount: -1 }, { amount: 1.5 }, { amount: true }, { kind: 'refund' },
    { category_id: 'missing' }, { tag_ids: ['missing'] },
  ]) {
    await request(app, 'POST', '/api/transactions/batch', { items: [transaction(changes)] }, 422);
  }
  assert.equal((await get(app, '/api/transactions')).total, 0);
  const [item] = await create(app, transaction());
  await request(app, 'PATCH', `/api/transactions/${item.id}`, { version: 1, note: null }, 422);
});

test('transaction updates and deletes require the current version', async t => {
  const { app } = await temporaryApp(t);
  const [item] = await create(app, transaction());
  const path = `/api/transactions/${item.id}`;
  const saved = await request(app, 'PATCH', path, { version: 1, amount: 12000 });
  assert.equal(saved.version, 2);
  assert.equal(saved.amount, 12000);
  const stale = await request(app, 'PATCH', path, { version: 1, amount: 9000 }, 409);
  assert.equal(stale.detail.current.amount, 12000);
  assert.equal(stale.detail.submitted.amount, 9000);
  await request(app, 'DELETE', `${path}?version=1`, undefined, 409);
  await request(app, 'DELETE', `${path}?version=2`, undefined, 204);
  assert.equal((await get(app, '/api/transactions')).total, 0);
});

test('OR and AND tag filters do not duplicate totals, and limit does not change total count', async t => {
  const { app } = await temporaryApp(t);
  const first = await tag(app, '친구');
  const second = await tag(app, '외식');
  await create(app, transaction({ tag_ids: [first, second] }),
    transaction({ tag_ids: [first], amount: 5000 }), transaction({ tag_ids: [second], amount: 2000 }));
  const query = `/api/transactions?tag_ids=${first},${second}`;
  const either = await get(app, `${query}&tag_mode=or`);
  const both = await get(app, `${query}&tag_mode=and`);
  assert.equal(either.total, 3);
  assert.equal(either.items.reduce((sum, item) => sum + item.amount, 0), 17000);
  assert.equal(both.total, 1);
  await request(app, 'GET', '/api/transactions?start=2026-10-06&end=2026-10-01', undefined, 422);
  const limited = await get(app, '/api/transactions?start=2026-10-05&end=2026-10-05&limit=1');
  assert.equal(limited.total, 3);
  assert.equal(limited.items.length, 1);
});

test('budgets inherit only amounts and preserve explicit future overrides', async t => {
  const { app } = await temporaryApp(t);
  const selectedTag = await tag(app, '생활비');
  const path = `/api/budgets/${selectedTag}`;
  await request(app, 'PUT', `${path}/2026-10`, { amount: 100000 });
  await request(app, 'PUT', `${path}/2026-12`, { amount: 80000 });
  await create(app, transaction({ amount: 150000, tag_ids: [selectedTag] }));
  const october = (await get(app, '/api/budgets?month=2026-10')).items[0];
  const november = (await get(app, '/api/budgets?month=2026-11')).items[0];
  assert.equal(october.remaining, -50000);
  assert.equal(november.amount, 100000);
  assert.equal(november.remaining, 100000);
  assert.equal(november.inherited, true);
  assert.equal(november.from_month, '2026-10');
  await request(app, 'PUT', `${path}/2026-10`, { amount: 120000 });
  assert.equal((await get(app, '/api/budgets?month=2026-11')).items[0].amount, 120000);
  assert.equal((await get(app, '/api/budgets?month=2026-12')).items[0].amount, 80000);
  await request(app, 'DELETE', `${path}/2026-12`, undefined, 204);
  assert.equal((await get(app, '/api/budgets?month=2026-12')).items[0].amount, 120000);
  await request(app, 'PUT', `${path}/2026-11`, { amount: 0 });
  assert.deepEqual((await get(app, '/api/budgets?month=2026-11')).items, []);
});

test('dashboard sums expenses by actual dates without income or transfers', async t => {
  const { app } = await temporaryApp(t);
  await create(app, transaction({ amount: 10000 }), transaction({ amount: 2000, date: '2026-10-06' }),
    transaction({ amount: 3000000, kind: 'income' }), transaction({ amount: 80000, kind: 'transfer' }),
    transaction({ amount: 5000, date: '2026-09-30' }));
  const result = await get(app, '/api/dashboard?month=2026-10');
  assert.equal(result.total_expense, 12000);
  assert.equal(result.transaction_count, 2);
  assert.equal(result.previous_expense, 5000);
  assert.equal(result.by_category.reduce((sum, item) => sum + item.total, 0), 12000);
  assert.equal(result.by_account.reduce((sum, item) => sum + item.total, 0), 12000);
  assert.equal(result.daily.find(item => item.date === '2026-10-05').total, 10000);
  await request(app, 'GET', '/api/dashboard?month=2026-13', undefined, 422);
  await request(app, 'GET', '/api/transactions?start=0', undefined, 422);
});

test('archiving a tag preserves history; detaching removes links and increments transaction versions', async t => {
  const { app } = await temporaryApp(t);
  const selectedTag = await tag(app, '여가');
  const [item] = await create(app, transaction({ tag_ids: [selectedTag] }));
  await request(app, 'PUT', `/api/budgets/${selectedTag}/2026-10`, { amount: 50000 });
  await request(app, 'DELETE', `/api/tags/${selectedTag}`, undefined, 204);
  assert.equal((await get(app, '/api/bootstrap')).tags[0].archived, true);
  assert.deepEqual((await get(app, '/api/transactions')).items[0].tag_ids, [selectedTag]);
  await request(app, 'DELETE', `/api/tags/${selectedTag}?mode=detach`, undefined, 204);
  const updated = (await get(app, '/api/transactions')).items[0];
  assert.deepEqual(updated.tag_ids, []);
  assert.equal(updated.version, item.version + 1);
  assert.deepEqual((await get(app, '/api/budgets?month=2026-10')).items, []);
});

test('saved workspaces preserve snapshots, reject stale updates and support copies', async t => {
  const { app } = await temporaryApp(t);
  const snapshot = {
    cards: [{ id: 'card1', kind: 'metric', data: [{ label: '지출', value: 12345 }] }],
    filters: { start: '2026-10-01' }, layout: ['card1'],
  };
  const created = await request(app, 'POST', '/api/workspaces', { title: '10월 분석', snapshot }, 201);
  await create(app, transaction({ amount: 999 }));
  assert.deepEqual((await get(app, '/api/workspaces')).items[0].snapshot, snapshot);
  const body = { title: '수정', snapshot: { ...snapshot, request_summary: '수정' }, version: 1 };
  assert.equal((await request(app, 'PUT', `/api/workspaces/${created.id}`, body)).version, 2);
  await request(app, 'PUT', `/api/workspaces/${created.id}`, body, 409);
  const copied = await request(app, 'POST', '/api/workspaces', { title: '복사본', snapshot }, 201);
  assert.notEqual(copied.id, created.id);
  await request(app, 'DELETE', `/api/workspaces/${copied.id}`, undefined, 204);
});

test('backup restore validates references and duplicate IDs atomically without exposing secrets', async t => {
  const { app } = await temporaryApp(t);
  const selectedTag = await tag(app, '예산');
  await create(app, transaction({ tag_ids: [selectedTag] }));
  await request(app, 'PUT', `/api/budgets/${selectedTag}/2026-10`, { amount: 90000 });
  await request(app, 'POST', '/api/workspaces', { title: '보관', snapshot: { cards: [{ value: 10000 }] } }, 201);
  const saved = await get(app, '/api/backup');
  assert.deepEqual(saved.settings, {});
  assert.ok(!JSON.stringify(saved).includes('access_token'));
  const invalid = structuredClone(saved);
  invalid.transactions[0].account_id = 'missing';
  await request(app, 'POST', '/api/restore', invalid, 422);
  assert.equal((await get(app, '/api/transactions')).total, 1);
  const duplicate = structuredClone(saved);
  duplicate.tags.push(duplicate.tags[0]);
  await request(app, 'POST', '/api/restore', duplicate, 422);
  await create(app, transaction({ amount: 500 }));
  assert.deepEqual(await request(app, 'POST', '/api/restore', saved), { restored: true });
  const after = await get(app, '/api/backup');
  for (const collection of ['accounts', 'categories', 'tags', 'transactions', 'budgets', 'workspaces']) {
    assert.deepEqual(after[collection], saved[collection], collection);
  }
});

test('oversized restore bodies are rejected without deleting existing data', async t => {
  const { app, options } = await temporaryApp(t);
  await create(app, transaction());
  const saved = await get(app, '/api/backup');
  await app.close();
  const limited = await createApp({ ...options, restoreMaxBytes: 64 });
  try {
    await request(limited, 'POST', '/api/restore', saved, 413);
    assert.equal((await get(limited, '/api/transactions')).total, 1);
  } finally {
    await limited.close();
  }
});

test('production authentication and explicit CORS protect private endpoints while health remains public', async t => {
  const { app } = await temporaryApp(t, {
    accessToken: 'private-token', environment: 'production', corsOrigins: ['https://my-ledger.vercel.app'],
  });
  assert.equal((await get(app, '/api/health')).auth_required, true);
  await request(app, 'GET', '/api/bootstrap', undefined, 401);
  await request(app, 'GET', '/api/bootstrap', undefined, 200, { authorization: 'Bearer private-token' });
  await request(app, 'GET', '/api/bootstrap', undefined, 401, { authorization: 'Bearer incorrect-token' });
  const allowed = await app.inject({ method: 'OPTIONS', url: '/api/bootstrap', headers: {
    origin: 'https://my-ledger.vercel.app', 'access-control-request-method': 'GET',
  } });
  assert.equal(allowed.headers['access-control-allow-origin'], 'https://my-ledger.vercel.app');
  const denied = await app.inject({ method: 'OPTIONS', url: '/api/bootstrap', headers: {
    origin: 'https://other.example', 'access-control-request-method': 'GET',
  } });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  const backup = await request(app, 'GET', '/api/backup', undefined, 200, { authorization: 'Bearer private-token' });
  assert.ok(!JSON.stringify(backup).includes('private-token'));
  await assert.rejects(async () => {
    const unsafe = await createApp({
      dbPath: ':memory:', accessToken: '', environment: 'production',
      corsOrigins: ['https://my-ledger.vercel.app'], restoreMaxBytes: 1024,
    });
    await unsafe.close();
  }, /APP_ACCESS_TOKEN/);
});

test('analysis route uses real filtered expenses and preserves the selected workspace tag scope', async t => {
  const { app } = await temporaryApp(t);
  const selectedTag = await tag(app, '데이트');
  const [item] = await create(app, transaction({ amount: 10000, tag_ids: [selectedTag] }));
  await create(app, transaction({ amount: 99999 }), transaction({ kind: 'income', tag_ids: [selectedTag] }));
  const result = await request(app, 'POST', '/api/analysis', {
    prompt: '합계', filters: { start: '2026-10-01', end: '2026-10-31' },
    reference: { filters: { start: '2026-09-01', end: '2026-09-30', tag_ids: [selectedTag] } },
  });
  assert.equal(result.status, 'complete');
  assert.equal(result.provider, 'rules');
  assert.equal(result.cards[0].data[0].value, 10000);
  assert.deepEqual(result.cards[0].metadata.transaction_ids, [item.id]);
});

test('deleted tags and intentionally empty restored collections remain empty after restarting', async t => {
  const { app: first, options } = await temporaryApp(t);
  const selectedTag = await tag(first, '삭제할 태그');
  await create(first, transaction({ tag_ids: [selectedTag] }));
  await request(first, 'DELETE', `/api/tags/${selectedTag}?mode=detach`, undefined, 204);
  assert.deepEqual((await get(first, '/api/bootstrap')).tags, []);
  await first.close();
  const restarted = await createApp(options);
  try {
    assert.deepEqual((await get(restarted, '/api/bootstrap')).tags, []);
    assert.deepEqual((await get(restarted, '/api/transactions')).items[0].tag_ids, []);
    const saved = await get(restarted, '/api/backup');
    for (const collection of ['accounts', 'categories', 'tags', 'transactions', 'budgets', 'workspaces']) saved[collection] = [];
    assert.deepEqual(await request(restarted, 'POST', '/api/restore', saved), { restored: true });
  } finally {
    await restarted.close();
  }
  const restored = await createApp(options);
  try {
    const bootstrap = await get(restored, '/api/bootstrap');
    assert.deepEqual(bootstrap.tags, []);
    assert.deepEqual(bootstrap.accounts, []);
    assert.deepEqual(bootstrap.categories, []);
    assert.deepEqual((await get(restored, '/api/transactions')).items, []);
  } finally {
    await restored.close();
  }
});
