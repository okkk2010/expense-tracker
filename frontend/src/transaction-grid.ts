import type { Bootstrap, Kind, TransactionDraft } from './types'

export type GridColumn = 'date' | 'kind' | 'account' | 'category' | 'note' | 'tags' | 'amount'
export const GRID_COLUMNS: readonly GridColumn[] = ['date', 'kind', 'account', 'category', 'note', 'tags', 'amount']
export type GridRow = { id: string; date: string; kind: string; account: string; category: string; note: string; tags: string; amount: string }
export type GridErrors = Record<string, Partial<Record<GridColumn, string>>>
export type GridValidationOptions = { existingTagIds?: Record<string, string[]> }

const MAX_ROWS = 500
const MAX_AMOUNT = 9_000_000_000_000

export function createGridRow(bootstrap: Bootstrap, date: string): GridRow {
  return {
    id: crypto.randomUUID(), date, kind: '지출',
    account: bootstrap.accounts[1]?.name || bootstrap.accounts[0]?.name || '',
    category: bootstrap.categories[0]?.name || '', note: '', tags: '', amount: '',
  }
}

export function isGridRowEmpty(row: GridRow): boolean {
  return !row.amount.trim() && !row.note.trim() && !row.tags.trim()
}

/** Read Excel/Sheets tab-separated text without evaluating cell contents. */
export function parseClipboard(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '')
  if (!source) return []
  const rows: string[][] = []
  let row: string[] = [], cell = '', quoted = false, closedQuote = false
  const finishCell = () => { row.push(cell); cell = ''; closedQuote = false }
  for (let index = 0; index < source.length; index++) {
    const character = source[index]
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') { cell += '"'; index++ }
        else { quoted = false; closedQuote = true }
      } else if (character === '\r') {
        cell += '\n'
        if (source[index + 1] === '\n') index++
      } else cell += character
    } else if (character === '\t') finishCell()
    else if (character === '\n' || character === '\r') {
      finishCell(); rows.push(row); row = []
      if (character === '\r' && source[index + 1] === '\n') index++
    } else if (character === '"' && cell === '' && !closedQuote) quoted = true
    else {
      if (closedQuote) throw new Error('따옴표로 감싼 셀 뒤에는 탭이나 줄바꿈이 필요해요.')
      cell += character
    }
  }
  if (quoted) throw new Error('붙여넣을 내용의 닫는 따옴표를 확인해 주세요.')
  // A terminating line break ends the last row; it does not create another one.
  if (row.length || cell || closedQuote || !/[\r\n]$/.test(source)) { finishCell(); rows.push(row) }
  return rows
}

/** Check the entire paste before changing any rows, including its outer bounds. */
export function applyGridPaste(
  rows: GridRow[], startRow: number, startColumn: number, matrix: string[][],
  bootstrap: Bootstrap, date: string,
): GridRow[] {
  if (!Number.isInteger(startRow) || startRow < 0 || !Number.isInteger(startColumn) || startColumn < 0 || startColumn >= GRID_COLUMNS.length) {
    throw new Error('붙여넣기를 시작할 셀을 확인해 주세요.')
  }
  const content = matrix.map(row => [...row])
  while (content.length && content[content.length - 1].every(cell => !cell.trim())) content.pop()
  let width = content.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  while (width && content.every(row => !(row[width - 1] || '').trim())) width--
  if (!content.length || !width) return rows
  if (startColumn + width > GRID_COLUMNS.length) throw new Error('붙여넣을 내용이 마지막 금액 열을 넘어가요. 열 순서와 시작 셀을 확인해 주세요.')
  const length = Math.max(rows.length, startRow + content.length)
  if (length > MAX_ROWS) throw new Error('거래는 한 번에 500행까지 입력할 수 있어요.')
  const result = rows.map(row => ({ ...row }))
  while (result.length < length) result.push(createGridRow(bootstrap, date))
  content.forEach((cells, rowIndex) => cells.slice(0, width).forEach((value, columnIndex) => {
    result[startRow + rowIndex][GRID_COLUMNS[startColumn + columnIndex]] = value
  }))
  return result
}

function calendarDate(value: string): string | null {
  const match = /^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/.exec(value.trim())
  if (!match || (match[2] === '-' && (match[3].length !== 2 || match[4].length !== 2))) return null
  const year = Number(match[1]), month = Number(match[3]), day = Number(match[4])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return null
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function amountInWon(value: string): number | null {
  const match = /^(?:₩|￦|KRW)?\s*(\d+|\d{1,3}(?:,\d{3})+)\s*(?:원|KRW)?$/i.exec(value.trim())
  if (!match) return null
  const amount = Number(match[1].replace(/,/g, ''))
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= MAX_AMOUNT ? amount : null
}

function resolveItem<T extends { id: string; name: string }>(items: T[], value: string): T | undefined {
  const text = value.trim()
  const byId = items.find(item => item.id === text)
  if (byId) return byId
  const matches = items.filter(item => item.name === text)
  return matches.length === 1 ? matches[0] : undefined
}

const kinds: Record<string, Kind> = {
  지출: 'expense', 출금: 'expense', expense: 'expense',
  수입: 'income', 입금: 'income', income: 'income',
  이체: 'transfer', 계좌이체: 'transfer', 송금: 'transfer', transfer: 'transfer',
}

export function validateGridRows(
  rows: GridRow[], bootstrap: Bootstrap, options: GridValidationOptions = {},
): { items: TransactionDraft[]; errors: GridErrors } {
  const items: TransactionDraft[] = [], errors: GridErrors = {}
  let count = 0
  for (const row of rows) {
    if (isGridRowEmpty(row)) continue
    const error: Partial<Record<GridColumn, string>> = {}
    const kindName = row.kind.trim().toLowerCase()
    const date = calendarDate(row.date), kind = Object.hasOwn(kinds, kindName) ? kinds[kindName] : undefined
    const account = resolveItem(bootstrap.accounts, row.account), category = resolveItem(bootstrap.categories, row.category)
    const amount = amountInWon(row.amount), note = row.note.trim()
    if (!date) error.date = '실제 존재하는 날짜를 YYYY-MM-DD 형식으로 입력해 주세요.'
    if (!kind) error.kind = '지출, 수입, 이체 중 하나를 입력해 주세요.'
    if (!account) error.account = '등록된 금융수단의 이름이나 ID를 입력해 주세요.'
    if (!category) error.category = '등록된 종목의 이름이나 ID를 입력해 주세요.'
    if (amount === null) error.amount = '금액은 0원부터 9조 원까지의 정수로 입력해 주세요.'
    if (note.length > 5000) error.note = '메모는 5,000자까지 입력할 수 있어요.'
    const rawTags = row.tags.trim()
    // Commas and hashes always delimit tags. Names containing them use their ID.
    const names = rawTags.split(/[,#]/).map(value => value.trim()).filter(Boolean)
    const ambiguousId = bootstrap.tags.find(tag => {
      if (!/[,#]/.test(tag.id)) return false
      let index = rawTags.indexOf(tag.id)
      while (index !== -1) {
        const before = rawTags.slice(0, index).trimEnd(), after = rawTags.slice(index + tag.id.length).trimStart()
        if ((!before || /[,#]$/.test(before)) && (!after || /^[,#]/.test(after))) return true
        index = rawTags.indexOf(tag.id, index + 1)
      }
      return false
    })
    if (ambiguousId) error.tags = `쉼표나 #이 포함된 태그 ID는 표에서 구분할 수 없어요: ${ambiguousId.id}`
    const existingTags = options.existingTagIds && Object.hasOwn(options.existingTagIds, row.id) ? options.existingTagIds[row.id] : []
    const tagIds: string[] = [], allowedArchived = new Set(existingTags)
    for (const name of names) {
      const tag = resolveItem(bootstrap.tags, name)
      if (!tag) { error.tags = `등록된 태그를 입력해 주세요: ${name}`; continue }
      if (tag.archived && !allowedArchived.has(tag.id)) { error.tags = `보관한 태그는 새로 지정할 수 없어요: ${tag.name}`; continue }
      if (!tagIds.includes(tag.id)) tagIds.push(tag.id)
    }
    if (tagIds.length > 100) error.tags = '태그는 한 거래에 100개까지 지정할 수 있어요.'
    if (++count > MAX_ROWS) error.amount = '거래는 한 번에 500건까지 저장할 수 있어요.'
    if (Object.keys(error).length) Object.defineProperty(errors, row.id, { value: error, enumerable: true, configurable: true, writable: true })
    else items.push({ date: date!, kind: kind!, account_id: account!.id, category_id: category!.id, amount: amount!, tag_ids: tagIds, note })
  }
  return { items: Object.keys(errors).length ? [] : items, errors }
}
