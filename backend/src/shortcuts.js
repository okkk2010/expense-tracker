import { createHash, randomBytes } from 'node:crypto';
import * as models from './models.js';
import * as services from './services.js';
import { parseNotification } from './shortcut-parser.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
const notificationKey = payload => JSON.stringify([payload.title, payload.subtitle, payload.body, payload.source_app].map(normalized));
const fail = (statusCode, detail) => { throw Object.assign(new Error(detail), { statusCode, detail }); };

function connection(row) {
  return { id: row.id, name: row.name, source: row.source, account_id: row.account_id,
    match_text: row.match_text, category_id: row.category_id, tag_ids: JSON.parse(row.tag_ids),
    auto_record: Boolean(row.auto_record), enabled: Boolean(row.enabled),
    last_received_at: row.last_received_at, created_at: row.created_at };
}

function event(row) {
  return { id: row.id, connection_id: row.connection_id, connection_name: row.connection_name, source: row.source,
    title: row.title, subtitle: row.subtitle, body: row.body, source_app: row.source_app,
    occurred_at: row.occurred_at, received_at: row.received_at, status: row.status, reason: row.reason,
    parsed: JSON.parse(row.parsed), transaction_id: row.transaction_id };
}

function getConnection(db, id) {
  const row = db.prepare('SELECT * FROM shortcut_connections WHERE id=?').get(id);
  if (!row) fail(404, '단축어 연결을 찾을 수 없습니다.');
  return row;
}

function getEvent(db, id) {
  const row = db.prepare('SELECT * FROM shortcut_events WHERE id=?').get(id);
  if (!row) fail(404, '수집한 알림을 찾을 수 없습니다.');
  return row;
}

function credential() {
  const token = `moa_sc_${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hash(token) };
}

function validateTimestamp(value, receivedAt) {
  if (value === undefined) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || !models.isoDate.safeParse(match[1]).success || Number(match[2]) > 23
    || Number(match[3]) > 59 || Number(match[4]) > 59
    || (match[7] && (Number(match[7]) > 14 || Number(match[8]) > 59 || (Number(match[7]) === 14 && Number(match[8]) !== 0)))
    || !Number.isFinite(Date.parse(value))) fail(422, 'occurred_at은 시간대가 포함된 유효한 ISO 날짜와 시간이어야 합니다.');
  if (Date.parse(value) > Date.parse(receivedAt) + 5 * 60_000) fail(422, '알림 시각이 현재보다 늦습니다. 기기의 날짜와 시간을 확인해 주세요.');
  return new Date(value).toISOString();
}

function hasContradictorySource(source, sourceApp) {
  const app = normalized(sourceApp);
  return source === 'toss' ? /국민|\bkb|kbstar/.test(app) : /토스|toss/.test(app);
}

function autoReviewReason(db, selected, payload, parsed) {
  if (hasContradictorySource(selected.source, payload.source_app)) return '연결한 출처와 알림의 source_app이 달라 확인이 필요합니다.';
  if (!parsed.confidence || parsed.kind !== 'expense' || parsed.amount === null) return parsed.reason;
  if (!selected.auto_record) return '자동 저장이 꺼져 있어 확인이 필요합니다.';
  if (!selected.match_text.trim()) return '금융수단 확인 문구를 설정한 뒤 자동 저장할 수 있습니다.';
  const full = normalized(`${payload.title}\n${payload.subtitle}\n${payload.body}`);
  if (!full.includes(normalized(selected.match_text))) return '금융수단 확인 문구가 알림과 일치하지 않습니다.';
  const account = selected.account_id ? db.prepare('SELECT id,archived FROM accounts WHERE id=?').get(selected.account_id) : null;
  if (!account) return '연결된 금융수단을 확인해 주세요.';
  if (account.archived) return '보관된 금융수단에는 자동 저장하지 않습니다. 다른 금융수단을 선택하거나 보관을 해제해 주세요.';
  return null;
}

function nearbyReviewReason(db, selected, payload, parsed, occurredAt, transactionTime, receivedAt) {
  const since = new Date(Date.parse(receivedAt) - 10 * 60_000).toISOString();
  const candidates = db.prepare("SELECT * FROM shortcut_events WHERE received_at>=? AND status IN ('pending','recorded') ORDER BY received_at DESC LIMIT 500").all(since);
  const incomingKey = notificationKey(payload);
  for (const candidate of candidates) {
    if (candidate.connection_id === selected.id && occurredAt && candidate.occurred_at === occurredAt
      && notificationKey(candidate) === incomingKey) {
      return '같은 내용과 시각의 다른 알림이 있습니다. 별도 거래인지 확인한 뒤 저장해 주세요.';
    }
    // Without a caller-supplied event identity, identical notifications may be
    // retries OR separate real purchases. Keep the new one for review, never discard it.
    if (!payload.event_id && !occurredAt && candidate.connection_id === selected.id
      && Date.parse(receivedAt) - Date.parse(candidate.received_at) <= 2 * 60_000
      && notificationKey(candidate) === incomingKey) return '같은 내용의 최근 알림이 있습니다. 재전송인지 별도 거래인지 확인해 주세요.';
    if (candidate.source === selected.source || parsed.amount === null) continue;
    const other = JSON.parse(candidate.parsed);
    if (other.amount !== parsed.amount || other.date !== parsed.date || other.kind !== parsed.kind) continue;
    const incomingTime = Date.parse(transactionTime || occurredAt || receivedAt);
    const otherTime = Date.parse(candidate.transaction_time || candidate.occurred_at || candidate.received_at);
    if (Math.abs(incomingTime - otherTime) > 5 * 60_000) continue;
    if (normalized(other.note) && normalized(other.note) === normalized(parsed.note)) {
      return '다른 출처에서 비슷한 거래를 수집했습니다. 중복 여부를 확인한 뒤 저장해 주세요.';
    }
  }
  return null;
}

function ingest(db, selected, payload) {
  const receivedAt = services.now();
  const occurredAt = validateTimestamp(payload.occurred_at, receivedAt);
  const fingerprint = payload.event_id ? hash(`event:${payload.event_id}`)
    : occurredAt ? hash(`notification:${notificationKey(payload)}:${occurredAt}`)
      : hash(`unidentified:${services.new_id()}`);
  const duplicate = payload.event_id
    ? db.prepare('SELECT * FROM shortcut_events WHERE connection_id=? AND external_event_id=?').get(selected.id, payload.event_id)
    : db.prepare('SELECT * FROM shortcut_events WHERE connection_id=? AND fingerprint=?').get(selected.id, fingerprint);
  db.prepare('UPDATE shortcut_connections SET last_received_at=? WHERE id=?').run(receivedAt, selected.id);
  if (duplicate) {
    if (payload.event_id && (notificationKey(duplicate) !== notificationKey(payload) || duplicate.occurred_at !== occurredAt)) {
      fail(409, '같은 event_id에 다른 알림 내용이나 시각이 전송됐습니다. 알림마다 고유한 event_id를 보내 주세요.');
    }
    return { status: 'duplicate', event_id: duplicate.id, transaction_id: duplicate.transaction_id,
      message: '이미 수집한 알림입니다. 거래를 추가하지 않았습니다.' };
  }

  const parsed = parseNotification(payload, { receivedAt, occurredAt });
  const category = selected.category_id ?? (db.prepare("SELECT id FROM categories WHERE id='category-other'").get()?.id ?? null);
  const draft = { date: parsed.date, amount: parsed.amount, kind: parsed.kind, note: parsed.note,
    account_id: selected.account_id, category_id: category, tag_ids: JSON.parse(selected.tag_ids) };
  let reason = nearbyReviewReason(db, selected, payload, parsed, occurredAt, parsed.transaction_time, receivedAt)
    || autoReviewReason(db, selected, payload, parsed);
  if (!reason && (!category || !db.prepare('SELECT id FROM categories WHERE id=?').get(category))) reason = '저장할 종목을 선택해 주세요.';
  if (!reason && draft.tag_ids.some(id => !db.prepare('SELECT id FROM tags WHERE id=? AND archived=0').get(id))) reason = '연결한 태그가 삭제되거나 보관되어 확인이 필요합니다.';
  let transactionId = null;
  if (!reason) {
    const valid = models.parse(models.transactionInput, draft);
    transactionId = services.insert_transaction(db, valid);
    reason = '확인 문구와 일치하는 결제 승인 알림을 저장했습니다.';
  }
  const id = services.new_id(), status = transactionId ? 'recorded' : 'pending';
  db.prepare(`INSERT INTO shortcut_events
    (id,connection_id,connection_name,source,title,subtitle,body,source_app,occurred_at,transaction_time,received_at,external_event_id,fingerprint,status,reason,parsed,transaction_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, selected.id, selected.name, selected.source, payload.title, payload.subtitle, payload.body, payload.source_app,
      occurredAt, parsed.transaction_time, receivedAt, payload.event_id ?? null, fingerprint, status, reason, JSON.stringify(draft), transactionId);
  return { status, event_id: id, transaction_id: transactionId, message: reason };
}

export function registerShortcuts(app, { db, settings, atomic }) {
  app.get('/api/shortcuts/connections', () => ({ items: db.prepare('SELECT * FROM shortcut_connections ORDER BY created_at,id').all().map(connection) }));
  app.post('/api/shortcuts/connections', (request, reply) => {
    const input = models.parse(models.shortcutConnectionInput, request.body);
    services.check_references(db, input, { requireActiveAccount: true });
    const id = services.new_id(), createdAt = services.now(), { token, tokenHash } = credential();
    db.prepare(`INSERT INTO shortcut_connections
      (id,name,source,account_id,match_text,category_id,tag_ids,auto_record,enabled,token_hash,last_received_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?)`)
      .run(id, input.name, input.source, input.account_id, input.match_text, input.category_id, JSON.stringify(input.tag_ids),
        Number(input.auto_record), Number(input.enabled), tokenHash, createdAt);
    return reply.code(201).send({ connection: connection(getConnection(db, id)), token });
  });
  app.patch('/api/shortcuts/connections/:id', request => {
    const changes = models.parse(models.shortcutConnectionPatch, request.body);
    const current = getConnection(db, request.params.id);
    const next = { ...connection(current), ...changes };
    services.check_references(db, next, { requireActiveAccount: changes.account_id !== undefined || next.enabled });
    if (next.enabled && !next.account_id) fail(422, '금융수단을 선택한 뒤 연결을 켜 주세요.');
    // Restored connections contain no credential. Rotation is required before enabling them.
    if (next.enabled && !current.token_hash) fail(422, '전송 키를 새로 발급한 뒤 연결을 켜 주세요.');
    db.prepare('UPDATE shortcut_connections SET name=?,source=?,account_id=?,match_text=?,category_id=?,tag_ids=?,auto_record=?,enabled=? WHERE id=?')
      .run(next.name, next.source, next.account_id, next.match_text, next.category_id, JSON.stringify(next.tag_ids), Number(next.auto_record), Number(next.enabled), current.id);
    return connection(getConnection(db, current.id));
  });
  app.delete('/api/shortcuts/connections/:id', (request, reply) => {
    getConnection(db, request.params.id);
    db.prepare('DELETE FROM shortcut_connections WHERE id=?').run(request.params.id);
    return reply.code(204).send();
  });
  app.post('/api/shortcuts/connections/:id/rotate', request => {
    const current = getConnection(db, request.params.id);
    const { token, tokenHash } = credential();
    db.prepare('UPDATE shortcut_connections SET token_hash=? WHERE id=?').run(tokenHash, current.id);
    return { connection: connection(getConnection(db, current.id)), token };
  });
  app.post('/api/shortcuts/ingest', { bodyLimit: 16 * 1024 }, request => {
    if (!settings.accessToken) fail(503, '단축어 연결을 사용하려면 서버의 APP_ACCESS_TOKEN을 먼저 설정해 주세요.');
    const authorization = request.headers.authorization;
    const token = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const selected = token.length >= 30 && token.length <= 200
      ? db.prepare('SELECT * FROM shortcut_connections WHERE token_hash=? AND enabled=1').get(hash(token)) : null;
    if (!selected) fail(401, '유효하고 활성화된 단축어 전송 키가 필요합니다.');
    const payload = models.parse(models.shortcutIngestInput, request.body);
    return atomic(() => ingest(db, selected, payload));
  });
  app.get('/api/shortcuts/events', request => {
    const { status, limit } = models.parse(models.shortcutEventQuery, request.query);
    const rows = status ? db.prepare('SELECT * FROM shortcut_events WHERE status=? ORDER BY received_at DESC,id DESC LIMIT ?').all(status, limit)
      : db.prepare('SELECT * FROM shortcut_events ORDER BY received_at DESC,id DESC LIMIT ?').all(limit);
    return { items: rows.map(event) };
  });
  app.post('/api/shortcuts/events/:id/record', request => {
    const input = models.parse(models.shortcutRecordInput, request.body);
    return atomic(() => {
      const current = getEvent(db, request.params.id);
      if (current.status === 'recorded') {
        if (!current.transaction_id) fail(409, '이 알림의 거래는 삭제되었습니다. 새 거래가 필요하면 직접 입력해 주세요.');
        return { event: event(current), transaction: services.get_transaction(db, current.transaction_id) };
      }
      if (current.status !== 'pending') fail(409, '이미 제외하거나 처리한 알림입니다.');
      if (JSON.parse(current.parsed).kind === 'refund') {
        fail(422, '취소·환불 알림은 새 수입이나 지출로 저장하지 않습니다. 원거래를 수정한 뒤 이 알림을 제외해 주세요.');
      }
      const transactionId = services.insert_transaction(db, input.transaction);
      db.prepare("UPDATE shortcut_events SET status='recorded',reason=?,parsed=?,transaction_id=? WHERE id=?")
        .run('확인한 내용을 거래로 저장했습니다.', JSON.stringify(input.transaction), transactionId, current.id);
      return { event: event(getEvent(db, current.id)), transaction: services.get_transaction(db, transactionId) };
    });
  });
  app.post('/api/shortcuts/events/:id/ignore', request => atomic(() => {
    const current = getEvent(db, request.params.id);
    if (current.status === 'ignored') return { event: event(current) };
    if (current.status !== 'pending' && current.status !== 'duplicate') fail(409, '이미 거래로 저장한 알림은 제외할 수 없습니다.');
    db.prepare("UPDATE shortcut_events SET status='ignored',reason=? WHERE id=?").run('사용자가 거래에서 제외했습니다.', current.id);
    return { event: event(getEvent(db, current.id)) };
  }));
}
