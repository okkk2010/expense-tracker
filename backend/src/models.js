import { z } from 'zod';

const text = () => z.string().trim();
export const identifier = text().min(1).max(120);
export const money = z.number().int().min(0).max(9_000_000_000_000);
export const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const color = text().regex(/^#[0-9a-fA-F]{6}$/);
export const isoDate = text().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  if (Number(value.slice(0, 4)) < 1) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}, '날짜는 유효한 YYYY-MM-DD 형식이어야 합니다.');
export const month = text().regex(/^\d{4}-(0[1-9]|1[0-2])$/).refine(value => Number(value.slice(0, 4)) >= 1);
const tagIds = z.array(identifier).max(100).transform(values => [...new Set(values)]);
const kind = z.enum(['expense', 'income', 'transfer']);
const transactionFields = {
  date: isoDate, amount: money, kind,
  account_id: identifier, category_id: identifier,
  tag_ids: tagIds.default([]), note: text().max(5000).default(''),
};
export const transactionInput = z.strictObject(transactionFields);
export const transactionPatch = z.strictObject({
  version, date: isoDate.optional(), amount: money.optional(), kind: kind.optional(),
  account_id: identifier.optional(), category_id: identifier.optional(),
  tag_ids: tagIds.optional(), note: text().max(5000).optional(),
});
export const batchInput = z.strictObject({ items: z.array(transactionInput).min(1).max(500) });
export const budgetInput = z.strictObject({ amount: money });
export const namedInput = z.strictObject({ name: text().min(1).max(120), color: color.default('#64748b') });
export const namedPatch = z.strictObject({ name: text().min(1).max(120).optional(), color: color.optional() });
const snapshot = z.record(z.string(), z.unknown());
const workspaceFields = { title: text().min(1).max(200), snapshot };
export const workspaceInput = z.strictObject(workspaceFields);
export const workspaceUpdate = z.strictObject({ ...workspaceFields, version });
// Omitted filters must remain omitted so a referenced workspace keeps its scope.
export const analysisFilters = z.strictObject({
  start: isoDate.nullable().optional(), end: isoDate.nullable().optional(),
  tag_ids: tagIds.optional(), tag_mode: z.enum(['or', 'and']).optional(),
  category_id: identifier.nullable().optional(), account_id: identifier.nullable().optional(),
});
export const analysisInput = z.strictObject({
  prompt: text().min(1).max(10000), filters: analysisFilters.nullable().optional(),
  reference: snapshot.nullable().optional(),
});
const timestamp = text().min(1).max(60).refine(value => !Number.isNaN(Date.parse(value)), '유효한 시간 형식이어야 합니다.');
const timestampFields = { created_at: timestamp, updated_at: timestamp };
export const backupInput = z.strictObject({
  schema_version: z.literal(1), exported_at: timestamp,
  accounts: z.array(z.strictObject({ id: identifier, name: text().min(1).max(120), description: text().max(5000), color })).max(1000),
  categories: z.array(z.strictObject({ id: identifier, name: text().min(1).max(120), color })).max(10000),
  tags: z.array(z.strictObject({ id: identifier, name: text().min(1).max(120), color, archived: z.boolean() })).max(10000),
  transactions: z.array(z.strictObject({ ...transactionFields, ...timestampFields, id: identifier, version })).max(100000),
  budgets: z.array(z.strictObject({ tag_id: identifier, month, amount: money })).max(100000),
  workspaces: z.array(z.strictObject({ ...workspaceFields, ...timestampFields, id: identifier, version })).max(10000),
  settings: snapshot.default({}),
});
export const transactionQuery = z.object({
  start: isoDate.optional(), end: isoDate.optional(), account_id: text().optional(), category_id: text().optional(),
  tag_ids: text().default(''), tag_mode: z.enum(['or', 'and']).default('or'), kind: kind.optional(), q: text().default(''),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});
export const monthQuery = z.object({ month: month.optional() });
export const deleteVersionQuery = z.object({ version: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export const tagDeleteQuery = z.object({ mode: z.enum(['archive', 'detach']).default('archive') });

export function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Object.assign(new Error('입력 내용을 확인해 주세요.'), {
      statusCode: 422,
      detail: result.error.issues.map(issue => ({ loc: issue.path, msg: issue.message, type: issue.code })),
    });
  }
  return result.data;
}
