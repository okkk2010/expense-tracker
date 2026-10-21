import { useEffect, useId, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { api, ApiError, errorMessage, json } from '../api'
import type { Account, ScreenProps } from '../types'
import { Modal } from './Shared'
import '../account-manager.css'

type AccountManagerProps = Pick<ScreenProps, 'bootstrap' | 'demo' | 'onRefresh' | 'notify'>
const defaultColor = '#89a978'

export function AccountManager({ bootstrap, demo, onRefresh, notify }: AccountManagerProps) {
  const [editing, setEditing] = useState<Account | null | undefined>(undefined)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(defaultColor)
  const [colorInvalid, setColorInvalid] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Account | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleteBlocked, setDeleteBlocked] = useState(false)
  const busyRef = useRef(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const colorCodeRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  const activeAccounts = bootstrap.accounts.filter(account => !account.archived)
  const archivedAccounts = bootstrap.accounts.filter(account => account.archived)
  const accounts = [...activeAccounts, ...archivedAccounts]

  useEffect(() => { if (editing !== undefined) nameRef.current?.focus() }, [editing])

  function guard() {
    if (busyRef.current) return false
    if (demo) {
      notify('둘러보기에서는 금융수단을 변경하지 않아요. 먼저 실제 서버에 연결해 주세요.')
      return false
    }
    return true
  }

  function openEditor(account: Account | null) {
    if (!guard()) return
    setError('')
    setName(account?.name || '')
    setDescription(account?.description || '')
    setColor(account?.color && /^#[\da-f]{6}$/i.test(account.color) ? account.color : defaultColor)
    setColorInvalid(false)
    setEditing(account)
  }

  function updateColor(value: string) {
    setColor(value)
    setColorInvalid(false)
    setError('')
  }

  function showColorError() {
    setColorInvalid(true)
    setError('색상 코드는 #과 영문 A~F·숫자 6자리로 입력해 주세요. 예: #89a978')
    colorCodeRef.current?.focus()
  }

  function begin(action: string) {
    busyRef.current = true
    setBusy(action)
    setError('')
  }

  function finish() {
    busyRef.current = false
    setBusy(null)
  }

  async function save() {
    if (editing === undefined || !guard()) return
    if (!name.trim()) { setError('금융수단 이름을 입력해 주세요.'); nameRef.current?.focus(); return }
    if (!/^#[\da-f]{6}$/i.test(color)) { showColorError(); return }
    const target = editing
    begin('save')
    try {
      await api<Account>(target ? `/accounts/${encodeURIComponent(target.id)}` : '/accounts', {
        method: target ? 'PATCH' : 'POST',
        body: json({ name: name.trim(), description: description.trim(), color }),
      })
      setEditing(undefined)
      onRefresh()
      notify(target ? '금융수단을 수정했어요. 과거 거래에도 같은 이름이 반영됩니다.' : '금융수단을 추가했어요.')
    } catch (caught) { setError(errorMessage(caught)) }
    finally { finish() }
  }

  async function setArchived(account: Account, archived: boolean, fromDelete = false) {
    if (!guard()) return
    begin(account.id)
    try {
      await api<Account>(`/accounts/${encodeURIComponent(account.id)}`, { method: 'PATCH', body: json({ archived }) })
      if (editing?.id === account.id) setEditing(undefined)
      if (fromDelete) { setDeleteTarget(null); setDeleteError(''); setDeleteBlocked(false) }
      onRefresh()
      notify(archived ? '금융수단을 보관했어요. 기존 거래는 유지됩니다.' : '금융수단을 복원했어요. 새 거래에서 다시 선택할 수 있습니다.')
    } catch (caught) {
      if (fromDelete) setDeleteError(errorMessage(caught))
      else setError(errorMessage(caught))
    } finally { finish() }
  }

  function requestDelete(account: Account) {
    if (!guard()) return
    setError('')
    setDeleteError('')
    setDeleteBlocked(false)
    setDeleteTarget(account)
  }

  async function remove() {
    if (!deleteTarget || !guard()) return
    const target = deleteTarget
    begin(target.id)
    try {
      await api(`/accounts/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
      if (editing?.id === target.id) setEditing(undefined)
      setDeleteTarget(null)
      onRefresh()
      notify('사용하지 않은 금융수단을 삭제했어요.')
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setDeleteBlocked(true)
        setDeleteError('거래에 사용한 금융수단은 삭제할 수 없습니다. 보관하면 기존 기록을 유지하면서 새 거래의 선택 목록에서 숨길 수 있습니다.')
      } else setDeleteError(errorMessage(caught))
    } finally { finish() }
  }

  return <section className="panel settings-panel account-manager" id="account-manager" aria-labelledby={`${fieldId}-heading`}>
    <div className="section-heading">
      <h2 id={`${fieldId}-heading`}>금융수단</h2>
      <div className="account-manager-header-actions">
        <span className="account-manager-count">사용 중 {activeAccounts.length}개{archivedAccounts.length > 0 && ` · 보관 ${archivedAccounts.length}개`}</span>
        {activeAccounts.length > 0 && <button type="button" className="secondary-button" disabled={!!busy} onClick={() => openEditor(null)}><Plus size={15}/>추가</button>}
      </div>
    </div>
    <p className="account-manager-help">이름 변경은 과거 거래에도 반영됩니다. 보관하면 기존 기록은 유지하고 새 거래의 선택 목록에서 숨깁니다.</p>

    {activeAccounts.length === 0 && <div className="account-manager-empty">
      <p>{archivedAccounts.length ? '사용 중인 금융수단이 없습니다. 새로 추가하거나 보관한 금융수단을 복원하세요.' : '등록한 금융수단이 없습니다. 거래에 사용할 금융수단을 추가하세요.'}</p>
      {editing === undefined && <button type="button" className="secondary-button" disabled={!!busy} onClick={() => openEditor(null)}><Plus size={15}/>금융수단 추가</button>}
    </div>}

    {editing !== undefined && <form className="account-manager-form" onSubmit={event => { event.preventDefault(); void save() }} aria-label={editing ? '금융수단 수정' : '금융수단 추가'}>
      <h3>{editing ? '금융수단 수정' : '금융수단 추가'}</h3>
      <div className="account-manager-fields">
        <label className="account-manager-name" htmlFor={`${fieldId}-name`}>이름<input ref={nameRef} id={`${fieldId}-name`} required maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={!!busy} placeholder="금융수단 이름"/></label>
        <label className="account-manager-color" htmlFor={`${fieldId}-color`}>색상<input id={`${fieldId}-color`} type="color" value={/^#[\da-f]{6}$/i.test(color) ? color : defaultColor} onChange={event => updateColor(event.target.value)} disabled={!!busy}/></label>
        <label className="account-manager-color-code" htmlFor={`${fieldId}-color-code`}>색상 코드<input ref={colorCodeRef} id={`${fieldId}-color-code`} type="text" required pattern="#[0-9a-fA-F]{6}" maxLength={7} value={color} onChange={event => updateColor(event.target.value)} onInvalid={event => { event.preventDefault(); showColorError() }} autoCapitalize="none" spellCheck={false} autoComplete="off" placeholder="#89a978" aria-invalid={colorInvalid} aria-describedby={colorInvalid ? `${fieldId}-error` : undefined} disabled={!!busy}/></label>
        <label className="account-manager-description" htmlFor={`${fieldId}-description`}>설명 <span className="muted">(선택)</span><textarea id={`${fieldId}-description`} rows={2} maxLength={5000} value={description} onChange={event => setDescription(event.target.value)} disabled={!!busy} placeholder="이 금융수단의 용도"/></label>
      </div>
      <div className="account-manager-form-actions"><button type="button" className="secondary-button" disabled={!!busy} onClick={() => { setEditing(undefined); setError('') }}>취소</button><button className="primary-button" type="submit" disabled={!!busy}>{busy === 'save' ? '저장 중…' : '저장'}</button></div>
    </form>}

    {error && <p className="error-message account-manager-error" id={`${fieldId}-error`} role="alert">{error}</p>}

    {accounts.length > 0 && <ul className="account-manager-list">{accounts.map(account => <li key={account.id} className={`account-manager-row ${account.archived ? 'is-archived' : ''}`}>
      <span className="account-manager-swatch" style={{ background: account.color }} aria-hidden="true"/>
      <div className="account-manager-details"><div className="account-manager-name-row"><strong>{account.name}</strong>{account.archived && <span className="account-manager-status">보관됨</span>}</div>{account.description && <p>{account.description}</p>}</div>
      <div className="account-manager-row-actions">
        <button type="button" className="account-manager-action" disabled={!!busy} aria-label={`${account.name} 수정`} onClick={() => openEditor(account)}>수정</button>
        <button type="button" className="account-manager-action" disabled={!!busy} aria-label={`${account.name} ${account.archived ? '복원' : '보관'}`} onClick={() => void setArchived(account, !account.archived)}>{busy === account.id ? '처리 중…' : account.archived ? '복원' : '보관'}</button>
        <button type="button" className="account-manager-action account-manager-delete" disabled={!!busy} aria-label={`${account.name} 삭제`} onClick={() => requestDelete(account)}>삭제</button>
      </div>
    </li>)}</ul>}

    {deleteTarget && <Modal title="금융수단 삭제" onClose={() => { if (!busyRef.current) setDeleteTarget(null) }}>
      <p className="account-delete-description"><strong>{deleteTarget.name}</strong> 금융수단을 영구 삭제할까요? 거래에 사용하지 않은 금융수단만 삭제할 수 있습니다.</p>
      {deleteError && <p className="error-message account-manager-error" role="alert">{deleteError}</p>}
      <div className="modal-actions account-delete-actions"><button type="button" className="secondary-button" disabled={!!busy} onClick={() => setDeleteTarget(null)}>취소</button>{deleteBlocked && !deleteTarget.archived && <button type="button" className="primary-button" disabled={!!busy} onClick={() => void setArchived(deleteTarget, true, true)}>대신 보관</button>}{!deleteBlocked && <button type="button" className="danger-button" disabled={!!busy} onClick={() => void remove()}>{busy ? '삭제 중…' : '영구 삭제'}</button>}</div>
    </Modal>}
  </section>
}
