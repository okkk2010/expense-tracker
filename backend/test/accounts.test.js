import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app.js';

async function temporaryApp(t, overrides = {}, initialize) {
  const directory = await mkdtemp(join(tmpdir(), 'moa-accounts-'));
  const options = {
    dbPath: join(directory, 'ledger.sqlite3'), accessToken: '', environment: 'development',
    corsOrigins: ['http://127.0.0.1:5173'], restoreMaxBytes: 10 * 1024 * 1024, ...overrides,
  };
  const opened = new Set();
  t.after(async () => {
    for (const app of opened) await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  if (initialize) initialize(options.dbPath);
  let app = await createApp(options);
  opened.add(app);
  return {
    app,
    async restart() {
      await app.close();
      opened.delete(app);
      app = await createApp(options);
      opened.add(app);
      return app;
    },
  };
}

async function request(app, method, url, payload, status = 200, headers = {}) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers });
  assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);
  return status === 204 ? undefined : response.json();
}
const get = (app, url) => request(app, 'GET', url);
const accountBody = (changes = {}) => ({ name: '사용자 금융수단', description: '직접 정한 용도', color: '#123abc', ...changes });
const addAccount = (app, changes = {}) => request(app, 'POST', '/api/accounts', accountBody(changes), 201);
const transaction = (accountId, changes = {}) => ({
  date: '2026-10-05', amount: 12000, kind: 'expense', account_id: accountId,
  category_id: 'category-food', tag_ids: [], note: '사용자 기록', ...changes,
});
async function addTransaction(app, accountId, changes = {}) {
  return (await request(app, 'POST', '/api/transactions/batch', { items: [transaction(accountId, changes)] }, 201)).items[0];
}

test('custom account edits preserve its ID and update bootstrap, transaction names and monthly totals', async t => {
  const { app } = await temporaryApp(t);
  const created = await addAccount(app);
  assert.equal(created.archived, false);
  assert.ok(created.id);
  const item = await addTransaction(app, created.id);
  const edited = await request(app, 'PATCH', `/api/accounts/${created.id}`, accountBody({
    name: '이름을 바꾼 카드', description: '새로운 역할', color: '#abcdef',
  }));
  assert.equal(edited.id, created.id);
  assert.equal(edited.name, '이름을 바꾼 카드');
  assert.equal(edited.description, '새로운 역할');
  assert.equal(edited.color, '#abcdef');
  const bootstrap = await get(app, '/api/bootstrap');
  assert.deepEqual(bootstrap.accounts.find(account => account.id === created.id), edited);
  const saved = (await get(app, `/api/transactions?account_id=${created.id}`)).items[0];
  assert.equal(saved.id, item.id);
  assert.equal(saved.account_name, edited.name);
  assert.equal(saved.amount, item.amount);
  const summary = (await get(app, '/api/dashboard?month=2026-10')).by_account.find(account => account.id === created.id);
  assert.equal(summary.name, edited.name);
  assert.equal(summary.description, edited.description);
  assert.equal(summary.color, edited.color);
  assert.equal(summary.total, 12000);
});

test('archived accounts retain history and original-record edits while rejecting new assignments atomically', async t => {
  const { app } = await temporaryApp(t);
  const original = await addAccount(app, { name: '기록을 남긴 카드' });
  const other = await addAccount(app, { name: '다른 보관 카드' });
  const item = await addTransaction(app, original.id);
  await request(app, 'PATCH', `/api/accounts/${original.id}`, { archived: true });
  await request(app, 'PATCH', `/api/accounts/${other.id}`, { archived: true });
  const archived = (await get(app, '/api/bootstrap')).accounts.find(account => account.id === original.id);
  assert.equal(archived.archived, true);
  const history = await get(app, `/api/transactions?account_id=${original.id}`);
  assert.equal(history.total, 1);
  assert.equal(history.items[0].id, item.id);
  const updated = await request(app, 'PATCH', `/api/transactions/${item.id}`, { version: item.version, note: '보관 후 메모 수정' });
  assert.equal(updated.account_id, original.id);
  assert.equal(updated.note, '보관 후 메모 수정');
  await request(app, 'PATCH', `/api/transactions/${item.id}`, { version: updated.version, account_id: other.id }, 422);
  await request(app, 'POST', '/api/transactions/batch', { items: [
    transaction('account-kb'), transaction(original.id),
  ] }, 422);
  const after = await get(app, '/api/transactions');
  assert.equal(after.total, 1, 'the valid first batch row must roll back with the archived-account row');
  assert.equal(after.items[0].version, updated.version);
  assert.equal(after.items[0].account_id, original.id);
});

test('dashboard hides idle archived accounts, includes their historical spending and allows new records after unarchiving', async t => {
  const { app } = await temporaryApp(t);
  const spent = await addAccount(app, { name: '과거 지출 카드' });
  const unused = await addAccount(app, { name: '미사용 보관 카드' });
  await addTransaction(app, spent.id, { amount: 30000 });
  await request(app, 'PATCH', `/api/accounts/${spent.id}`, { archived: true });
  await request(app, 'PATCH', `/api/accounts/${unused.id}`, { archived: true });
  const october = await get(app, '/api/dashboard?month=2026-10');
  assert.equal(october.total_expense, 30000);
  assert.equal(october.by_account.find(account => account.id === spent.id).total, 30000);
  assert.equal(october.by_account.some(account => account.id === unused.id), false);
  const november = await get(app, '/api/dashboard?month=2026-11');
  assert.equal(november.by_account.some(account => account.id === spent.id), false);
  const restored = await request(app, 'PATCH', `/api/accounts/${spent.id}`, { archived: false });
  assert.equal(restored.archived, false);
  await addTransaction(app, spent.id, { date: '2026-11-01', amount: 2000 });
  assert.equal((await get(app, '/api/dashboard?month=2026-11')).by_account.find(account => account.id === spent.id).total, 2000);
  assert.equal((await get(app, '/api/transactions')).total, 2);
});

test('only unused accounts can be permanently deleted; referenced account data and transactions remain intact', async t => {
  const { app } = await temporaryApp(t);
  const unused = await addAccount(app, { name: '삭제할 금융수단' });
  await request(app, 'DELETE', `/api/accounts/${unused.id}`, undefined, 204);
  assert.equal((await get(app, '/api/bootstrap')).accounts.some(account => account.id === unused.id), false);
  const referenced = await addAccount(app, { name: '기록이 있는 금융수단' });
  const item = await addTransaction(app, referenced.id, { kind: 'transfer' });
  await request(app, 'DELETE', `/api/accounts/${referenced.id}`, undefined, 409);
  await request(app, 'PATCH', `/api/accounts/${referenced.id}`, { archived: true });
  await request(app, 'DELETE', `/api/accounts/${referenced.id}`, undefined, 409);
  assert.equal((await get(app, '/api/bootstrap')).accounts.find(account => account.id === referenced.id).archived, true);
  assert.equal((await get(app, '/api/transactions')).items[0].id, item.id);
});

test('backups round-trip custom account archive state and accept old account records without archived', async t => {
  const store = await temporaryApp(t);
  let app = store.app;
  const custom = await addAccount(app, { name: '백업 대상', description: '백업에 남길 설명' });
  const item = await addTransaction(app, custom.id);
  await request(app, 'PATCH', `/api/accounts/${custom.id}`, { archived: true });
  const backup = await get(app, '/api/backup');
  assert.equal(backup.accounts.find(account => account.id === custom.id).archived, true);
  const invalid = structuredClone(backup);
  invalid.accounts.find(account => account.id === custom.id).archived = 'true';
  await request(app, 'POST', '/api/restore', invalid, 422);
  assert.equal((await get(app, '/api/transactions')).items[0].id, item.id);
  await request(app, 'PATCH', `/api/accounts/${custom.id}`, { name: '임시 변경', archived: false });
  assert.deepEqual(await request(app, 'POST', '/api/restore', backup), { restored: true });
  app = await store.restart();
  const restored = (await get(app, '/api/backup')).accounts;
  assert.deepEqual(restored, backup.accounts);
  assert.equal((await get(app, '/api/transactions')).items[0].account_id, custom.id);
  const legacyBackup = structuredClone(backup);
  for (const account of legacyBackup.accounts) delete account.archived;
  assert.deepEqual(await request(app, 'POST', '/api/restore', legacyBackup), { restored: true });
  assert.ok((await get(app, '/api/bootstrap')).accounts.every(account => account.archived === false));
  assert.equal((await get(app, '/api/bootstrap')).accounts.find(account => account.id === custom.id).description, '백업에 남길 설명');
  await addTransaction(app, custom.id);
  assert.equal((await get(app, '/api/transactions')).total, 2);
});

test('legacy four-column account databases migrate in place without replacing custom rows or their transactions', async t => {
  const timestamp = '2026-10-01T00:00:00.000Z';
  const store = await temporaryApp(t, {}, path => {
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        CREATE TABLE accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, color TEXT NOT NULL);
        CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL);
        CREATE TABLE transactions (
          id TEXT PRIMARY KEY, date TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount >= 0),
          kind TEXT NOT NULL CHECK(kind IN ('expense','income','transfer')),
          account_id TEXT NOT NULL REFERENCES accounts(id), category_id TEXT NOT NULL REFERENCES categories(id),
          note TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        PRAGMA user_version=1;
      `);
      legacy.prepare('INSERT INTO accounts VALUES (?,?,?,?)').run('legacy-account', '기존 사용자 카드', '기존 역할', '#445566');
      legacy.prepare('INSERT INTO categories VALUES (?,?,?)').run('legacy-category', '기존 종목', '#778899');
      legacy.prepare('INSERT INTO transactions VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run('legacy-transaction', '2026-10-01', 7100, 'expense', 'legacy-account', 'legacy-category', '보존할 기록', 7, timestamp, timestamp);
    } finally { legacy.close(); }
  });
  let app = store.app;
  assert.deepEqual((await get(app, '/api/bootstrap')).accounts, [
    { id: 'legacy-account', name: '기존 사용자 카드', description: '기존 역할', color: '#445566', archived: false },
  ]);
  const item = (await get(app, '/api/transactions')).items[0];
  assert.equal(item.id, 'legacy-transaction');
  assert.equal(item.account_name, '기존 사용자 카드');
  assert.equal(item.amount, 7100);
  assert.equal(item.version, 7);
  assert.equal(item.created_at, timestamp);
  assert.ok(app.database.prepare('PRAGMA table_info(accounts)').all().some(column => column.name === 'archived'));
  await request(app, 'PATCH', '/api/accounts/legacy-account', { archived: true });
  app = await store.restart();
  assert.equal((await get(app, '/api/bootstrap')).accounts.length, 1);
  assert.equal((await get(app, '/api/bootstrap')).accounts[0].archived, true);
  assert.equal((await get(app, '/api/transactions')).items[0].version, 7);
});

test('the initial four accounts are editable removable templates and are not reseeded after deletion or restart', async t => {
  const store = await temporaryApp(t);
  const accounts = (await get(store.app, '/api/bootstrap')).accounts;
  assert.equal(accounts.length, 4);
  assert.ok(accounts.every(account => account.archived === false));
  const edited = await request(store.app, 'PATCH', `/api/accounts/${accounts[0].id}`, { name: '내 방식의 이름', description: '내가 정한 역할' });
  assert.equal(edited.name, '내 방식의 이름');
  assert.equal(edited.description, '내가 정한 역할');
  for (const account of accounts) await request(store.app, 'DELETE', `/api/accounts/${account.id}`, undefined, 204);
  const restarted = await store.restart();
  assert.deepEqual((await get(restarted, '/api/bootstrap')).accounts, []);
  assert.deepEqual((await get(restarted, '/api/dashboard?month=2026-10')).by_account, []);
  const custom = await addAccount(restarted, { name: '유일한 사용자 금융수단' });
  const restartedAgain = await store.restart();
  assert.deepEqual((await get(restartedAgain, '/api/bootstrap')).accounts.map(account => account.id), [custom.id]);
});

test('account input validation and missing IDs leave catalog data unchanged', async t => {
  const { app } = await temporaryApp(t);
  for (const changes of [{ name: '' }, { name: ' ' }, { color: 'red' }, { description: 7 }, { extra: 'unsupported' }]) {
    await request(app, 'POST', '/api/accounts', accountBody(changes), 422);
  }
  await request(app, 'POST', '/api/accounts', { description: '이름 없음', color: '#123abc' }, 422);
  const custom = await addAccount(app);
  for (const payload of [{ name: '' }, { color: '#bad' }, { description: null }, { archived: 'yes' }, { extra: 'unsupported' }]) {
    await request(app, 'PATCH', `/api/accounts/${custom.id}`, payload, 422);
  }
  await request(app, 'PATCH', '/api/accounts/missing', { name: '없는 금융수단' }, 404);
  await request(app, 'DELETE', '/api/accounts/missing', undefined, 404);
  assert.deepEqual((await get(app, '/api/bootstrap')).accounts.find(account => account.id === custom.id), custom);
  assert.equal((await get(app, '/api/bootstrap')).accounts.length, 5);
});

test('private account mutations require the configured personal access token', async t => {
  const { app } = await temporaryApp(t, { environment: 'production', accessToken: 'account-test-personal-key' });
  await request(app, 'POST', '/api/accounts', accountBody(), 401);
  const headers = { authorization: 'Bearer account-test-personal-key' };
  const created = await request(app, 'POST', '/api/accounts', accountBody(), 201, headers);
  await request(app, 'PATCH', `/api/accounts/${created.id}`, { name: '권한 없는 변경' }, 401);
  await request(app, 'DELETE', `/api/accounts/${created.id}`, undefined, 401);
  const bootstrap = await request(app, 'GET', '/api/bootstrap', undefined, 200, headers);
  assert.equal(bootstrap.accounts.find(account => account.id === created.id).name, created.name);
  await request(app, 'DELETE', `/api/accounts/${created.id}`, undefined, 204, headers);
});
