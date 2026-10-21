import Fastify from 'fastify';
import cors from '@fastify/cors';
import { timingSafeEqual } from 'node:crypto';
import { loadSettings } from './config.js';
import { createDatabase } from './db.js';
import * as services from './services.js';
import * as models from './models.js';
import { analyzeRequest } from './analysis.js';

function httpError(statusCode, detail) {
  return Object.assign(new Error(typeof detail === 'string' ? detail : '요청을 처리하지 못했습니다.'), { statusCode, detail });
}

export async function createApp(options = {}) {
  const settings = loadSettings(options);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: settings.restoreMaxBytes,
    requestTimeout: 60_000,
  });
  await app.register(cors, {
    origin: settings.corsOrigins,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  });
  const db = createDatabase(settings.dbPath);
  app.decorate('database', db);
  app.addHook('onClose', () => db.close());
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0] === '/api/health' || !settings.accessToken) return;
    const authorization = request.headers.authorization;
    const supplied = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7) : '';
    const expected = Buffer.from(settings.accessToken);
    const actual = Buffer.from(supplied);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      reply.header('WWW-Authenticate', 'Bearer');
      throw httpError(401, '접속 토큰을 확인해 주세요.');
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ detail: '백업 파일은 10MB 이하로 복원해 주세요.' });
    }
    if (error.statusCode >= 400 && error.statusCode < 500) {
      const status = error.statusCode === 400 ? 422 : error.statusCode;
      return reply.code(status).send({ detail: error.detail ?? (status === 422 ? '유효한 JSON 또는 입력 형식이 아닙니다.' : error.message) });
    }
    return reply.code(500).send({ detail: '서버에서 요청을 처리하지 못했습니다.' });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ detail: '요청한 API를 찾을 수 없습니다.' }));

  function atomic(operation, mode = 'IMMEDIATE') {
    db.exec(`BEGIN ${mode}`);
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function context() {
    return {
      accounts: db.prepare('SELECT * FROM accounts ORDER BY rowid').all().map(services.account),
      categories: db.prepare('SELECT * FROM categories ORDER BY rowid').all(),
      tags: db.prepare('SELECT * FROM tags ORDER BY archived,name,id').all()
        .map(tag => ({ ...tag, archived: Boolean(tag.archived) })),
      settings: {},
    };
  }
  const currentMonth = () => new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
  const selectedMonth = query => models.parse(models.monthQuery, query).month || currentMonth();

  app.get('/api/health', () => ({ status: 'ok', version: '0.1.0', auth_required: Boolean(settings.accessToken) }));
  app.get('/api/bootstrap', () => context());
  app.post('/api/accounts', (request, reply) => {
    const payload = models.parse(models.accountInput, request.body);
    const id = services.new_id();
    db.prepare('INSERT INTO accounts(id,name,description,color,archived) VALUES (?,?,?,?,0)')
      .run(id, payload.name, payload.description, payload.color);
    return reply.code(201).send(services.account(db.prepare('SELECT * FROM accounts WHERE id=?').get(id)));
  });
  app.patch('/api/accounts/:id', request => {
    const changes = models.parse(models.accountPatch, request.body);
    return atomic(() => {
      services.account(db.prepare('SELECT * FROM accounts WHERE id=?').get(request.params.id));
      const entries = Object.entries(changes).map(([key, value]) => [key, key === 'archived' ? Number(value) : value]);
      if (entries.length) {
        const fields = entries.map(([key]) => `${key}=?`).join(',');
        db.prepare(`UPDATE accounts SET ${fields} WHERE id=?`).run(...entries.map(([, value]) => value), request.params.id);
      }
      return services.account(db.prepare('SELECT * FROM accounts WHERE id=?').get(request.params.id));
    });
  });
  app.delete('/api/accounts/:id', (request, reply) => {
    atomic(() => {
      services.account(db.prepare('SELECT * FROM accounts WHERE id=?').get(request.params.id));
      if (db.prepare('SELECT 1 FROM transactions WHERE account_id=? LIMIT 1').get(request.params.id)) {
        throw httpError(409, '거래에 사용된 금융수단은 삭제할 수 없습니다. 기록을 유지하려면 금융수단을 보관해 주세요.');
      }
      db.prepare('DELETE FROM accounts WHERE id=?').run(request.params.id);
    });
    return reply.code(204).send();
  });
  app.get('/api/transactions', request => {
    const { limit, tag_ids, ...filters } = models.parse(models.transactionQuery, request.query);
    filters.tag_ids = tag_ids.split(',').map(value => value.trim()).filter(Boolean);
    if (filters.tag_ids.length > 100) throw httpError(422, '태그 필터는 100개 이하로 지정해 주세요.');
    return services.query_transactions(db, filters, { limit });
  });
  app.post('/api/transactions/batch', (request, reply) => {
    const payload = models.parse(models.batchInput, request.body);
    const items = atomic(() => payload.items.map(item => services.insert_transaction(db, item))
      .map(id => services.get_transaction(db, id)));
    return reply.code(201).send({ items });
  });
  app.patch('/api/transactions/:id', request => {
    const submitted = models.parse(models.transactionPatch, request.body);
    return atomic(() => {
      const current = services.get_transaction(db, request.params.id);
      if (current.version !== submitted.version) services.conflict(current, submitted);
      const base = Object.fromEntries(['date', 'amount', 'kind', 'account_id', 'category_id', 'tag_ids', 'note'].map(key => [key, current[key]]));
      const { version: _version, ...editable } = submitted;
      const item = models.parse(models.transactionInput, { ...base, ...editable });
      services.check_references(db, item, { requireActiveAccount: true, existingAccountId: current.account_id });
      db.prepare('UPDATE transactions SET date=?,amount=?,kind=?,account_id=?,category_id=?,note=?,version=version+1,updated_at=? WHERE id=?')
        .run(item.date, item.amount, item.kind, item.account_id, item.category_id, item.note, services.now(), request.params.id);
      services.set_transaction_tags(db, request.params.id, item.tag_ids);
      return services.get_transaction(db, request.params.id);
    });
  });
  app.delete('/api/transactions/:id', (request, reply) => {
    const { version } = models.parse(models.deleteVersionQuery, request.query);
    atomic(() => {
      const current = services.get_transaction(db, request.params.id);
      if (current.version !== version) services.conflict(current, { version, delete: true });
      db.prepare('DELETE FROM transactions WHERE id=?').run(request.params.id);
    });
    return reply.code(204).send();
  });
  app.get('/api/dashboard', request => services.dashboard(db, selectedMonth(request.query)));
  app.get('/api/budgets', request => ({ items: services.get_budgets(db, selectedMonth(request.query)) }));
  app.put('/api/budgets/:tag_id/:month', request => {
    const month = models.parse(models.month, request.params.month);
    const { amount } = models.parse(models.budgetInput, request.body);
    return atomic(() => {
      if (!db.prepare('SELECT id FROM tags WHERE id=?').get(request.params.tag_id)) throw httpError(404, '태그를 찾을 수 없습니다.');
      db.prepare('INSERT INTO budgets VALUES (?,?,?) ON CONFLICT(tag_id,month) DO UPDATE SET amount=excluded.amount')
        .run(request.params.tag_id, month, amount);
      return services.get_budget(db, request.params.tag_id, month);
    });
  });
  app.delete('/api/budgets/:tag_id/:month', (request, reply) => {
    const month = models.parse(models.month, request.params.month);
    db.prepare('DELETE FROM budgets WHERE tag_id=? AND month=?').run(request.params.tag_id, month);
    return reply.code(204).send();
  });

  for (const table of ['tags', 'categories']) {
    app.post(`/api/${table}`, (request, reply) => {
      const payload = models.parse(models.namedInput, request.body);
      const id = services.new_id();
      db.prepare(`INSERT INTO ${table}(id,name,color) VALUES (?,?,?)`).run(id, payload.name, payload.color);
      const result = { ...db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) };
      if (table === 'tags') result.archived = Boolean(result.archived);
      return reply.code(201).send(result);
    });
    app.patch(`/api/${table}/:id`, request => {
      const changes = models.parse(models.namedPatch, request.body);
      if (!db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(request.params.id)) throw httpError(404, '항목을 찾을 수 없습니다.');
      if (Object.keys(changes).length) {
        const fields = Object.keys(changes).map(key => `${key}=?`).join(',');
        db.prepare(`UPDATE ${table} SET ${fields} WHERE id=?`).run(...Object.values(changes), request.params.id);
      }
      const result = { ...db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(request.params.id) };
      if (table === 'tags') result.archived = Boolean(result.archived);
      return result;
    });
  }
  app.delete('/api/tags/:id', (request, reply) => {
    const { mode } = models.parse(models.tagDeleteQuery, request.query);
    atomic(() => {
      if (!db.prepare('SELECT id FROM tags WHERE id=?').get(request.params.id)) throw httpError(404, '태그를 찾을 수 없습니다.');
      if (mode === 'archive') db.prepare('UPDATE tags SET archived=1 WHERE id=?').run(request.params.id);
      else {
        db.prepare('UPDATE transactions SET version=version+1,updated_at=? WHERE id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id=?)')
          .run(services.now(), request.params.id);
        db.prepare('DELETE FROM transaction_tags WHERE tag_id=?').run(request.params.id);
        db.prepare('DELETE FROM budgets WHERE tag_id=?').run(request.params.id);
        db.prepare('DELETE FROM tags WHERE id=?').run(request.params.id);
      }
    });
    return reply.code(204).send();
  });
  app.get('/api/workspaces', () => ({ items: db.prepare('SELECT * FROM workspaces ORDER BY updated_at DESC,id').all().map(services.workspace) }));
  app.post('/api/workspaces', (request, reply) => {
    const payload = models.parse(models.workspaceInput, request.body);
    const snapshot = services.serialize_snapshot(payload.snapshot);
    const id = services.new_id(), timestamp = services.now();
    db.prepare('INSERT INTO workspaces VALUES (?,?,?,1,?,?)').run(id, payload.title, snapshot, timestamp, timestamp);
    return reply.code(201).send(services.workspace(db.prepare('SELECT * FROM workspaces WHERE id=?').get(id)));
  });
  app.put('/api/workspaces/:id', request => {
    const payload = models.parse(models.workspaceUpdate, request.body);
    const snapshot = services.serialize_snapshot(payload.snapshot);
    return atomic(() => {
      const current = services.workspace(db.prepare('SELECT * FROM workspaces WHERE id=?').get(request.params.id));
      if (current.version !== payload.version) services.conflict(current, payload);
      db.prepare('UPDATE workspaces SET title=?,snapshot=?,version=version+1,updated_at=? WHERE id=?')
        .run(payload.title, snapshot, services.now(), request.params.id);
      return services.workspace(db.prepare('SELECT * FROM workspaces WHERE id=?').get(request.params.id));
    });
  });
  app.delete('/api/workspaces/:id', (request, reply) => {
    if (!db.prepare('DELETE FROM workspaces WHERE id=?').run(request.params.id).changes) throw httpError(404, '작업 공간을 찾을 수 없습니다.');
    return reply.code(204).send();
  });
  app.get('/api/backup', () => atomic(() => services.export_backup(db), 'DEFERRED'));
  app.post('/api/restore', request => {
    const payload = models.parse(models.backupInput, request.body);
    atomic(() => services.restore_backup(db, payload));
    return { restored: true };
  });
  app.post('/api/analysis', async request => {
    const payload = models.parse(models.analysisInput, request.body);
    if (payload.filters) {
      payload.filters = Object.fromEntries(Object.entries(payload.filters).filter(([, value]) => value !== null));
      services.check_references(db, payload.filters);
      if (payload.filters.start && payload.filters.end && payload.filters.start > payload.filters.end) {
        throw httpError(422, '시작일은 종료일보다 늦을 수 없습니다.');
      }
    } else delete payload.filters;
    if (payload.reference === null) delete payload.reference;
    return analyzeRequest(payload, filters => services.query_transactions(db, filters).items, context());
  });
  await app.ready();
  return app;
}
