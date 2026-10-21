import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRequest } from '../src/analysis.js';

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

function context() {
  return {
    today: '2026-10-21',
    accounts: [{ id: 'a1', name: '국민카드' }, { id: 'a2', name: '토스 카드' }],
    categories: [{ id: 'c1', name: '식사' }, { id: 'c2', name: '교통' }, { id: 'c3', name: '취미' }],
    tags: [{ id: 't1', name: '데이트' }, { id: 't2', name: '주말', archived: true }],
  };
}
function rows() {
  const row = (id, date, amount, changes = {}) => ({
    id, date, amount, kind: 'expense', account_id: 'a1', category_id: 'c1', tag_ids: [], ...changes,
  });
  const first = row('x1', '2026-10-01', 100, { tag_ids: ['t1', 't2'] });
  return [first, row('x2', '2026-10-02', 50, { category_id: 'c2', tag_ids: ['t1'] }),
    row('x3', '2026-10-20', 70, { category_id: 'c3', account_id: 'a2' }),
    row('old', '2026-09-30', 999, { tag_ids: ['t1'] }), row('salary', '2026-10-02', 500, { kind: 'income' }),
    structuredClone(first)];
}
async function run(payload, data = rows(), catalog = context()) {
  const calls = [];
  const result = await analyzeRequest(payload, filters => { calls.push(structuredClone(filters)); return data; }, catalog);
  return { result, calls };
}
const values = card => Object.fromEntries(card.data.map(item => [item.label, item.value]));

function mockProvider(t, plan) {
  process.env.LLM_BASE_URL = 'https://provider.example/v1';
  process.env.LLM_API_KEY = 'never-show-this-secret';
  process.env.LLM_MODEL = 'test-model';
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), ...options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}
function validPlan() {
  return {
    intents: ['total'], filters: { start: '2026-10-01', end: '2026-10-31', tag_ids: [], tag_mode: 'or' },
    clarification: null,
  };
}

test('monthly category totals and provenance come from actual deduplicated expenses', async () => {
  const { result, calls } = await run({ prompt: '이번 달 종목별 지출' });
  assert.equal(result.status, 'complete');
  assert.equal(result.provider, 'rules');
  const card = result.cards[0];
  assert.equal(card.kind, 'bar');
  assert.deepEqual(values(card), { 식사: 100, 교통: 50, 취미: 70 });
  assert.deepEqual(card.metadata.transaction_ids, ['x1', 'x2', 'x3']);
  assert.equal(card.metadata.source, 'tools');
  assert.equal(calls[0].start, '2026-10-01');
  assert.equal(calls[0].end, '2026-10-31');
  assert.equal(calls[0].kind, 'expense');
});

test('OR tag totals deduplicate transactions that have several selected tags', async () => {
  const { result } = await run({ prompt: '이번 달 전체 지출 합계', filters: { tag_ids: ['t1', 't2'], tag_mode: 'or' } });
  assert.equal(result.cards[0].data[0].value, 150);
  assert.deepEqual(result.cards[0].metadata.transaction_ids, ['x1', 'x2']);
});

test('tag subtotals overlap but repeated tags never count a transaction twice within one tag', async () => {
  const data = rows();
  data[0].tag_ids.push('t1');
  const { result } = await run({ prompt: '이번 달 태그별 지출' }, data);
  assert.deepEqual(values(result.cards[0]), { 데이트: 150, 주말: 100, '태그 없음': 70 });
  assert.match(result.cards[0].text, /전체 지출과 다를 수/);
});

test('AND tag filters retain only the intersection', async () => {
  const { result } = await run({ prompt: '이번 달 합계', filters: { tag_ids: ['t1', 't2'], tag_mode: 'and' } });
  assert.equal(result.cards[0].data[0].value, 100);
  assert.equal(result.cards[0].metadata.tag_mode, 'and');
});

test('an unspecified recent period asks for clarification without querying transactions', async () => {
  const { result, calls } = await run({ prompt: '최근 지출 요약' });
  assert.equal(result.status, 'clarification');
  assert.deepEqual(result.cards, []);
  assert.deepEqual(calls, []);
});

test('selected workspace filters resolve a vague request without reusing stale displayed amounts', async () => {
  const payload = { prompt: '최근 합계', reference: {
    filters: { start: '2026-09-01', end: '2026-09-30', tag_ids: ['t1'], tag_mode: 'or' },
    cards: [{ data: [{ value: 123456 }] }],
  } };
  const snapshot = structuredClone(payload);
  const { result, calls } = await run(payload);
  assert.equal(result.cards[0].data[0].value, 999);
  assert.equal(calls[0].start, '2026-09-01');
  assert.deepEqual(result.cards[0].metadata.transaction_ids, ['old']);
  assert.deepEqual(payload, snapshot);
});

test('an explicit prompt period overrides the selected workspace period', async () => {
  const { result, calls } = await run({ prompt: '이번 달 합계',
    reference: { filters: { start: '2026-09-01', end: '2026-09-30' } } });
  assert.equal(calls[0].start, '2026-10-01');
  assert.equal(result.cards[0].data[0].value, 220);
});

test('current date filters override a reference without discarding its tag scope', async () => {
  const { result } = await run({ prompt: '합계', filters: { start: '2026-10-01', end: '2026-10-31' },
    reference: { filters: { start: '2026-09-01', end: '2026-09-30', tag_ids: ['t1'] } } });
  assert.equal(result.cards[0].data[0].value, 150);
});

test('named accounts and tags are resolved to catalog IDs', async () => {
  const { result, calls } = await run({ prompt: '이번 달 국민카드 데이트 태그 합계' });
  assert.equal(calls[0].account_id, 'a1');
  assert.deepEqual(calls[0].tag_ids, ['t1']);
  assert.equal(result.cards[0].data[0].value, 150);
});

test('daily series uses actual transaction dates in chronological order', async () => {
  const { result } = await run({ prompt: '이번 달 날짜별 추이' });
  assert.deepEqual(result.cards[0].data, [
    { label: '2026-10-01', date: '2026-10-01', value: 100 },
    { label: '2026-10-02', date: '2026-10-02', value: 50 },
    { label: '2026-10-20', date: '2026-10-20', value: 70 },
  ]);
});

for (const [name, payload] of [
  ['missing end date', { prompt: '합계', filters: { start: '2026-10-01' } }],
  ['reversed dates', { prompt: '합계', filters: { start: '2026-10-31', end: '2026-10-01' } }],
  ['open date range', { prompt: '2026-10-01 이후 지출' }],
  ['multiple periods', { prompt: '9월과 10월 지출 비교' }],
  ['incomplete Korean end date', { prompt: '2026년 10월 1일부터 20일까지 지출' }],
  ['unknown tag', { prompt: '이번 달 합계', filters: { tag_ids: ['nonexistent'] } }],
  ['arbitrary SQL filter', { prompt: '이번 달 합계', filters: { sql: 'SELECT * FROM transactions' } }],
  ['unsupported income analysis', { prompt: '이번 달 수입 합계' }],
  ['unsupported advice', { prompt: '이번 달 지출을 절약하는 방법 추천' }],
  ['transaction mutation', { prompt: '이번 달 거래 내역을 삭제해 줘' }],
]) {
  test(`${name} asks for clarification without running the transaction tool`, async () => {
    const { result, calls } = await run(payload);
    assert.equal(result.status, 'clarification');
    assert.deepEqual(calls, []);
  });
}

test('complete Korean dates retain the requested end date instead of expanding to month end', async () => {
  const { result, calls } = await run({ prompt: '2026년 10월 1일부터 2026년 10월 2일까지 합계' });
  assert.equal(calls[0].end, '2026-10-02');
  assert.equal(result.cards[0].data[0].value, 150);
});

test('an empty selected period shows zero and no fabricated source transactions', async () => {
  const { result } = await run({ prompt: '지난달 합계', filters: { account_id: 'a2' } });
  assert.equal(result.cards[0].data[0].value, 0);
  assert.deepEqual(result.cards[0].metadata.transaction_ids, []);
  assert.match(result.message, /거래가 없습니다/);
});

test('analysis computes all tool rows beyond the transaction API page limit', async () => {
  const first = rows()[0];
  const manyRows = Array.from({ length: 5001 }, (_, index) => ({ ...first, id: `transaction-${index}` }));
  const { result, calls } = await run({ prompt: '이번 달 합계' }, manyRows);
  assert.equal(result.status, 'complete');
  assert.equal(result.cards[0].data[0].value, 500100);
  assert.equal(result.cards[0].metadata.transaction_ids.length, 5001);
  assert.equal(Object.hasOwn(calls[0], 'limit'), false);
});

test('asynchronous transaction tools are supported', async () => {
  const result = await analyzeRequest({ prompt: '이번 달 계좌별 지출' }, async () => rows(), context());
  assert.equal(result.status, 'complete');
  assert.deepEqual(values(result.cards[0]), { 국민카드: 150, '토스 카드': 70 });
});

test('a compatible model only plans; actual transactions supply the amounts', async t => {
  const providerCalls = mockProvider(t, validPlan());
  const { result } = await run({ prompt: '이번 달 합계' });
  assert.equal(result.provider, 'compatible');
  assert.equal(result.cards[0].data[0].value, 220);
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0].url, 'https://provider.example/v1/chat/completions');
  const sent = JSON.parse(providerCalls[0].body.messages[1].content);
  assert.equal(Object.hasOwn(sent, 'transactions'), false);
  assert.ok(!providerCalls[0].body.messages[1].content.includes('x1'));
  assert.ok(!JSON.stringify(result).includes('never-show-this-secret'));
});

for (const change of ['period', 'intent', 'sql', 'amount']) {
  test(`an untrusted provider cannot change ${change} in a resolved analysis plan`, async t => {
    const plan = validPlan();
    if (change === 'period') plan.filters.start = '2026-09-01';
    else if (change === 'intent') plan.intents = ['summary'];
    else if (change === 'sql') plan.filters.sql = 'DELETE FROM transactions';
    else plan.amount = 9999999;
    mockProvider(t, plan);
    const { result, calls } = await run({ prompt: '이번 달 합계' });
    assert.equal(result.provider, 'rules');
    assert.equal(result.cards[0].data[0].value, 220);
    assert.equal(calls[0].start, '2026-10-01');
  });
}

test('unconfigured providers never connect and clearly identify rule-based analysis', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Network must not be called'); });
  const { result } = await run({ prompt: '이번 달 요약' });
  assert.equal(fetch.mock.callCount(), 0);
  assert.equal(result.provider, 'rules');
  assert.match(result.message, /규칙 기반/);
  assert.equal(result.cards.length, 3);
});
