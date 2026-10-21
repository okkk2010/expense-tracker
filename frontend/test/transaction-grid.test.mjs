import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

const source = await readFile(new URL('../src/transaction-grid.ts', import.meta.url), 'utf8')
const grid = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`)
const { GRID_COLUMNS, createGridRow, isGridRowEmpty, parseClipboard, applyGridPaste, validateGridRows } = grid
const bootstrap = {
  accounts: [{ id: 'bank', name: '기업은행' }, { id: 'card', name: '국민카드' }],
  categories: [{ id: 'food', name: '식사' }, { id: 'transport', name: '교통' }],
  tags: [{ id: 'date', name: '데이트', archived: false }, { id: 'weekend', name: '주말 외출', archived: false }, { id: 'old', name: '옛 태그', archived: true }],
  settings: {},
}
const row = (changes = {}) => ({ ...createGridRow(bootstrap, '2026-10-22'), amount: '1000', ...changes })

test('blank rows keep the agreed defaults without creating transactions, including empty catalogs', () => {
  assert.deepEqual(GRID_COLUMNS, ['date', 'kind', 'account', 'category', 'note', 'tags', 'amount'])
  const empty = createGridRow(bootstrap, '2026-10-22')
  assert.equal(empty.account, '국민카드')
  assert.equal(empty.category, '식사')
  assert.equal(empty.kind, '지출')
  assert.equal(isGridRowEmpty(empty), true)
  assert.deepEqual(validateGridRows([empty], bootstrap), { items: [], errors: {} })
  assert.equal(createGridRow({ ...bootstrap, accounts: [bootstrap.accounts[0]] }, empty.date).account, '기업은행')
  assert.equal(createGridRow({ ...bootstrap, accounts: [], categories: [] }, empty.date).account, '')
  assert.equal(isGridRowEmpty({ ...empty, amount: '0' }), false)
  assert.equal(isGridRowEmpty({ ...empty, note: '메모만 입력' }), false)
})

test('Excel TSV preserves quoted multiline notes, embedded tabs, escaped quotes and formulas as literal text', () => {
  const parsed = parseClipboard('2026/10/22\t지출\t국민카드\t식사\t"첫 줄\r\n둘째\t줄 ""인용"""\t#데이트\t1,000\r\n')
  assert.deepEqual(parsed[0], ['2026/10/22', '지출', '국민카드', '식사', '첫 줄\n둘째\t줄 "인용"', '#데이트', '1,000'])
  assert.equal(parsed.length, 1)
  assert.deepEqual(parseClipboard('셀\t\r\n'), [['셀', '']])
  assert.deepEqual(parseClipboard('=SUM(A1:A2)\t+cmd\t12" 피자')[0], ['=SUM(A1:A2)', '+cmd', '12" 피자'])
  assert.deepEqual(parseClipboard(''), [])
  assert.throws(() => parseClipboard('"미완성\t셀'), /따옴표/)
  assert.throws(() => parseClipboard('"닫힘"추가'), /따옴표/)
})

test('pasting from a selected cell expands rows and preserves unaffected cells and original data', () => {
  const initial = [row({ note: '유지', amount: '9000' })]
  const before = structuredClone(initial)
  const result = applyGridPaste(initial, 0, 4, [['새 메모', '#데이트', '2,000'], ['다음 거래', '', '0']], bootstrap, '2026-10-23')
  assert.deepEqual(initial, before)
  assert.equal(result[0].id, initial[0].id)
  assert.equal(result[0].account, '국민카드')
  assert.equal(result[0].amount, '2,000')
  assert.equal(result[1].date, '2026-10-23')
  assert.notEqual(result[1].id, result[0].id)
  assert.deepEqual(validateGridRows(result, bootstrap).items.map(item => item.amount), [2000, 0])
})

test('trailing empty clipboard rows and columns are trimmed while intentional interior blanks clear cells', () => {
  const initial = [row({ note: '기존', tags: '데이트' }), row({ note: '기존', tags: '데이트' })]
  const result = applyGridPaste(initial, 0, 4, [['', '', '1000', ''], ['다음', '주말 외출', '2000', ''], ['', '', '', '']], bootstrap, '2026-10-22')
  assert.equal(result.length, 2)
  assert.equal(result[0].note, '')
  assert.equal(result[0].tags, '')
  assert.equal(result[1].tags, '주말 외출')
  assert.equal(applyGridPaste(initial, 0, 0, [['', ''], ['']], bootstrap, '2026-10-22'), initial)
})

test('column and 500-row overflow reject the complete paste without modifying existing rows', () => {
  const initial = [row({ note: '원본' })], before = structuredClone(initial)
  assert.throws(() => applyGridPaste(initial, 0, 6, [['1', '초과']], bootstrap, '2026-10-22'), /금액 열/)
  assert.throws(() => applyGridPaste(initial, 499, 6, [['1'], ['2']], bootstrap, '2026-10-22'), /500행/)
  assert.throws(() => applyGridPaste(initial, -1, 0, [['1']], bootstrap, '2026-10-22'), /시작/)
  assert.deepEqual(initial, before)
  assert.equal(applyGridPaste(initial, 499, 6, [['1']], bootstrap, '2026-10-22').length, 500)
})

test('validation normalizes calendar dates, Korean/English kinds, won amounts and known tag names or IDs', () => {
  const rows = [
    row({ date: '2024/2/29', kind: ' INCOME ', account: 'bank', category: 'transport', amount: '₩ 1,234 원', tags: '#데이트 #주말 외출', note: '  여러 줄\n메모  ' }),
    row({ kind: '이체', amount: '9,000,000,000,000', tags: 'date, date,주말 외출' }),
    row({ kind: 'expense', amount: '0' }),
  ]
  const { items, errors } = validateGridRows(rows, bootstrap)
  assert.deepEqual(errors, {})
  assert.deepEqual(items[0], { date: '2024-02-29', kind: 'income', account_id: 'bank', category_id: 'transport', amount: 1234, tag_ids: ['date', 'weekend'], note: '여러 줄\n메모' })
  assert.equal(items[1].amount, 9_000_000_000_000)
  assert.equal(items[1].kind, 'transfer')
  assert.deepEqual(items[1].tag_ids, ['date', 'weekend'])
  assert.equal(items[2].amount, 0)
})

test('invalid dates, fractional/negative/formula amounts, and unknown catalog values have cell errors and no partial payload', () => {
  const invalid = row({ date: '2026-02-29', kind: '기타', account: '미등록', category: '미등록', amount: '=1+2', tags: '없는 태그' })
  const result = validateGridRows([row(), invalid], bootstrap)
  assert.deepEqual(result.items, [])
  for (const column of ['date', 'kind', 'account', 'category', 'amount', 'tags']) assert.ok(result.errors[invalid.id][column])
  for (const amount of ['', '-1', '1.5', '1e3', '1,,000', '1,00', '9000000000001']) {
    const candidate = row({ amount, note: '작성한 행' })
    assert.ok(validateGridRows([candidate], bootstrap).errors[candidate.id].amount, amount)
  }
  for (const date of ['0000-01-01', '2026-13-01', '2026-04-31', '2026-1-2', '2026/0/1']) {
    const candidate = row({ date })
    assert.ok(validateGridRows([candidate], bootstrap).errors[candidate.id].date, date)
  }
})

test('archived tags can only be preserved on the particular existing record that already contains them', () => {
  const original = row({ id: 'existing', tags: '옛 태그, 데이트' }), added = row({ tags: 'old' })
  assert.ok(validateGridRows([original], bootstrap).errors.existing.tags)
  const options = { existingTagIds: { existing: ['old'] } }
  assert.deepEqual(validateGridRows([original], bootstrap, options).items[0].tag_ids, ['old', 'date'])
  assert.ok(validateGridRows([added], bootstrap, options).errors[added.id].tags)
})

test('comma/hash tag names cannot replace separate selected tags when saving an existing row', () => {
  const catalog = { ...bootstrap, tags: [
    { id: 'a', name: 'A', archived: false }, { id: 'b', name: 'B', archived: false },
    { id: 'combined', name: 'A, B', archived: false }, { id: 'hash-name', name: 'A#B', archived: false },
  ] }
  for (const tags of ['A, B', '#A #B', 'A#B']) {
    assert.deepEqual(validateGridRows([row({ tags })], catalog).items[0].tag_ids, ['a', 'b'])
  }
  assert.deepEqual(validateGridRows([row({ tags: 'combined, hash-name' })], catalog).items[0].tag_ids, ['combined', 'hash-name'])
})

test('delimiter-containing restored tag IDs fail explicitly instead of becoming different tag selections', () => {
  const catalog = { ...bootstrap, tags: [
    { id: 'a', name: 'A', archived: false }, { id: 'b', name: 'B', archived: false },
    { id: 'a,b', name: '쉼표 ID', archived: false }, { id: 'a#b', name: '해시 ID', archived: false },
  ] }
  for (const tags of ['a,b', 'a#b', 'a,b, a', '#a#b']) {
    const candidate = row({ tags }), result = validateGridRows([candidate], catalog)
    assert.deepEqual(result.items, [])
    assert.ok(result.errors[candidate.id].tags)
  }
  assert.deepEqual(validateGridRows([row({ tags: '쉼표 ID, 해시 ID' })], catalog).items[0].tag_ids, ['a,b', 'a#b'])
})

test('ambiguous names require IDs and excessive batch size or note length cannot produce a valid payload', () => {
  const catalog = { ...bootstrap, accounts: [...bootstrap.accounts, { id: 'other-card', name: '국민카드' }] }
  const ambiguous = row()
  assert.ok(validateGridRows([ambiguous], catalog).errors[ambiguous.id].account)
  assert.equal(validateGridRows([{ ...ambiguous, account: 'card' }], catalog).items[0].account_id, 'card')
  const tooMany = Array.from({ length: 501 }, () => row())
  assert.deepEqual(validateGridRows(tooMany, bootstrap).items, [])
  assert.ok(validateGridRows(tooMany, bootstrap).errors[tooMany[500].id].amount)
  const longNote = row({ note: '가'.repeat(5001) })
  assert.ok(validateGridRows([longNote], bootstrap).errors[longNote.id].note)
})

test('imported record IDs and kind names never inherit object prototype properties', () => {
  const invalid = row({ id: '__proto__', kind: 'constructor' })
  const result = validateGridRows([invalid], bootstrap, { existingTagIds: {} })
  assert.deepEqual(result.items, [])
  assert.deepEqual(Object.keys(result.errors), ['__proto__'])
  assert.ok(result.errors.__proto__.kind)
  assert.ok(validateGridRows([row({ id: 'toString', tags: 'old' })], bootstrap, { existingTagIds: {} }).errors.toString.tags)
})
