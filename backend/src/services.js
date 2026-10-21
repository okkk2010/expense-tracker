import { randomUUID } from 'node:crypto';

function fail(statusCode, detail) {
  throw Object.assign(new Error(typeof detail === 'string' ? detail : detail.message), { statusCode, detail });
}
export const now = () => new Date().toISOString();
export const new_id = () => randomUUID();

export function month_range(month) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail(422, '월은 YYYY-MM 형식이어야 합니다.');
  const [year, number] = month.split('-').map(Number);
  if (year < 1) fail(422, '유효하지 않은 월입니다.');
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][number - 1];
  return [`${month}-01`, `${month}-${days}`];
}

function safe_money(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(422, '금액은 안전하게 표현할 수 있는 0원 이상의 정수여야 합니다.');
  return value;
}
function safe_sum(values) {
  let total = 0n;
  for (const value of values) total += BigInt(safe_money(value));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail(422, '합계가 안전하게 계산할 수 있는 금액 범위를 넘었습니다. 조회 기간이나 조건을 좁혀 주세요.');
  return Number(total);
}
function valid_date(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(422, '날짜는 YYYY-MM-DD 형식이어야 합니다.');
  const [start, end] = month_range(day.slice(0, 7));
  if (day < start || day > end) fail(422, '유효하지 않은 날짜입니다.');
}

export function check_references(db, payload, { requireActiveAccount = false, existingAccountId } = {}) {
  for (const [key, table] of [['account_id', 'accounts'], ['category_id', 'categories']]) {
    if (payload[key] == null) continue;
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(payload[key]);
    if (!row) fail(422, `존재하지 않는 ${key}: ${payload[key]}`);
    if (key === 'account_id' && requireActiveAccount && row.archived && row.id !== existingAccountId) {
      fail(422, '보관된 금융수단에는 새 거래를 기록할 수 없습니다. 다른 금융수단을 선택하거나 보관을 해제해 주세요.');
    }
  }
  for (const id of payload.tag_ids ?? []) {
    if (!db.prepare('SELECT id FROM tags WHERE id=?').get(id)) fail(422, `존재하지 않는 tag_id: ${id}`);
  }
}

export function get_transaction(db, id) {
  const row = db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
  if (!row) fail(404, '거래를 찾을 수 없습니다.');
  return decorate_transactions(db, [row])[0];
}

export function decorate_transactions(db, rows) {
  if (!rows.length) return [];
  const accounts = new Map(db.prepare('SELECT id,name FROM accounts').all().map(row => [row.id, row.name]));
  const categories = new Map(db.prepare('SELECT id,name FROM categories').all().map(row => [row.id, row.name]));
  const tagMap = new Map();
  for (let index = 0; index < rows.length; index += 400) {
    const ids = rows.slice(index, index + 400).map(row => row.id);
    const placeholders = ids.map(() => '?').join(',');
    const tags = db.prepare(`SELECT tt.transaction_id,t.id,t.name FROM transaction_tags tt JOIN tags t ON t.id=tt.tag_id
      WHERE tt.transaction_id IN (${placeholders}) ORDER BY t.name,t.id`).all(...ids);
    for (const tag of tags) {
      if (!tagMap.has(tag.transaction_id)) tagMap.set(tag.transaction_id, []);
      tagMap.get(tag.transaction_id).push(tag);
    }
  }
  return rows.map(row => {
    const tags = tagMap.get(row.id) ?? [];
    return { ...row, amount: safe_money(row.amount), account_name: accounts.get(row.account_id) ?? '',
      category_name: categories.get(row.category_id) ?? '', tag_ids: tags.map(tag => tag.id), tag_names: tags.map(tag => tag.name) };
  });
}

export function query_transactions(db, filters = {}, options = {}) {
  filters ??= {};
  const conditions = [], params = [];
  if (filters.start) valid_date(filters.start);
  if (filters.end) valid_date(filters.end);
  if (filters.start && filters.end && filters.start > filters.end) fail(422, '시작일은 종료일보다 늦을 수 없습니다.');
  for (const [key, op] of [['start', '>='], ['end', '<=']]) {
    if (filters[key]) { conditions.push(`t.date ${op} ?`); params.push(filters[key]); }
  }
  for (const field of ['account_id', 'category_id', 'kind']) {
    if (filters[field]) { conditions.push(`t.${field}=?`); params.push(filters[field]); }
  }
  if (filters.q) {
    conditions.push("t.note LIKE ? ESCAPE '\\'");
    params.push(`%${filters.q.replace(/[\\%_]/g, match => `\\${match}`)}%`);
  }
  const ids = [...new Set(filters.tag_ids ?? [])];
  const mode = filters.tag_mode ?? 'or';
  if (!['or', 'and'].includes(mode)) fail(422, 'tag_mode는 or 또는 and여야 합니다.');
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    if (mode === 'and') {
      conditions.push(`t.id IN (SELECT transaction_id FROM transaction_tags WHERE tag_id IN (${placeholders})
        GROUP BY transaction_id HAVING COUNT(DISTINCT tag_id)=?)`);
      params.push(...ids, ids.length);
    } else {
      conditions.push(`EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id=t.id AND tt.tag_id IN (${placeholders}))`);
      params.push(...ids);
    }
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS total FROM transactions t${where}`).get(...params).total;
  let sql = `SELECT t.* FROM transactions t${where} ORDER BY t.date DESC,t.created_at DESC,t.id DESC`;
  const limit = typeof options === 'number' ? options : options?.limit;
  if (limit != null) {
    if (!Number.isSafeInteger(limit) || limit < 1) fail(422, '조회 개수는 1 이상의 정수여야 합니다.');
    sql += ' LIMIT ?'; params.push(limit);
  }
  return { items: decorate_transactions(db, db.prepare(sql).all(...params)), total };
}

export function insert_transaction(db, item) {
  check_references(db, item, { requireActiveAccount: true }); valid_date(item.date); safe_money(item.amount);
  const id = new_id(), timestamp = now();
  db.prepare(`INSERT INTO transactions(id,date,amount,kind,account_id,category_id,note,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,1,?,?)`).run(id, item.date, item.amount, item.kind, item.account_id, item.category_id, item.note ?? '', timestamp, timestamp);
  set_transaction_tags(db, id, item.tag_ids ?? []);
  return id;
}
export function set_transaction_tags(db, id, tags) {
  db.prepare('DELETE FROM transaction_tags WHERE transaction_id=?').run(id);
  const statement = db.prepare('INSERT INTO transaction_tags VALUES (?,?)');
  for (const tag of new Set(tags)) statement.run(id, tag);
}
export function conflict(current, submitted) {
  fail(409, { message: '다른 곳에서 변경된 내용이 있습니다. 최신 내용을 확인해 주세요.', current, submitted });
}

export function get_budget(db, tag_id, month) {
  const [start, end] = month_range(month);
  const tag = db.prepare('SELECT id,name FROM tags WHERE id=?').get(tag_id);
  if (!tag) fail(404, '태그를 찾을 수 없습니다.');
  const row = db.prepare('SELECT month,amount FROM budgets WHERE tag_id=? AND month<=? ORDER BY month DESC LIMIT 1').get(tag_id, month);
  if (!row) return null;
  const amounts = db.prepare(`SELECT t.amount FROM transactions t WHERE t.kind='expense' AND t.date BETWEEN ? AND ?
    AND EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.transaction_id=t.id AND tt.tag_id=?)`).all(start, end, tag_id);
  const spent = safe_sum(amounts.map(item => item.amount)), amount = safe_money(row.amount);
  return { tag_id, tag_name: tag.name, month, amount, spent, remaining: amount - spent, inherited: row.month !== month, from_month: row.month };
}
export function get_budgets(db, month) {
  month_range(month);
  return db.prepare('SELECT DISTINCT tag_id FROM budgets WHERE month<=?').all(month)
    .map(row => get_budget(db, row.tag_id, month)).filter(budget => budget && budget.amount > 0)
    .sort((a, b) => a.tag_name < b.tag_name ? -1 : a.tag_name > b.tag_name ? 1 : a.tag_id.localeCompare(b.tag_id));
}

export function dashboard(db, month) {
  const [start, end] = month_range(month), [year, number] = month.split('-').map(Number);
  const current = query_transactions(db, { start, end, kind: 'expense' }).items;
  let previous_expense = 0;
  if (year > 1 || number > 1) {
    const previous = `${String(number === 1 ? year - 1 : year).padStart(4, '0')}-${String(number === 1 ? 12 : number - 1).padStart(2, '0')}`;
    const [previousStart, previousEnd] = month_range(previous);
    previous_expense = safe_sum(db.prepare("SELECT amount FROM transactions WHERE kind='expense' AND date BETWEEN ? AND ?")
      .all(previousStart, previousEnd).map(row => row.amount));
  }
  const by_category = db.prepare('SELECT * FROM categories').all().map(({ id, name, color }) => ({ id, name, color,
    total: safe_sum(current.filter(item => item.category_id === id).map(item => item.amount)) }));
  const by_account = db.prepare('SELECT * FROM accounts').all().map(({ id, name, description, color, archived }) => ({ id, name, description, color, archived: Boolean(archived),
    total: safe_sum(current.filter(item => item.account_id === id).map(item => item.amount)) }))
    .filter(item => !item.archived || item.total > 0);
  const daily = Array.from({ length: Number(end.slice(-2)) }, (_, index) => {
    const day = `${month}-${String(index + 1).padStart(2, '0')}`;
    return { date: day, total: safe_sum(current.filter(item => item.date === day).map(item => item.amount)) };
  });
  return { month, total_expense: safe_sum(current.map(item => item.amount)), transaction_count: current.length,
    previous_expense, by_category, by_account, daily, budgets: get_budgets(db, month), recent_transactions: current.slice(0, 10),
    metadata: { start, end, date_basis: 'transaction_date', tag_mode: 'or' } };
}

export function account(row) {
  if (!row) fail(404, '금융수단을 찾을 수 없습니다.');
  return { ...row, archived: Boolean(row.archived) };
}

export function workspace(row) {
  if (!row) fail(404, '작업 공간을 찾을 수 없습니다.');
  return { ...row, snapshot: JSON.parse(row.snapshot) };
}
function assert_json(value, parents = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || parents.has(value)) fail(422, '작업 공간에는 유효한 JSON 값만 저장할 수 있습니다.');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail(422, '작업 공간에는 유효한 JSON 값만 저장할 수 있습니다.');
  parents.add(value);
  for (const item of Object.values(value)) assert_json(item, parents);
  parents.delete(value);
}
export function serialize_snapshot(snapshot) {
  let encoded;
  try { assert_json(snapshot); encoded = JSON.stringify(snapshot); }
  catch (error) {
    if (error.statusCode) throw error;
    fail(422, '작업 공간에는 유효한 JSON 값만 저장할 수 있습니다.');
  }
  if (Buffer.byteLength(encoded, 'utf8') > 2 * 1024 * 1024) fail(413, '작업 공간은 2MB 이하로 저장해 주세요.');
  return encoded;
}

export function export_backup(db) {
  const transactions = db.prepare('SELECT * FROM transactions ORDER BY id').all().map(row => ({ ...row, amount: safe_money(row.amount),
    tag_ids: db.prepare('SELECT tag_id FROM transaction_tags WHERE transaction_id=? ORDER BY tag_id').all(row.id).map(tag => tag.tag_id) }));
  return { schema_version: 1, exported_at: now(), accounts: db.prepare('SELECT * FROM accounts ORDER BY id').all().map(account),
    categories: db.prepare('SELECT * FROM categories ORDER BY id').all(),
    tags: db.prepare('SELECT * FROM tags ORDER BY id').all().map(row => ({ ...row, archived: Boolean(row.archived) })), transactions,
    budgets: db.prepare('SELECT * FROM budgets ORDER BY tag_id,month').all().map(row => ({ ...row, amount: safe_money(row.amount) })),
    workspaces: db.prepare('SELECT * FROM workspaces ORDER BY id').all().map(workspace), settings: {} };
}

// The route performs structural/schema validation; these checks validate every
// cross-record reference before restore mutates any rows.
export function validate_backup(data) {
  const sets = new Map();
  for (const collection of ['accounts', 'categories', 'tags', 'transactions', 'workspaces']) {
    const ids = data[collection].map(item => item.id);
    if (ids.length !== new Set(ids).size) fail(422, `백업의 ${collection}에 중복 ID가 있습니다.`);
    sets.set(collection, new Set(ids));
  }
  const keys = data.budgets.map(item => JSON.stringify([item.tag_id, item.month]));
  if (keys.length !== new Set(keys).size) fail(422, '백업에 중복 예산이 있습니다.');
  for (const transaction of data.transactions) {
    for (const [key, collection] of [['account_id', 'accounts'], ['category_id', 'categories']]) {
      if (!sets.get(collection).has(transaction[key])) fail(422, `백업 거래에 잘못된 ${key} 참조가 있습니다.`);
    }
    if (transaction.tag_ids.some(id => !sets.get('tags').has(id))) fail(422, '백업 거래에 잘못된 태그 참조가 있습니다.');
    valid_date(transaction.date); safe_money(transaction.amount);
  }
  for (const budget of data.budgets) {
    month_range(budget.month); safe_money(budget.amount);
    if (!sets.get('tags').has(budget.tag_id)) fail(422, '백업 예산에 잘못된 태그 참조가 있습니다.');
  }
  for (const item of data.workspaces) serialize_snapshot(item.snapshot);
  if (Object.keys(data.settings ?? {}).length) fail(422, '이 버전은 비어 있는 settings만 복원할 수 있습니다.');
}

// The caller owns BEGIN IMMEDIATE / COMMIT / ROLLBACK, just as for batch writes.
export function restore_backup(db, data) {
  validate_backup(data);
  for (const table of ['transaction_tags', 'transactions', 'budgets', 'workspaces', 'tags', 'categories', 'accounts']) db.exec(`DELETE FROM ${table}`);
  const account = db.prepare('INSERT INTO accounts(id,name,description,color,archived) VALUES (?,?,?,?,?)');
  for (const item of data.accounts) account.run(item.id, item.name, item.description, item.color, Number(item.archived ?? false));
  const category = db.prepare('INSERT INTO categories(id,name,color) VALUES (?,?,?)');
  for (const item of data.categories) category.run(item.id, item.name, item.color);
  const tag = db.prepare('INSERT INTO tags(id,name,color,archived) VALUES (?,?,?,?)');
  for (const item of data.tags) tag.run(item.id, item.name, item.color, Number(item.archived));
  const transaction = db.prepare(`INSERT INTO transactions(id,date,amount,kind,account_id,category_id,note,version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const item of data.transactions) {
    transaction.run(item.id, item.date, item.amount, item.kind, item.account_id, item.category_id, item.note, item.version, item.created_at, item.updated_at);
    set_transaction_tags(db, item.id, item.tag_ids);
  }
  const budget = db.prepare('INSERT INTO budgets VALUES (?,?,?)');
  for (const item of data.budgets) budget.run(item.tag_id, item.month, item.amount);
  const savedWorkspace = db.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?,?)');
  for (const item of data.workspaces) savedWorkspace.run(item.id, item.title, serialize_snapshot(item.snapshot), item.version, item.created_at, item.updated_at);
}
