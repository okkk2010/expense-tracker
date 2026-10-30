import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { parseNotification } from '../src/shortcut-parser.js';

const MASTER = 'shortcuts-test-master-credential';
const authorization = token => ({ authorization: `Bearer ${token}` });
const transaction = changes => ({ date: '2026-10-31', amount: 12500, kind: 'expense', account_id: 'account-kb',
  category_id: 'category-food', tag_ids: [], note: '스타벅스', ...changes });
const payment = changes => ({ title: '카드1234 승인', body: '스타벅스에서 12,500원 결제했어요', source_app: 'KB국민카드', ...changes });

async function setup(t, changes = {}) {
  const app = await createApp({ dbPath: ':memory:', accessToken: MASTER, environment: 'development', ...changes });
  t.after(() => app.close());
  return app;
}
async function call(app, method, url, payload, status = 200, token = MASTER) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }),
    ...(token ? { headers: authorization(token) } : {}) });
  assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`);
  return status === 204 ? undefined : response.json();
}
async function connect(app, changes = {}) {
  return call(app, 'POST', '/api/shortcuts/connections', {
    name: '국민카드 알림', source: 'kb', account_id: 'account-kb', ...changes,
  }, 201);
}
const ingest = (app, token, payload, status = 200) => call(app, 'POST', '/api/shortcuts/ingest', payload, status, token);
const events = async (app, suffix = '') => (await call(app, 'GET', `/api/shortcuts/events${suffix}`)).items;
const transactions = async app => (await call(app, 'GET', '/api/transactions')).items;

test('notification parser accepts explicit completed KRW payments and separates balances and Korea transaction time', () => {
  const result = parseNotification({ body: '카드1234 승인\n10/31 13:30\n12,500원\n스타벅스\n잔액 300,000원' },
    { receivedAt: '2026-10-31T05:00:00.000Z' });
  assert.equal(result.amount, 12500);
  assert.equal(result.kind, 'expense');
  assert.equal(result.confidence, true);
  assert.equal(result.date, '2026-10-31');
  assert.equal(result.transaction_time, '2026-10-31T04:30:00.000Z');
  assert.equal(result.hints.card, '1234');
  assert.equal(result.note, '스타벅스');
  const korea = parseNotification({ body: '스타벅스에서 12,500원 결제했어요' },
    { receivedAt: '2026-10-31T02:00:00Z', occurredAt: '2026-10-30T23:30:00Z' });
  assert.equal(korea.date, '2026-10-31');
});

test('notification parser keeps refunds, bank movements, settlement, pending, ads and foreign amounts out of automatic expenses', () => {
  for (const body of [
    '카드1234 승인취소 12,500원', '카드1234 환불 12,500원',
    '국민은행 계좌1234 출금 12,500원', '국민은행 입금 12,500원',
    '카드1234 카드대금 결제 12,500원', '계좌1234 송금 12,500원 완료',
    '카드1234 ATM 출금 12,500원', '카드1234 승인 대기 12,500원',
    '카드1234 결제 실패 12,500원', '광고 카드1234 결제하면 12,500원 혜택',
    '카드1234 USD 10.00 승인 원화예상 12,500원', '카드1234 $10 승인 12,500원',
    '카드1234 승인번호 123456 12,500원', '대출 승인 12,500원',
    '카드1234 승인 12,500원 7,000원', '카드1234 승인 잔액 300,000원',
    '카드1234 승인 12,500', '카드1234 승인 -12,500원', '카드1234 승인 −12,500원',
    '카드1234 승인 − 12,500원', '카드1234 승인 - 12,500원', '카드1234 승인 12.5원',
    '카드1234 승인 12,500원 취 소', '카드1234 승인 12,500원 환 불',
    '카드1234 승인 12,500원 취\u200b소',
    '카드1234 승인 0원', '카드1234 승인 12,500원 2026-02-30',
  ]) {
    const result = parseNotification({ body }, { receivedAt: '2026-10-31T05:00:00Z' });
    assert.equal(result.confidence, false, body);
    assert.ok(result.reason, body);
  }
  assert.equal(parseNotification({ body: '승인취소 12,500원' }).kind, 'refund');
  assert.equal(parseNotification({ body: '입금 12,500원' }).kind, 'income');
  assert.equal(parseNotification({ body: '카드대금 출금 12,500원' }).kind, 'transfer');
});

test('shortcut management requires a configured master credential and preserves normal unauthenticated development behavior', async t => {
  const app = await setup(t, { accessToken: '' });
  await call(app, 'GET', '/api/bootstrap', undefined, 200, null);
  await call(app, 'GET', '/api/shortcuts/connections', undefined, 503, null);
  await call(app, 'GET', '/api/shortcuts/events', undefined, 503, null);
  await ingest(app, 'anything', payment(), 503);
});

test('dedicated random ingestion tokens are hashed at rest and cannot access master APIs', async t => {
  const app = await setup(t);
  await call(app, 'POST', '/api/shortcuts/connections', { name: 'KB', source: 'kb' }, 422);
  await call(app, 'GET', '/api/shortcuts/connections', undefined, 401, null);
  const created = await connect(app);
  const another = await connect(app);
  assert.match(created.token, /^moa_sc_/);
  assert.notEqual(created.token, another.token);
  const stored = app.database.prepare('SELECT token_hash FROM shortcut_connections WHERE id=?').get(created.connection.id);
  assert.notEqual(stored.token_hash, created.token);
  assert.match(stored.token_hash, /^[a-f0-9]{64}$/);
  const listed = await call(app, 'GET', '/api/shortcuts/connections');
  assert.equal(created.connection.auto_record, false);
  assert.ok(!JSON.stringify(listed).includes(created.token));
  assert.ok(!JSON.stringify(listed).includes('token_hash'));
  await call(app, 'GET', '/api/bootstrap', undefined, 401, created.token);
  await call(app, 'GET', '/api/shortcuts/events', undefined, 401, created.token);
  await ingest(app, MASTER, payment(), 401);
  await ingest(app, '', payment(), 401);
  await call(app, 'GET', '/api/shortcuts/ingest', undefined, 401, created.token);
});

test('request logging redacts bearer credentials even when a custom request serializer includes headers', async t => {
  let logOutput = '';
  const app = await setup(t, { logger: {
    stream: { write: chunk => { logOutput += chunk; } },
    serializers: { req: request => ({ method: request.method, url: request.url, headers: request.headers }) },
  } });
  const created = await connect(app);
  await ingest(app, created.token, payment());
  app.log.info({ token: created.token, token_hash: 'do-not-log-this-hash' });
  assert.ok(logOutput.length > 0);
  assert.ok(!logOutput.includes(MASTER));
  assert.ok(!logOutput.includes(created.token));
  assert.ok(!logOutput.includes('do-not-log-this-hash'));
});

test('user-created bank account stays distinct from seeded credit card and mapping is explicit', async t => {
  const app = await setup(t);
  const account = await call(app, 'POST', '/api/accounts', { name: '국민은행', description: '입출금 통장' }, 201);
  assert.notEqual(account.id, 'account-kb');
  assert.equal(account.color, '#64748b');
  const created = await connect(app, { name: '국민은행 문자', account_id: account.id });
  await ingest(app, created.token, { body: '국민은행 출금 12,500원' });
  const [item] = await events(app);
  assert.equal(item.parsed.account_id, account.id);
  assert.equal(item.status, 'pending');
  assert.equal((await transactions(app)).length, 0);
  await connect(app, { account_id: 'missing' }).then(() => assert.fail('missing account accepted'), error => {
    assert.match(error.message, /422/);
  });
});

test('archived financial accounts reject new shortcut mappings and review writes while preserving imported history', async t => {
  const app = await setup(t);
  const account = await call(app, 'POST', '/api/accounts', { name: '보관할 카드' }, 201);
  const created = await connect(app, { account_id: account.id, auto_record: true, match_text: '1234' });
  const original = await ingest(app, created.token, payment({ event_id: 'before-archive' }));
  assert.equal(original.status, 'recorded');
  await call(app, 'PATCH', `/api/accounts/${account.id}`, { archived: true });
  await call(app, 'POST', '/api/shortcuts/connections', {
    name: '잘못된 연결', source: 'kb', account_id: account.id,
  }, 422);
  const pending = await ingest(app, created.token, payment({ event_id: 'after-archive' }));
  assert.equal(pending.status, 'pending');
  assert.match(pending.message, /보관된 금융수단/);
  await call(app, 'POST', `/api/shortcuts/events/${pending.event_id}/record`, {
    transaction: transaction({ account_id: account.id }),
  }, 422);
  assert.equal((await transactions(app)).length, 1);
  assert.equal((await events(app, '?status=pending')).length, 1);
  const replay = await call(app, 'POST', `/api/shortcuts/events/${original.event_id}/record`, {
    transaction: transaction({ account_id: account.id }),
  });
  assert.equal(replay.transaction.id, original.transaction_id);
  const path = `/api/shortcuts/connections/${created.connection.id}`;
  await call(app, 'PATCH', path, { enabled: false });
  await call(app, 'PATCH', path, { enabled: true }, 422);
  await call(app, 'PATCH', path, { account_id: account.id, enabled: false }, 422);
  const backup = await call(app, 'GET', '/api/backup');
  assert.equal(backup.accounts.find(item => item.id === account.id).archived, true);
  await call(app, 'POST', '/api/restore', backup);
  assert.equal((await call(app, 'GET', '/api/bootstrap')).accounts.find(item => item.id === account.id).archived, true);
  assert.equal((await transactions(app))[0].id, original.transaction_id);
  assert.equal((await call(app, 'GET', '/api/shortcuts/connections')).items[0].enabled, false);
  const other = await call(app, 'POST', '/api/accounts', { name: '사용 중 카드' }, 201);
  const corrected = await call(app, 'POST', `/api/shortcuts/events/${pending.event_id}/record`, {
    transaction: transaction({ account_id: other.id }),
  });
  assert.equal(corrected.transaction.account_id, other.id);
  assert.equal((await transactions(app)).length, 2);
});

test('deleting an unused mapped account disables and unlinks its shortcut without deleting review history', async t => {
  const app = await setup(t);
  const account = await call(app, 'POST', '/api/accounts', { name: '삭제할 통장' }, 201);
  const created = await connect(app, { account_id: account.id });
  const received = await ingest(app, created.token, payment({ event_id: 'unused-account-review' }));
  await call(app, 'DELETE', `/api/accounts/${account.id}`, undefined, 204);
  const [unlinked] = (await call(app, 'GET', '/api/shortcuts/connections')).items;
  assert.equal(unlinked.account_id, null);
  assert.equal(unlinked.enabled, false);
  assert.equal(unlinked.auto_record, false);
  await ingest(app, created.token, payment(), 401);
  await call(app, 'PATCH', `/api/shortcuts/connections/${unlinked.id}`, { enabled: true }, 422);
  assert.equal((await events(app))[0].id, received.event_id);
  const backup = await call(app, 'GET', '/api/backup');
  await call(app, 'POST', '/api/restore', backup);
  assert.equal((await events(app))[0].id, received.event_id);
  assert.equal((await transactions(app)).length, 0);
});

test('review is the default; explicit matching, auto-record preference and a real account gate automatic writes', async t => {
  const app = await setup(t);
  const review = await connect(app, { match_text: '1234' });
  await ingest(app, review.token, payment({ event_id: 'review-1' }));
  const noMatchRule = await connect(app, { auto_record: true });
  await ingest(app, noMatchRule.token, payment({ event_id: 'rule-1' }));
  const mismatch = await connect(app, { match_text: '9999', auto_record: true });
  await ingest(app, mismatch.token, payment({ event_id: 'mismatch-1' }));
  assert.equal((await transactions(app)).length, 0);
  assert.equal((await events(app, '?status=pending')).length, 3);
  const automatic = await connect(app, { match_text: '1234', auto_record: true, category_id: 'category-food' });
  const result = await ingest(app, automatic.token, payment({ event_id: 'automatic-1' }));
  assert.equal(result.status, 'recorded');
  assert.ok(result.transaction_id);
  const [saved] = await transactions(app);
  assert.equal(saved.amount, 12500);
  assert.equal(saved.account_id, 'account-kb');
  assert.equal(saved.category_id, 'category-food');
  assert.equal(saved.note, '스타벅스');
});

test('refund, settlement, withdrawal, source mismatch and foreign currency remain durable review items even when auto-record is on', async t => {
  const app = await setup(t);
  const created = await connect(app, { match_text: '1234', auto_record: true });
  const examples = [
    payment({ body: '카드1234 승인취소 12,500원' }),
    payment({ body: '카드1234 환불 12,500원' }),
    payment({ body: '카드1234 카드대금 12,500원 결제 완료' }),
    payment({ body: '카드1234 출금 12,500원' }),
    payment({ source_app: '토스' }),
    payment({ body: '카드1234 해외 USD 10 승인 원화예상 12,500원' }),
  ];
  for (let index = 0; index < examples.length; index += 1) {
    const result = await ingest(app, created.token, { ...examples[index], event_id: `review-${index}` });
    assert.equal(result.status, 'pending');
  }
  assert.equal((await events(app)).length, examples.length);
  assert.equal((await transactions(app)).length, 0);
});

test('exact event IDs and normalized payload plus explicit timestamp deduplicate retries while distinct payments stay separate', async t => {
  const app = await setup(t);
  const created = await connect(app, { match_text: '1234', auto_record: true });
  const occurred_at = new Date(Date.now() - 60_000).toISOString();
  const first = await ingest(app, created.token, payment({ event_id: 'unique-1', occurred_at }));
  const retry = await ingest(app, created.token, payment({ event_id: 'unique-1', occurred_at }));
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.event_id, first.event_id);
  assert.equal(retry.transaction_id, first.transaction_id);
  const distinct = await ingest(app, created.token, payment({ event_id: 'unique-2', occurred_at,
    body: '동네식당에서 12,500원 결제했어요' }));
  assert.equal(distinct.status, 'recorded');
  assert.notEqual(distinct.event_id, first.event_id);
  const noId = await ingest(app, created.token, payment({ occurred_at, body: '동네책방에서 12,500원 결제했어요' }));
  const normalizedRetry = await ingest(app, created.token, payment({ occurred_at,
    body: '  동네책방에서    12,500원 결제했어요\n', source_app: 'kb국민카드' }));
  assert.equal(normalizedRetry.status, 'duplicate');
  assert.equal(normalizedRetry.event_id, noId.event_id);
  assert.equal((await transactions(app)).length, 3);
});

test('reused event ID with changed contents or occurrence time rejects misconfigured shortcuts without losing the original', async t => {
  const app = await setup(t);
  const created = await connect(app, { match_text: '1234', auto_record: true });
  const occurred_at = new Date(Date.now() - 60_000).toISOString();
  const original = await ingest(app, created.token, payment({ event_id: 'constant-id', occurred_at }));
  await ingest(app, created.token, payment({ event_id: 'constant-id', occurred_at,
    body: '다른가게에서 9,000원 결제했어요' }), 409);
  await ingest(app, created.token, payment({ event_id: 'constant-id',
    occurred_at: new Date(Date.parse(occurred_at) + 1000).toISOString() }), 409);
  assert.equal((await events(app)).length, 1);
  assert.equal((await transactions(app)).length, 1);
  assert.equal((await events(app))[0].id, original.event_id);
});

test('same full contents and occurrence with distinct IDs are reviewable rather than double-recorded or discarded', async t => {
  const app = await setup(t);
  const created = await connect(app, { match_text: '1234', auto_record: true });
  const occurred_at = new Date(Date.now() - 60_000).toISOString();
  await ingest(app, created.token, payment({ event_id: 'distinct-a', occurred_at }));
  const second = await ingest(app, created.token, payment({ event_id: 'distinct-b', occurred_at }));
  assert.equal(second.status, 'pending');
  assert.equal((await events(app)).length, 2);
  assert.equal((await transactions(app)).length, 1);
});

test('same body without a source event identity is retained for review instead of collapsing a possibly real second payment', async t => {
  const app = await setup(t);
  const created = await connect(app, { match_text: '1234', auto_record: true });
  assert.equal((await ingest(app, created.token, payment())).status, 'recorded');
  const second = await ingest(app, created.token, payment());
  assert.equal(second.status, 'pending');
  assert.match(second.message, /재전송|별도 거래/);
  assert.equal((await transactions(app)).length, 1);
  assert.equal((await events(app)).length, 2);
});

test('likely same payment across Toss and KB is kept for review and never automatically counted twice', async t => {
  const app = await setup(t);
  const kb = await connect(app, { match_text: '1234', auto_record: true });
  const toss = await connect(app, { name: '토스', source: 'toss', account_id: 'account-toss', match_text: '1234', auto_record: true });
  const occurred_at = new Date(Date.now() - 60_000).toISOString();
  assert.equal((await ingest(app, kb.token, payment({ event_id: 'kb-1', occurred_at }))).status, 'recorded');
  const duplicate = await ingest(app, toss.token, payment({ event_id: 'toss-1', occurred_at, source_app: '토스' }));
  assert.equal(duplicate.status, 'pending');
  assert.match(duplicate.message, /다른 출처|중복/);
  assert.equal((await transactions(app)).length, 1);
});

test('notification occurrence validation rejects invalid or future times and preserves received time separately', async t => {
  const app = await setup(t);
  const created = await connect(app);
  for (const occurred_at of ['yesterday', '2026-02-30T00:00:00Z', '2026-10-31T00:00:00',
    '2026-10-31T25:00:00Z', new Date(Date.now() + 10 * 60_000).toISOString()]) {
    await ingest(app, created.token, payment({ occurred_at }), 422);
  }
  assert.equal((await events(app)).length, 0);
  const occurred_at = new Date(Date.now() - 60_000).toISOString();
  const result = await ingest(app, created.token, payment({ occurred_at }));
  const item = (await events(app))[0];
  assert.equal(item.id, result.event_id);
  assert.equal(item.occurred_at, occurred_at);
  assert.ok(Date.parse(item.received_at) > Date.parse(item.occurred_at));
});

test('ingestion is bounded to 16KB and rejects malformed request shapes without storing them', async t => {
  const app = await setup(t);
  const created = await connect(app);
  await ingest(app, created.token, { body: '가'.repeat(6000) }, 413);
  await ingest(app, created.token, { body: '', access_token: MASTER }, 422);
  await ingest(app, created.token, { body: '승인 12500원', source: 'toss' }, 422);
  assert.equal((await events(app)).length, 0);
});

test('manual correction validates references atomically and record/ignore actions are idempotent', async t => {
  const app = await setup(t);
  const created = await connect(app);
  const received = await ingest(app, created.token, payment({ event_id: 'manual-1' }));
  const path = `/api/shortcuts/events/${received.event_id}`;
  await call(app, 'POST', `${path}/record`, { transaction: transaction({ account_id: 'missing' }) }, 422);
  assert.equal((await events(app))[0].status, 'pending');
  assert.equal((await transactions(app)).length, 0);
  const recorded = await call(app, 'POST', `${path}/record`, { transaction: transaction() });
  const repeat = await call(app, 'POST', `${path}/record`, { transaction: transaction() });
  assert.equal(repeat.transaction.id, recorded.transaction.id);
  assert.equal((await transactions(app)).length, 1);
  await call(app, 'POST', `${path}/ignore`, undefined, 409);
  const second = await ingest(app, created.token, payment({ event_id: 'manual-2' }));
  const secondPath = `/api/shortcuts/events/${second.event_id}`;
  assert.equal((await call(app, 'POST', `${secondPath}/ignore`)).event.status, 'ignored');
  assert.equal((await call(app, 'POST', `${secondPath}/ignore`)).event.status, 'ignored');
  await call(app, 'POST', `${secondPath}/record`, { transaction: transaction() }, 409);
  await call(app, 'GET', '/api/shortcuts/events?limit=501', undefined, 422);
  await call(app, 'GET', '/api/shortcuts/events?status=unknown', undefined, 422);
  assert.equal((await events(app, '?status=recorded&limit=1')).length, 1);
});

test('cancellation and refund review cannot be misrecorded as new income or expense', async t => {
  const app = await setup(t);
  const created = await connect(app);
  for (const body of ['카드1234 승인취소 12,500원', '카드1234 환불 12,500원',
    '카드1234 승인 12,500원 취 소', '카드1234 승인 12,500원 환 불']) {
    const received = await ingest(app, created.token, { body });
    const path = `/api/shortcuts/events/${received.event_id}`;
    await call(app, 'POST', `${path}/record`, { transaction: transaction({ kind: 'income' }) }, 422);
    await call(app, 'POST', `${path}/record`, { transaction: transaction({ kind: 'expense' }) }, 422);
    assert.equal((await call(app, 'POST', `${path}/ignore`)).event.status, 'ignored');
  }
  assert.equal((await transactions(app)).length, 0);
});

test('disabled/deleted connections revoke ingestion, rotation invalidates the old token, and event history survives deletion', async t => {
  const app = await setup(t);
  const created = await connect(app);
  await ingest(app, created.token, payment({ event_id: 'before-delete' }));
  const path = `/api/shortcuts/connections/${created.connection.id}`;
  await call(app, 'PATCH', path, { enabled: false });
  await ingest(app, created.token, payment(), 401);
  await call(app, 'PATCH', path, { enabled: true });
  const rotated = await call(app, 'POST', `${path}/rotate`);
  assert.notEqual(rotated.token, created.token);
  await ingest(app, created.token, payment(), 401);
  await ingest(app, rotated.token, payment({ event_id: 'after-rotate' }));
  await call(app, 'DELETE', path, undefined, 204);
  await ingest(app, rotated.token, payment(), 401);
  assert.equal((await events(app)).length, 2);
  assert.equal((await events(app))[0].connection_name, created.connection.name);
});

test('backup excludes all reusable ingestion credentials and restore disables and rekeys connections while retaining events', async t => {
  const app = await setup(t);
  const created = await connect(app, { match_text: '1234', auto_record: true });
  await ingest(app, created.token, payment({ event_id: 'backup-1' }));
  const noIdTimestamp = new Date(Date.now() - 60_000).toISOString();
  await ingest(app, created.token, payment({ occurred_at: noIdTimestamp }));
  const backup = await call(app, 'GET', '/api/backup');
  const encoded = JSON.stringify(backup);
  assert.ok(!encoded.includes(created.token));
  assert.ok(!encoded.includes(MASTER));
  assert.ok(!encoded.includes('token_hash'));
  assert.equal(backup.shortcuts_connections.length, 1);
  assert.equal(backup.shortcuts_events.length, 2);
  await call(app, 'POST', '/api/restore', backup);
  const [restored] = (await call(app, 'GET', '/api/shortcuts/connections')).items;
  assert.equal(restored.enabled, false);
  assert.equal(restored.auto_record, false);
  assert.equal(app.database.prepare('SELECT token_hash FROM shortcut_connections WHERE id=?').get(restored.id).token_hash, null);
  await ingest(app, created.token, payment(), 401);
  await call(app, 'PATCH', `/api/shortcuts/connections/${restored.id}`, { enabled: true }, 422);
  const rotated = await call(app, 'POST', `/api/shortcuts/connections/${restored.id}/rotate`);
  await call(app, 'PATCH', `/api/shortcuts/connections/${restored.id}`, { enabled: true });
  assert.equal((await ingest(app, rotated.token, payment({ event_id: 'backup-1' }))).status, 'duplicate');
  assert.equal((await ingest(app, rotated.token, payment({ occurred_at: noIdTimestamp }))).status, 'duplicate');
  assert.equal((await transactions(app)).length, 2);
  assert.equal((await events(app)).length, 2);
});

test('archived connection tags require review and detaching tags keeps connection backups restorable', async t => {
  const app = await setup(t);
  const tag = await call(app, 'POST', '/api/tags', { name: '점심' }, 201);
  const created = await connect(app, { match_text: '1234', auto_record: true, tag_ids: [tag.id] });
  const first = await ingest(app, created.token, payment({ event_id: 'tag-1' }));
  assert.equal(first.status, 'recorded');
  await call(app, 'DELETE', `/api/tags/${tag.id}`, undefined, 204);
  assert.equal((await ingest(app, created.token, payment({ event_id: 'tag-2' }))).status, 'pending');
  await call(app, 'DELETE', `/api/tags/${tag.id}?mode=detach`, undefined, 204);
  const saved = await call(app, 'GET', '/api/backup');
  assert.deepEqual(saved.shortcuts_connections[0].tag_ids, []);
  await call(app, 'POST', '/api/restore', saved);
  assert.equal((await events(app)).length, 2);
});

test('optional ingestion backup fields preserve compatibility, and invalid references or injected credentials cannot partially restore', async t => {
  const app = await setup(t);
  const created = await connect(app);
  await ingest(app, created.token, payment());
  const backup = await call(app, 'GET', '/api/backup');
  const badReference = structuredClone(backup);
  badReference.shortcuts_connections[0].account_id = 'missing';
  await call(app, 'POST', '/api/restore', badReference, 422);
  assert.equal((await events(app)).length, 1);
  const leakedCredential = structuredClone(backup);
  leakedCredential.shortcuts_connections[0].token_hash = 'invalid';
  await call(app, 'POST', '/api/restore', leakedCredential, 422);
  const legacy = structuredClone(backup);
  delete legacy.shortcuts_connections;
  delete legacy.shortcuts_events;
  await call(app, 'POST', '/api/restore', legacy);
  assert.equal((await events(app)).length, 0);
  assert.equal((await call(app, 'GET', '/api/shortcuts/connections')).items.length, 0);
});
