import { useEffect, useId, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { AlertTriangle, CalendarDays, Check, Copy, Plus, Trash2 } from 'lucide-react'
import { api, ApiError, errorMessage, json } from '../api'
import type { Bootstrap, ScreenProps, Transaction } from '../types'
import { applyGridPaste, createGridRow, GRID_COLUMNS, isGridRowEmpty, parseClipboard, validateGridRows, type GridColumn, type GridRow } from '../transaction-grid'
import { money, today } from '../utils'
import { Modal } from './Shared'

const MAX_ROWS = 500
const labels: Record<GridColumn, string> = { date: '날짜', kind: '유형', account: '금융수단', category: '종목', note: '메모', tags: '태그', amount: '금액' }
const kinds = { expense: '지출', income: '수입', transfer: '이체' } as const
const kindLabels: Record<string, string> = { ...kinds, 출금: '지출', 입금: '수입', 계좌이체: '이체', 송금: '이체' }
type CellErrors = Record<string, Partial<Record<GridColumn, string>>>
type Props = { bootstrap: Bootstrap; initial: Transaction | null; onClose: () => void; onSaved: () => void; notify: ScreenProps['notify'] }

function transactionRow(item: Transaction, bootstrap: Bootstrap): GridRow {
  return {
    id: item.id, date: item.date, kind: kinds[item.kind], amount: String(item.amount), note: item.note,
    account: item.account_id,
    category: item.category_id,
    tags: item.tag_ids.map((id, index) => {
      const name = bootstrap.tags.find(tag => tag.id === id)?.name || item.tag_names[index] || id
      return /[,#]/.test(name) || bootstrap.tags.filter(tag => tag.name === name).length > 1 ? id : name
    }).join(', '),
  }
}
const rowValues = (row: GridRow) => JSON.stringify(GRID_COLUMNS.map(column => row[column]))
const clipboardCell = (value: string) => /[\t\r\n"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value

export function DesktopTransactionEditor({ bootstrap, initial, onClose, onSaved, notify }: Props) {
  const [baseDate, setBaseDate] = useState(initial?.date || today())
  const [rows, setRows] = useState<GridRow[]>(() => initial ? [transactionRow(initial, bootstrap)] : Array.from({ length: 8 }, () => createGridRow(bootstrap, today())))
  const [selectedId, setSelectedId] = useState(rows[0].id)
  const [errors, setErrors] = useState<CellErrors>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [version, setVersion] = useState(initial?.version || 1)
  const [conflict, setConflict] = useState<Transaction | null>(null)
  const [conflictAction, setConflictAction] = useState<'save' | 'delete'>('save')
  const [existingTagIds, setExistingTagIds] = useState<Record<string, string[]>>(() => initial ? { [initial.id]: initial.tag_ids } : {})
  const [existingAccountIds, setExistingAccountIds] = useState<Record<string, string>>(() => initial ? { [initial.id]: initial.account_id } : {})
  const baseline = useRef(initial ? rowValues(rows[0]) : '')
  const root = useRef<HTMLDivElement>(null)
  const helpId = useId()
  const tagListId = useId()
  const filledRows = rows.filter(row => !isGridRowEmpty(row))
  const expenseTotal = filledRows.reduce((sum, row) => {
    const item = validateGridRows([row], bootstrap, { existingTagIds, existingAccountIds }).items[0]
    return item?.kind === 'expense' ? sum + item.amount : sum
  }, 0)
  const dirty = initial ? rowValues(rows[0]) !== baseline.current : filledRows.length > 0

  function focusCell(row: number, column: number) {
    requestAnimationFrame(() => {
      const control = root.current?.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-grid-row="${row}"][data-grid-col="${column}"]`)
      control?.focus()
      if (control instanceof HTMLInputElement && control.type === 'text') control.select()
    })
  }
  useEffect(() => { focusCell(0, GRID_COLUMNS.indexOf('note')) }, [])

  function close() {
    if (busyRef.current) return
    if (dirty && !window.confirm('저장하지 않은 거래 내용이 있어요. 입력 창을 닫을까요?')) return
    onClose()
  }
  function update(id: string, column: GridColumn, value: string) {
    if (busyRef.current) return
    setRows(current => current.map(row => row.id === id ? { ...row, [column]: value } : row))
    setErrors(current => ({ ...current, [id]: { ...current[id], [column]: undefined } }))
    setError('')
  }
  function addRows(count: number) {
    if (busyRef.current || initial) return
    const available = MAX_ROWS - rows.length
    if (!available) { notify('한 번에 최대 500행까지 입력할 수 있어요.', true); return }
    const first = rows.length
    setRows(current => [...current, ...Array.from({ length: Math.min(count, available) }, () => createGridRow(bootstrap, baseDate))])
    focusCell(first, GRID_COLUMNS.indexOf('note'))
  }
  function duplicateRow() {
    if (busyRef.current || initial) return
    if (rows.length >= MAX_ROWS) { notify('한 번에 최대 500행까지 입력할 수 있어요.', true); return }
    const index = Math.max(0, rows.findIndex(row => row.id === selectedId))
    const duplicate = { ...rows[index], id: crypto.randomUUID() }
    setRows(current => [...current.slice(0, index + 1), duplicate, ...current.slice(index + 1)])
    setSelectedId(duplicate.id)
    focusCell(index + 1, GRID_COLUMNS.indexOf('note'))
  }
  function removeRow(id: string) {
    if (busyRef.current || initial) return
    const index = rows.findIndex(row => row.id === id)
    const next = rows.filter(row => row.id !== id)
    if (!next.length) next.push(createGridRow(bootstrap, baseDate))
    setRows(next)
    setErrors(current => { const result = { ...current }; delete result[id]; return result })
    if (selectedId === id) setSelectedId(next[Math.min(index, next.length - 1)].id)
  }
  async function copyRows() {
    if (busyRef.current) return
    if (!filledRows.length) { notify('복사할 거래를 먼저 입력해 주세요.'); return }
    try {
      const cell = (row: GridRow, column: GridColumn) => {
        if (column !== 'account' && column !== 'category') return row[column]
        const catalog = column === 'account' ? bootstrap.accounts : bootstrap.categories
        const item = catalog.find(entry => entry.id === row[column].trim())
        return item && catalog.filter(entry => entry.name === item.name).length === 1
          && !catalog.some(entry => entry.id === item.name && entry.id !== item.id) ? item.name : row[column]
      }
      await navigator.clipboard.writeText(filledRows.map(row => GRID_COLUMNS.map(column => clipboardCell(cell(row, column))).join('\t')).join('\r\n'))
      notify(`${filledRows.length}행을 복사했어요. 스프레드시트에 붙여넣을 수 있어요.`)
    } catch { notify('클립보드에 복사하지 못했어요. 브라우저의 클립보드 권한을 확인해 주세요.', true) }
  }
  function gridKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    if (event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey || busyRef.current) return
    const control = event.target as HTMLInputElement | HTMLSelectElement
    if (control.dataset.gridRow === undefined || control.dataset.gridCol === undefined) return
    const row = Number(control.dataset.gridRow), column = Number(control.dataset.gridCol)
    let nextRow = row, nextColumn = column
    if (event.key === 'Tab') {
      nextColumn += event.shiftKey ? -1 : 1
      if (nextColumn < 0) { nextRow--; nextColumn = GRID_COLUMNS.length - 1 }
      if (nextColumn >= GRID_COLUMNS.length) { nextRow++; nextColumn = 0 }
      if (nextRow < 0 || (nextRow >= rows.length && (initial || rows.length >= MAX_ROWS))) return
    } else if (event.key === 'Enter') nextRow += event.shiftKey ? -1 : 1
    else if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !(control instanceof HTMLSelectElement)) nextRow += event.key === 'ArrowUp' ? -1 : 1
    else return
    event.preventDefault()
    if (nextRow < 0) return
    if (nextRow >= rows.length) {
      if (initial || rows.length >= MAX_ROWS) return
      setRows(current => [...current, createGridRow(bootstrap, baseDate)])
    }
    focusCell(nextRow, nextColumn)
  }
  function paste(event: ClipboardEvent<HTMLTableElement>) {
    if (busyRef.current) { event.preventDefault(); return }
    const control = event.target as HTMLInputElement | HTMLSelectElement
    if (control.dataset.gridRow === undefined || control.dataset.gridCol === undefined) return
    const text = event.clipboardData.getData('text/plain')
    const select = control instanceof HTMLSelectElement
    if (!select && !/[\t\r\n]/.test(text)) return
    try {
      const matrix = parseClipboard(text)
      while (matrix.length > 1 && matrix.at(-1)!.every(value => !value.trim())) matrix.pop()
      if (!select && matrix.length === 1 && matrix[0]?.length === 1) return
      event.preventDefault()
      if (initial && matrix.length > 1) throw new Error('거래 수정에서는 한 행만 붙여넣을 수 있어요. 여러 거래는 새 기록에서 입력해 주세요.')
      const next = applyGridPaste(rows, Number(control.dataset.gridRow), Number(control.dataset.gridCol), matrix, bootstrap, baseDate)
      setRows(next)
      setErrors({})
      setError('')
    } catch (caught) { event.preventDefault(); setError(errorMessage(caught)); notify(errorMessage(caught), true) }
  }
  async function save(overwriteVersion?: number) {
    if (busyRef.current || (conflict && overwriteVersion === undefined)) return
    const result = validateGridRows(rows, bootstrap, { existingTagIds, existingAccountIds })
    setErrors(result.errors)
    if (Object.keys(result.errors).length) {
      setError('빨간색으로 표시된 셀을 확인해 주세요. 모든 행이 올바를 때 한 번에 저장돼요.')
      for (let row = 0; row < rows.length; row++) {
        const column = GRID_COLUMNS.findIndex(key => result.errors[rows[row].id]?.[key])
        if (column >= 0) { focusCell(row, column); break }
      }
      return
    }
    if (!result.items.length) { setError('저장할 거래를 먼저 입력해 주세요. 빈 행은 저장하지 않아요.'); focusCell(0, GRID_COLUMNS.indexOf('amount')); return }
    if (result.items.length > MAX_ROWS) { setError('한 번에 최대 500건까지 저장할 수 있어요.'); return }
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      if (initial) await api<Transaction>(`/transactions/${initial.id}`, { method: 'PATCH', body: json({ ...result.items[0], version: overwriteVersion ?? version }) })
      else await api('/transactions/batch', { method: 'POST', body: json({ items: result.items }) })
      notify(initial ? '거래를 수정했어요.' : `${result.items.length}건의 기록을 저장했어요.`)
      onSaved()
      onClose()
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const current = (caught.detail as { current?: Transaction }).current
        if (current) { setConflict(current); setConflictAction('save') } else setError(caught.message)
      } else setError(errorMessage(caught))
    } finally { busyRef.current = false; setBusy(false) }
  }
  async function remove() {
    if (!initial || busyRef.current || !window.confirm('이 거래를 삭제할까요? 삭제한 거래는 되돌릴 수 없습니다.')) return
    busyRef.current = true
    setBusy(true)
    setError('')
    try {
      await api(`/transactions/${initial.id}?version=${version}`, { method: 'DELETE' })
      notify('거래를 삭제했어요.')
      onSaved()
      onClose()
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const current = (caught.detail as { current?: Transaction }).current
        if (current) { setConflict(current); setConflictAction('delete') } else setError(caught.message)
      } else setError(errorMessage(caught))
    } finally { busyRef.current = false; setBusy(false) }
  }
  function loadLatest() {
    if (!conflict || busyRef.current) return
    const latest = transactionRow(conflict, bootstrap)
    setRows([latest]); setBaseDate(latest.date); setSelectedId(latest.id)
    setVersion(conflict.version); setExistingTagIds({ [conflict.id]: conflict.tag_ids })
    setExistingAccountIds({ [conflict.id]: conflict.account_id })
    baseline.current = rowValues(latest)
    setConflict(null); setErrors({}); setError('')
    focusCell(0, GRID_COLUMNS.indexOf('note'))
  }

  return <Modal title={initial ? '거래 수정' : '거래 입력'} subtitle={initial ? '표에서 기록을 수정하고 변경 내용을 저장하세요.' : '엑셀처럼 셀을 이동하며 입력하거나 여러 거래를 한 번에 붙여넣으세요.'} onClose={close} wide>
    <div className="transaction-grid-editor" ref={root}><form noValidate onSubmit={event => { event.preventDefault(); void save() }} onKeyDown={event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!event.nativeEvent.isComposing) void save() }
    }}>
      <div className="transaction-grid-toolbar"><label className="grid-base-date"><CalendarDays size={17}/><span>{initial ? '기록 날짜' : '기본 날짜'}</span><input type="date" aria-label={initial ? '기록 날짜' : '새 행 기본 날짜'} value={initial ? rows[0].date : baseDate} disabled={busy} onChange={event => {
        if (busyRef.current) return
        const date = event.target.value
        setBaseDate(date)
        if (initial) update(rows[0].id, 'date', date)
        else setRows(current => current.map(row => isGridRowEmpty(row) ? { ...row, date } : row))
      }}/></label><div className="grid-toolbar-actions"><button type="button" className="secondary-button small-button" onClick={() => void copyRows()} disabled={busy || !filledRows.length}><Copy size={15}/>입력 행 복사</button>{!initial && <><button type="button" className="secondary-button small-button" onClick={duplicateRow} disabled={busy || rows.length >= MAX_ROWS}><Copy size={15}/>선택 행 복제</button><button type="button" className="secondary-button small-button" onClick={() => addRows(5)} disabled={busy || rows.length >= MAX_ROWS}><Plus size={15}/>5행 추가</button></>}</div></div>
      <p className="transaction-grid-help grid-help" id={helpId}>날짜 → 유형 → 금융수단 → 종목 → 메모 → 태그 → 금액 순서로 붙여넣으세요. 태그는 쉼표로 구분해요. 빈 행은 저장하지 않으며 최대 500건까지 입력할 수 있어요.</p>
      <div className="transaction-grid-scroll"><table className="transaction-grid" role="grid" aria-label="거래 일괄 입력 표" aria-describedby={helpId} aria-rowcount={rows.length + 1} aria-colcount={GRID_COLUMNS.length + 2} onKeyDown={gridKeyDown} onPaste={paste}>
        <colgroup><col className="grid-col-index"/>{GRID_COLUMNS.map(column => <col key={column} className={`grid-col-${column}`}/>)}<col className="grid-col-remove"/></colgroup>
        <thead><tr><th scope="col">행</th>{GRID_COLUMNS.map(column => <th key={column} scope="col">{labels[column]}{column === 'amount' && <span className="muted"> (원)</span>}</th>)}<th scope="col"><span className="visually-hidden">행 제거</span></th></tr></thead>
        <tbody>{rows.map((row, index) => <tr key={row.id} className={`grid-row ${selectedId === row.id ? 'is-selected' : ''} ${isGridRowEmpty(row) ? 'is-empty' : 'is-dirty'} ${Object.values(errors[row.id] || {}).some(Boolean) ? 'has-errors' : ''}`} aria-selected={selectedId === row.id} onFocus={() => setSelectedId(row.id)}>
          <th scope="row"><button type="button" className="grid-row-number" aria-label={`${index + 1}행 선택`} disabled={busy} onClick={() => focusCell(index, 0)}>{index + 1}</button></th>
          {GRID_COLUMNS.map((column, columnIndex) => {
            const message = errors[row.id]?.[column]
            const errorId = `${tagListId}-${row.id}-${column}-error`
            const common = { 'data-grid-row': index, 'data-grid-col': columnIndex, 'aria-label': `${index + 1}행 ${labels[column]}`, 'aria-invalid': !!message, 'aria-describedby': message ? errorId : undefined, disabled: busy, value: row[column], className: `grid-control grid-control-${column}`, onChange: (event: { target: { value: string } }) => update(row.id, column, event.target.value) }
            const tagPrefix = row.tags.includes(',') ? `${row.tags.slice(0, row.tags.lastIndexOf(',') + 1)} ` : ''
            const catalog = column === 'account' ? bootstrap.accounts.filter(account => !account.archived || existingAccountIds[row.id] === account.id) : column === 'category' ? bootstrap.categories : []
            const byId = catalog.find(item => item.id === row[column].trim())
            const byName = catalog.filter(item => item.name === row[column].trim())
            const resolved = byId || (byName.length === 1 ? byName[0] : undefined)
            return <td key={column} className={`grid-cell grid-cell-${column} ${message ? 'is-invalid' : ''}`}>
              {column === 'kind' ? <select {...common}>{!Object.values(kinds).some(kind => kind === row.kind) && <option value={row.kind}>{Object.hasOwn(kindLabels, row.kind.trim().toLowerCase()) ? kindLabels[row.kind.trim().toLowerCase()] : row.kind || '선택'}</option>}{Object.values(kinds).map(kind => <option key={kind}>{kind}</option>)}</select>
                : column === 'account' || column === 'category' ? <select {...common} value={resolved?.id || row[column]}><option value="">선택</option>{row[column] && !resolved && <option value={row[column]}>{row[column]}</option>}{catalog.map(item => <option key={item.id} value={item.id}>{item.name}{'archived' in item && item.archived ? ' · 보관됨' : ''}</option>)}</select>
                  : <input {...common} type="text" inputMode={column === 'amount' ? 'numeric' : column === 'date' ? 'numeric' : undefined} autoComplete="off" maxLength={column === 'note' ? 5000 : column === 'tags' ? 12200 : column === 'date' ? 32 : 64} placeholder={column === 'date' ? 'YYYY-MM-DD' : column === 'amount' ? '0' : column === 'tags' ? '태그, 태그' : '메모 입력'} list={column === 'tags' ? `${tagListId}-${row.id}` : undefined}/>}
              {column === 'tags' && <datalist id={`${tagListId}-${row.id}`}>{bootstrap.tags.filter(tag => !tag.archived || existingTagIds[row.id]?.includes(tag.id)).map(tag => <option key={tag.id} value={`${tagPrefix}${/[,#]/.test(tag.name) || bootstrap.tags.filter(item => item.name === tag.name).length > 1 ? tag.id : tag.name}`}>{tag.name}{tag.archived ? ' · 보관된 태그' : ''}</option>)}</datalist>}
              {message && <span className="grid-error" id={errorId}>{message}</span>}
            </td>
          })}
          <td className="grid-cell grid-cell-remove">{!initial && <button type="button" className="icon-button grid-row-remove" disabled={busy} onClick={() => removeRow(row.id)} aria-label={`${index + 1}행 제거`}><Trash2 size={14}/></button>}</td>
        </tr>)}</tbody>
      </table></div>
      {error && <div className="error-message" role="alert"><AlertTriangle size={16}/>{error}</div>}
      {conflict && <div className="conflict-box" role="alert"><h3><AlertTriangle size={17}/>다른 곳에서 기록이 수정됐어요</h3><p>{conflictAction === 'delete' ? '삭제 전에 최신 내용을 불러와 확인해 주세요.' : '최신 기록을 불러오거나 내가 입력한 내용으로 다시 저장할 수 있어요.'}</p><div className="conflict-compare"><div><strong>서버의 최신 기록</strong><span>{conflict.date} · {money(conflict.amount)}</span><span>{conflict.note || '메모 없음'} · {conflict.account_name}</span><small>버전 {conflict.version}</small></div><div><strong>내가 수정한 내용</strong><span>{rows[0].date} · {rows[0].amount || '0'}원</span><span>{rows[0].note || '메모 없음'} · {bootstrap.accounts.find(account => account.id === rows[0].account.trim())?.name || rows[0].account}</span><small>버전 {version}에서 수정</small></div></div><div className="button-row"><button type="button" className="secondary-button" disabled={busy} onClick={loadLatest}>최신 내용 불러오기</button>{conflictAction === 'save' && <button type="button" className="primary-button" disabled={busy} onClick={() => void save(conflict.version)}>내 수정 내용으로 저장</button>}</div></div>}
      <div className="transaction-grid-footer"><div className="grid-summary"><strong>{filledRows.length}건 입력</strong><span>지출 합계 <strong>{money(expenseTotal)}</strong></span><small className="grid-shortcuts">Tab 셀 이동 · Enter 다음 행 · Ctrl / ⌘ + Enter 저장</small></div><div className="grid-footer-actions button-row">{initial && <button type="button" className="danger-button" disabled={busy || !!conflict} onClick={() => void remove()}><Trash2 size={16}/>삭제</button>}<button type="button" className="secondary-button" onClick={close} disabled={busy}>취소</button><button type="submit" className="primary-button" disabled={busy || !!conflict}><Check size={16}/>{busy ? '저장 중…' : initial ? '변경 저장' : `${filledRows.length}건 저장하기`}</button></div></div>
    </form></div>
  </Modal>
}
