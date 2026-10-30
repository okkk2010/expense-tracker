import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Eye, EyeOff, KeyRound, Link2, Plus, RefreshCw, Settings2, Smartphone, Trash2 } from 'lucide-react'
import { api, errorMessage, getConnection, json } from '../api'
import { activeShortcutAccounts, shortcutIngestEndpoint } from '../shortcuts'
import type { Account, Kind, ScreenProps, TransactionDraft } from '../types'
import { money, today } from '../utils'
import { Modal, TagPicker } from './Shared'

type Source = 'toss' | 'kb'
type ImportStatus = 'pending' | 'recorded' | 'ignored' | 'duplicate'
interface ShortcutConnection {
  id: string; name: string; source: Source; account_id: string | null; match_text: string
  category_id: string | null; tag_ids: string[]; auto_record: boolean; enabled: boolean
  last_received_at: string | null; created_at: string
}
interface ShortcutEvent {
  id: string; connection_id: string; connection_name: string; source: Source
  title: string; subtitle: string; body: string; source_app: string
  occurred_at: string; received_at: string; status: ImportStatus; reason: string
  parsed: { date: string; amount: number | null; kind: string | null; note: string
    account_id: string | null; category_id: string | null; tag_ids: string[] }
  transaction_id: string | null
}
interface ConnectionDraft {
  name: string; source: Source; account_id: string; match_text: string; category_id: string
  tag_ids: string[]; auto_record: boolean
}
const sourceName: Record<Source, string> = { toss: '토스', kb: 'KB스타뱅킹' }
const statusName: Record<ImportStatus, string> = { pending: '확인 필요', recorded: '기록됨', ignored: '제외됨', duplicate: '중복 수신' }
const emptyConnection: ConnectionDraft = { name: '', source: 'toss', account_id: '', match_text: '', category_id: '', tag_ids: [], auto_record: false }
const requestTemplate = JSON.stringify({ title: '알림 입력의 Title', subtitle: '알림 입력의 Subtitle', body: '알림 입력의 Body', source_app: '알림 입력의 App', occurred_at: '알림 발생 시각을 ISO 8601로 변환한 값' }, null, 2)
function receivedLabel(value: string | null) {
  if (!value) return '아직 수신하지 않음'
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

export function Shortcuts({ bootstrap, demo, connected, refreshKey, onRefresh, notify }: ScreenProps & { connected: boolean }) {
  const [connections, setConnections] = useState<ShortcutConnection[]>([])
  const [events, setEvents] = useState<ShortcutEvent[]>([])
  const [filter, setFilter] = useState<ImportStatus | ''>('pending')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<ConnectionDraft>(emptyConnection)
  const [addedAccounts, setAddedAccounts] = useState<Account[]>([])
  const [newAccountOpen, setNewAccountOpen] = useState(false)
  const [newAccountName, setNewAccountName] = useState('')
  const [accountBusy, setAccountBusy] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [issued, setIssued] = useState<{ connection: ShortcutConnection; token: string } | null>(null)
  const [visible, setVisible] = useState(false)
  const [review, setReview] = useState<ShortcutEvent | null>(null)
  const [reviewDraft, setReviewDraft] = useState<TransactionDraft>({ date: today(), amount: 0, kind: 'expense', account_id: '', category_id: '', tag_ids: [], note: '' })
  const [amountInput, setAmountInput] = useState('')
  const loadId = useRef(0)
  const connectionInfo = getConnection()
  const ready = connected && !demo && Boolean(connectionInfo.token.trim())
  let endpoint = ''
  let endpointError = ''
  try { endpoint = shortcutIngestEndpoint(connectionInfo.url, window.location.origin) } catch (cause) { endpointError = errorMessage(cause) }
  const accounts = [...bootstrap.accounts, ...addedAccounts.filter(item => !bootstrap.accounts.some(account => account.id === item.id))]
  const activeAccounts = activeShortcutAccounts(accounts)
  let localAddress = false
  try { localAddress = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(endpoint).hostname) } catch { /* Connection settings owns URL validation. */ }
  const refresh = () => setReload(value => value + 1)

  useEffect(() => {
    const id = ++loadId.current
    if (!ready) { setConnections([]); setEvents([]); setError(''); setLoading(false); return }
    const controller = new AbortController()
    setLoading(true)
    Promise.all([
      api<{ items: ShortcutConnection[] }>('/shortcuts/connections', { signal: controller.signal }),
      api<{ items: ShortcutEvent[] }>(`/shortcuts/events?limit=100${filter ? `&status=${filter}` : ''}`, { signal: controller.signal }),
    ]).then(([links, inbox]) => {
      if (id !== loadId.current) return
      setConnections(links.items); setEvents(inbox.items); setError('')
    }).catch(cause => { if (id === loadId.current && !controller.signal.aborted) setError(errorMessage(cause)) })
      .finally(() => { if (id === loadId.current) setLoading(false) })
    return () => { controller.abort(); loadId.current++ }
  }, [ready, connectionInfo.url, connectionInfo.token, refreshKey, reload, filter])

  useEffect(() => { setIssued(null); setVisible(false); setReview(null); setFormOpen(false); setAddedAccounts([]) }, [connectionInfo.url, connectionInfo.token, demo])

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); notify(`${label} 복사했어요.`) }
    catch { notify('복사할 수 없어요. 표시된 내용을 직접 선택해 주세요.', true) }
  }
  function startConnection(item?: ShortcutConnection) {
    if (!ready) return
    setEditing(item?.id ?? null)
    setDraft(item ? { name: item.name, source: item.source, account_id: item.account_id ?? '', match_text: item.match_text, category_id: item.category_id ?? '', tag_ids: item.tag_ids, auto_record: item.auto_record } : { ...emptyConnection, tag_ids: [] })
    setFormOpen(true); setNewAccountOpen(false); setNewAccountName('')
  }
  async function saveConnection() {
    if (!ready || busy) return
    if (!activeAccounts.some(account => account.id === draft.account_id)) { notify('기록할 금융수단을 선택해 주세요. 보관된 금융수단은 새로 연결할 수 없어요.', true); return }
    if (draft.auto_record && !draft.match_text.trim()) { notify('자동 기록에는 계좌·카드를 구분할 문구가 필요해요.', true); return }
    setBusy(true)
    try {
      const payload = { ...draft, name: draft.name.trim(), match_text: draft.match_text.trim(), category_id: draft.category_id || null }
      if (editing) await api(`/shortcuts/connections/${editing}`, { method: 'PATCH', body: json(payload) })
      else {
        const result = await api<{ connection: ShortcutConnection; token: string }>('/shortcuts/connections', { method: 'POST', body: json(payload) })
        setIssued(result); setVisible(false)
      }
      setFormOpen(false); refresh(); notify(editing ? '수집 연결을 변경했어요.' : '연결을 만들었어요. 아이폰에 수집키를 등록해 주세요.')
    } catch (cause) { notify(errorMessage(cause), true) }
    finally { setBusy(false) }
  }
  async function createAccount() {
    if (!ready || accountBusy || !newAccountName.trim()) return
    setAccountBusy(true)
    try {
      const account = await api<Account>('/accounts', { method: 'POST', body: json({ name: newAccountName.trim(), description: 'iPhone 자동 수집 연결용 금융수단', color: draft.source === 'kb' ? '#b99743' : '#637ac4' }) })
      setAddedAccounts(previous => [...previous, account]); setDraft(previous => ({ ...previous, account_id: account.id }))
      setNewAccountOpen(false); setNewAccountName(''); onRefresh(); notify('금융수단을 추가했어요.')
    } catch (cause) { notify(errorMessage(cause), true) }
    finally { setAccountBusy(false) }
  }
  async function toggleConnection(item: ShortcutConnection) {
    if (!ready || busy) return
    if (!item.enabled && !activeAccounts.some(account => account.id === item.account_id)) { notify('먼저 연결을 수정해 사용 중인 금융수단을 선택해 주세요.', true); return }
    setBusy(true)
    try { await api(`/shortcuts/connections/${item.id}`, { method: 'PATCH', body: json({ enabled: !item.enabled }) }); refresh(); notify(item.enabled ? '이 연결의 수집을 중지했어요.' : '이 연결의 수집을 다시 켰어요.') }
    catch (cause) { notify(errorMessage(cause), true) }
    finally { setBusy(false) }
  }
  async function rotateKey(item: ShortcutConnection) {
    if (!ready || busy || !window.confirm(`${item.name}의 수집키를 새로 만들까요? 기존 키는 중지되며 아이폰 단축어에도 새 키를 넣어야 합니다.`)) return
    setBusy(true)
    try { setIssued(await api<{ connection: ShortcutConnection; token: string }>(`/shortcuts/connections/${item.id}/rotate`, { method: 'POST' })); setVisible(false); refresh() }
    catch (cause) { notify(errorMessage(cause), true) }
    finally { setBusy(false) }
  }
  async function removeConnection(item: ShortcutConnection) {
    if (!ready || busy || !window.confirm(`${item.name} 연결을 해제할까요? 수집키는 중지되고 이미 기록한 거래는 유지됩니다.`)) return
    setBusy(true)
    try { await api(`/shortcuts/connections/${item.id}`, { method: 'DELETE' }); refresh(); notify('연결을 해제했어요. 기존 거래는 유지돼요.') }
    catch (cause) { notify(errorMessage(cause), true) }
    finally { setBusy(false) }
  }
  function startReview(item: ShortcutEvent) {
    setReview(item)
    setReviewDraft({ date: item.parsed.date || today(), amount: item.parsed.amount ?? 0,
      kind: ['expense', 'income', 'transfer'].includes(item.parsed.kind ?? '') ? item.parsed.kind as Kind : 'expense',
      account_id: activeAccounts.some(account => account.id === item.parsed.account_id) ? item.parsed.account_id ?? '' : '', category_id: item.parsed.category_id ?? '',
      tag_ids: [...item.parsed.tag_ids], note: item.parsed.note || '' })
    setAmountInput(item.parsed.amount == null ? '' : String(item.parsed.amount))
  }
  async function recordEvent() {
    if (!review || !ready || busy) return
    if (review.parsed.kind === 'refund') { notify('취소·환불은 원래 거래를 수정한 뒤 이 알림을 제외해 주세요.', true); return }
    if (!activeAccounts.some(account => account.id === reviewDraft.account_id)) { notify('보관되지 않은 금융수단을 선택해 주세요.', true); return }
    const amount = Number(amountInput)
    if (!/^\d+$/.test(amountInput) || !Number.isSafeInteger(amount) || amount <= 0 || amount > 9_000_000_000_000) { notify('금액은 1원 이상의 정수로 입력해 주세요.', true); return }
    setBusy(true)
    try {
      await api(`/shortcuts/events/${review.id}/record`, { method: 'POST', body: json({ transaction: { ...reviewDraft, amount } }) })
      setReview(null); refresh(); onRefresh(); notify('거래에 기록하고 통계를 갱신했어요.')
    } catch (cause) { notify(errorMessage(cause), true) }
    finally { setBusy(false) }
  }
  async function ignoreEvent(item: ShortcutEvent) {
    if (!ready || busy) return
    setBusy(true)
    try { await api(`/shortcuts/events/${item.id}/ignore`, { method: 'POST' }); refresh(); notify('수집함에서 제외했어요. 거래에는 반영하지 않아요.') }
    catch (cause) { notify(errorMessage(cause), true) }
    finally { setBusy(false) }
  }

  return <section className="panel settings-panel shortcuts-panel" aria-labelledby="shortcuts-title">
    <div className="section-heading"><div className="setting-title"><span className="setting-icon"><Smartphone size={20}/></span><div><h2 id="shortcuts-title">iPhone 자동 수집</h2><p>단축어로 전달한 금융 알림을 금융수단별로 기록해요.</p></div></div><button className="secondary-button small-button" type="button" onClick={() => setSetupOpen(true)}>아이폰 연결 방법</button></div>
    <p className="shortcut-callout">iOS 26.6에서는 토스·KB스타뱅킹의 앱 푸시 알림을 단축어로 자동 수집할 수 없어요. 실제로 받는 결제·입출금 문자가 있다면 ‘메시지’ 자동화를 사용할 수 있습니다. 앱 알림 자동화는 iOS 27에 추가된 기능이며, 토스·KB 알림 내용의 전달 여부는 실기기로 확인해야 해요. <a className="shortcut-support-link" href="https://support.apple.com/ko-kr/149045" target="_blank" rel="noopener noreferrer">Apple 지원 버전 안내</a></p>
    {!ready ? <p className="shortcut-callout">{demo ? '둘러보기에서는 수집 연결을 만들지 않아요. 실제 서버에 연결해 주세요.' : !connected ? '위의 서버 연결을 먼저 완료해 주세요.' : '개인 접속키가 설정된 서버가 필요해요. 서버의 APP_ACCESS_TOKEN을 설정한 뒤 위의 연결 정보에 같은 키를 입력해 주세요.'}</p> : <>
      {endpointError && <p className="shortcut-callout shortcut-error" role="alert">{endpointError}</p>}
      {localAddress && <p className="shortcut-callout">현재 주소는 이 컴퓨터에서만 접속할 수 있어요. 아이폰에서 접속할 수 있는 내 서버 주소를 서버 연결에 저장한 뒤 단축어를 설정해 주세요.</p>}
      {error && <div className="shortcut-callout shortcut-error" role="alert"><span>{error}</span><button className="text-button" type="button" onClick={refresh}>다시 확인</button></div>}
      <div className="shortcut-section-title"><h3>수집 연결</h3><button className="secondary-button small-button" disabled={busy} type="button" onClick={() => startConnection()}><Plus size={14}/>연결 추가</button></div>
      <p className="shortcut-help">알림을 보낸 앱과 실제 은행·카드는 따로 구분해요. 금융수단마다 연결을 만들고, 알림에 표시되는 구분 문구를 지정하세요.</p>
      <div className="shortcut-connections">{connections.map(item => <article className="shortcut-connection" key={item.id}>
        <div className="shortcut-connection-top"><div><strong>{item.name}</strong><span className="shortcut-help">{sourceName[item.source]} → {accounts.find(account => account.id === item.account_id)?.name ?? '금융수단 연결 필요'}{accounts.find(account => account.id === item.account_id)?.archived ? ' (보관됨)' : ''}</span></div><span className={`pill ${item.enabled ? 'shortcut-active' : ''}`}>{item.enabled ? '수신 대기' : '중지됨'}</span></div>
        <dl className="shortcut-details"><div><dt>기록 방식</dt><dd>{item.auto_record ? '구분 문구가 일치하는 확실한 결제만 자동 기록' : '확인 후 기록'}</dd></div><div><dt>구분 문구</dt><dd>{item.match_text || '미지정'}</dd></div><div><dt>마지막 수신</dt><dd>{receivedLabel(item.last_received_at)}</dd></div></dl>
        <div className="shortcut-connection-actions"><button className="text-button" disabled={busy} onClick={() => void toggleConnection(item)}>{item.enabled ? '수집 중지' : '수집 켜기'}</button><button className="text-button" disabled={busy} onClick={() => startConnection(item)}><Settings2 size={13}/>수정</button><button className="text-button" disabled={busy} onClick={() => void rotateKey(item)}><KeyRound size={13}/>수집키 재발급</button><button className="text-button danger-text" disabled={busy} onClick={() => void removeConnection(item)}><Trash2 size={13}/>연결 해제</button></div>
      </article>)}{!loading && !error && connections.length === 0 && <div className="shortcut-empty"><Link2 size={21}/><p>아직 수집 연결이 없어요.</p><span>국민은행 통장과 국민카드는 각각 다른 금융수단으로 연결하세요.</span></div>}</div>
      <div className="shortcut-section-title shortcut-inbox-title"><h3>수집 내역</h3><button className="secondary-button small-button" type="button" disabled={loading} onClick={refresh}><RefreshCw size={13} className={loading ? 'spin' : ''}/>새로고침</button></div>
      <div className="shortcut-inbox-toolbar"><label>표시할 내역<select value={filter} onChange={event => setFilter(event.target.value as ImportStatus | '')}><option value="pending">확인 필요</option><option value="recorded">기록됨</option><option value="ignored">제외됨</option><option value="duplicate">중복 수신</option><option value="">전체</option></select></label><span className="shortcut-help">최근 100건까지 표시 · 수신한 새 알림부터 수집</span></div>
      <div className="shortcut-events">{events.map(item => <article className="shortcut-event" key={item.id}>
        <div className="shortcut-event-top"><div><strong>{item.parsed.note || item.title || '수집한 알림'}</strong><span className="shortcut-help">{sourceName[item.source]} · {item.connection_name} · {receivedLabel(item.received_at)}</span></div><div className="shortcut-event-amount"><strong>{item.parsed.amount == null ? '금액 확인 필요' : money(item.parsed.amount)}</strong><span className={`pill shortcut-status-${item.status}`}>{statusName[item.status]}</span></div></div>
        <p className="shortcut-event-reason">{item.reason}</p><details className="shortcut-raw"><summary>받은 알림 보기</summary><p>{[item.title, item.subtitle, item.body].filter(Boolean).join('\n')}</p><small>수집 앱: {item.source_app || sourceName[item.source]} · 알림 시각: {receivedLabel(item.occurred_at)}</small></details>
        {item.status === 'pending' && item.parsed.kind === 'refund' && <p className="shortcut-help">취소·환불은 ‘거래 기록’에서 원래 거래를 수정한 뒤 이 알림을 제외해 주세요. 새 지출이나 수입으로 기록하지 않아요.</p>}
        {item.status === 'pending' && <div className="shortcut-event-actions"><button className="secondary-button small-button" disabled={busy} type="button" onClick={() => void ignoreEvent(item)}>기록에서 제외</button>{item.parsed.kind !== 'refund' && <button className="primary-button small-button" disabled={busy} type="button" onClick={() => startReview(item)}>확인하고 기록</button>}</div>}
      </article>)}{!loading && !error && events.length === 0 && <p className="shortcut-empty-text">{filter === 'pending' ? '확인할 수집 내역이 없어요.' : '이 상태의 수집 내역이 없어요.'}</p>}{loading && events.length === 0 && <p className="shortcut-empty-text" role="status">수집 내역을 불러오고 있어요.</p>}</div>
    </>}
    {formOpen && <Modal title={editing ? '수집 연결 수정' : '수집 연결 추가'} subtitle="알림 출처와 거래를 기록할 금융수단을 연결해 주세요." onClose={() => { if (!busy && !accountBusy) setFormOpen(false) }}>
      <form className="form-stack shortcut-form" onSubmit={event => { event.preventDefault(); void saveConnection() }}>
        <label>연결 이름<input required maxLength={120} value={draft.name} placeholder="예: 국민은행 생활비 통장" onChange={event => setDraft({ ...draft, name: event.target.value })}/></label>
        <div className="form-grid"><label>알림 출처<select value={draft.source} disabled={editing !== null} onChange={event => setDraft({ ...draft, source: event.target.value as Source })}><option value="toss">토스</option><option value="kb">KB스타뱅킹</option></select></label><label>기록할 금융수단<select required value={activeAccounts.some(account => account.id === draft.account_id) ? draft.account_id : ''} onChange={event => setDraft({ ...draft, account_id: event.target.value })}><option value="">선택해 주세요</option>{activeAccounts.map(account => <option value={account.id} key={account.id}>{account.name}</option>)}</select></label></div>
        <p className="shortcut-help">국민은행 계좌와 국민카드는 별개예요. 목록에 맞는 금융수단이 없으면 새로 추가하세요.</p>
        {newAccountOpen ? <div className="shortcut-new-account"><label>새 금융수단 이름<input value={newAccountName} maxLength={120} placeholder="예: 국민은행 입출금 통장" onChange={event => setNewAccountName(event.target.value)}/></label><div className="button-row"><button type="button" className="secondary-button small-button" disabled={accountBusy || !newAccountName.trim()} onClick={() => void createAccount()}>{accountBusy ? '추가 중…' : '금융수단 추가'}</button><button type="button" className="text-button" disabled={accountBusy} onClick={() => setNewAccountOpen(false)}>취소</button></div></div> : <button type="button" className="text-button" onClick={() => setNewAccountOpen(true)}><Plus size={14}/>새 금융수단 등록</button>}
        <label>계좌·카드 구분 문구<input maxLength={120} value={draft.match_text} placeholder="알림에 표시되는 계좌 별칭 또는 마스킹 번호" onChange={event => setDraft({ ...draft, match_text: event.target.value, auto_record: event.target.value.trim() ? draft.auto_record : false })}/></label>
        <p className="shortcut-help">실제 알림에 있는 고유한 문구를 입력하세요. 은행명만 같거나 끝자리가 겹치면 확인 후 기록을 사용하세요.</p>
        <label>기본 종목<select value={draft.category_id} onChange={event => setDraft({ ...draft, category_id: event.target.value })}><option value="">{bootstrap.categories.some(category => category.id === 'category-other') ? '기타 (기본값)' : '확인할 때 선택'}</option>{bootstrap.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
        <div><span className="field-label">기본 태그 · 선택</span><TagPicker tags={bootstrap.tags} value={draft.tag_ids} onChange={value => setDraft({ ...draft, tag_ids: value })}/></div>
        <label className="shortcut-checkbox"><input type="checkbox" checked={draft.auto_record} disabled={!draft.match_text.trim()} onChange={event => setDraft({ ...draft, auto_record: event.target.checked })}/><span>구분 문구가 일치하는 확실한 결제는 자동 기록</span></label>
        <p className="shortcut-help">이체·카드대금 정산·취소·환불·불명확한 금액은 확인함에 남겨요. 자동 기록에는 기본 종목도 지정하는 것이 좋아요.</p>
        {!ready && <p className="shortcut-callout">서버 연결을 확인해 주세요. 작성한 내용은 이 창에 유지돼요.</p>}
        <div className="modal-actions"><button type="button" className="secondary-button" disabled={busy || accountBusy} onClick={() => setFormOpen(false)}>취소</button><button type="submit" className="primary-button" disabled={!ready || busy || accountBusy}>{busy ? '저장 중…' : editing ? '연결 저장' : '연결 만들기'}</button></div>
      </form>
    </Modal>}
    {issued && <Modal title="아이폰에 수집키를 등록해 주세요" subtitle={`${issued.connection.name} · ${sourceName[issued.connection.source]}`} onClose={() => { setIssued(null); setVisible(false) }}>
      <p className="shortcut-callout">수집키는 이 창에서만 확인할 수 있어요. 닫은 뒤에는 재발급할 수 있습니다. 이 키로는 알림 전송만 가능해요.</p>
      <label className="shortcut-token-label">전용 수집키<span className="secret-field"><KeyRound size={16}/><input aria-label="전용 수집키" type={visible ? 'text' : 'password'} value={issued.token} readOnly autoComplete="off" spellCheck={false}/><button className="icon-button" type="button" aria-label={visible ? '수집키 숨기기' : '수집키 표시'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16}/> : <Eye size={16}/>}</button></span></label>
      <div className="shortcut-key-actions"><button className="secondary-button" type="button" onClick={() => void copy(issued.token, '수집키를')}><Copy size={14}/>수집키 복사</button><button className="secondary-button" type="button" onClick={() => void copy(`Bearer ${issued.token}`, 'Authorization 값을')}><Copy size={14}/>헤더 값 복사</button></div>
      <ShortcutInstructions endpoint={endpoint} source={issued.connection.source} onCopy={copy}/>
      <div className="modal-actions"><button className="primary-button" type="button" onClick={() => { setIssued(null); setVisible(false) }}><Check size={15}/>등록 후 닫기</button></div>
    </Modal>}
    {setupOpen && <Modal title="아이폰 단축어 연결 방법" subtitle="자동화 등록은 아이폰의 단축어 앱에서 직접 완료해 주세요." onClose={() => setSetupOpen(false)}>
      <ShortcutInstructions endpoint={endpoint} onCopy={copy}/>
      <p className="shortcut-help">이 컴퓨터에서는 아이폰에 자동화를 설치하거나 실행 여부를 확인할 수 없어요. 실제 알림이 도착한 뒤 ‘마지막 수신’과 수집 내역에서 연결을 확인하세요.</p>
    </Modal>}
    {review && <Modal title="수집한 내역 확인" subtitle={`${sourceName[review.source]} · ${review.connection_name}`} onClose={() => { if (!busy) setReview(null) }}>
      <p className="shortcut-callout">{review.reason}</p><details className="shortcut-raw"><summary>원본 알림 보기</summary><p>{[review.title, review.subtitle, review.body].filter(Boolean).join('\n')}</p></details>
      <form className="form-stack shortcut-form" onSubmit={event => { event.preventDefault(); void recordEvent() }}>
        <div className="form-grid"><label>거래 날짜<input type="date" required value={reviewDraft.date} onChange={event => setReviewDraft({ ...reviewDraft, date: event.target.value })}/></label><label>유형<select value={reviewDraft.kind} onChange={event => setReviewDraft({ ...reviewDraft, kind: event.target.value as Kind })}><option value="expense">지출</option><option value="income">수입</option><option value="transfer">이체·정산</option></select></label></div>
        <label>금액 · 원<input type="text" inputMode="numeric" pattern="[0-9]+" required value={amountInput} placeholder="숫자로 입력" onChange={event => setAmountInput(event.target.value)}/></label>
        <div className="form-grid"><label>금융수단<select required value={activeAccounts.some(account => account.id === reviewDraft.account_id) ? reviewDraft.account_id : ''} onChange={event => setReviewDraft({ ...reviewDraft, account_id: event.target.value })}><option value="">선택해 주세요</option>{activeAccounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label>종목<select required value={reviewDraft.category_id} onChange={event => setReviewDraft({ ...reviewDraft, category_id: event.target.value })}><option value="">선택해 주세요</option>{bootstrap.categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label></div>
        <label>메모<input maxLength={5000} value={reviewDraft.note} onChange={event => setReviewDraft({ ...reviewDraft, note: event.target.value })}/></label>
        <div><span className="field-label">태그</span><TagPicker tags={bootstrap.tags} value={reviewDraft.tag_ids} onChange={value => setReviewDraft({ ...reviewDraft, tag_ids: value })}/></div>
        <p className="shortcut-help">신용카드 대금 출금은 이체·정산으로 구분해 이중 지출을 막으세요. 환불은 원거래와 확인한 뒤 처리하고, 수입으로 임의 기록하지 마세요.</p>
        {!ready && <p className="shortcut-callout">서버 연결을 확인해 주세요. 작성한 내용은 이 창에 유지돼요.</p>}
        <div className="modal-actions"><button className="secondary-button" type="button" disabled={busy} onClick={() => setReview(null)}>취소</button><button className="primary-button" type="submit" disabled={!ready || busy}>{busy ? '기록 중…' : '거래에 기록'}</button></div>
      </form>
    </Modal>}
  </section>
}

function ShortcutInstructions({ endpoint, source, onCopy }: { endpoint: string; source?: Source; onCopy: (value: string, label: string) => Promise<void> }) {
  return <div className="shortcut-instructions">
    <ol>
      <li><strong>수집할 문자·알림 확인</strong><p>{source ? sourceName[source] : '토스·KB스타뱅킹'}에서 실제로 받는 금융 알림을 확인하세요. 금액과 계좌·카드 구분 문구가 있어야 해요. 앱 알림과 문자(SMS)는 서로 다른 수집 경로예요.</p></li>
      <li><strong>iOS에 맞는 자동화 만들기</strong><p><b>iOS 26.6:</b> 실제 결제·입출금 문자를 받는 경우에만 ‘메시지’ 자동화를 만들고 발신자·본문 조건을 설정하세요. 토스·KB 앱의 푸시 알림을 이 경로로 받을 수는 없어요. 해당 금융기관이 문자를 보내는지도 먼저 확인해야 해요.</p><p><b>iOS 27 이상:</b> 단축어 편집기의 자동화에서 ‘알림’을 선택한 뒤 대상 앱과 연결별 구분 문구를 설정하세요. 실제 알림 내용이 전달되는지는 별도 확인해야 해요. <a className="shortcut-support-link" href="https://support.apple.com/ko-kr/149045" target="_blank" rel="noopener noreferrer">Apple의 iOS 27 새로운 자동화 안내</a></p></li>
      <li><strong>‘URL의 콘텐츠 가져오기’ 추가</strong><p>아래 주소를 넣고 메서드는 <b>POST</b>, 요청 본문은 <b>JSON</b>을 선택하세요.</p><div className="shortcut-copy-field"><code>{endpoint || '서버 연결 주소를 먼저 확인해 주세요.'}</code><button className="icon-button" type="button" disabled={!endpoint} aria-label="수집 주소 복사" onClick={() => void onCopy(endpoint, '수집 주소를')}><Copy size={15}/></button></div></li>
      <li><strong>헤더에 전용 수집키 넣기</strong><p><code>Authorization</code>에 <code>Bearer 수집키</code>를 입력하세요. 연결 생성·재발급 창에서 ‘헤더 값 복사’를 누르면 돼요. 서버의 개인 접속키와 다른 키예요.</p></li>
      <li><strong>JSON 필드에 알림 변수 연결</strong><div className="shortcut-fields"><div><code>body</code><span>필수 · 알림 변수의 Body/본문</span></div><div><code>title</code><span>선택 · Title/제목</span></div><div><code>subtitle</code><span>선택 · Subtitle/부제목</span></div><div><code>source_app</code><span>선택 · App/앱 이름</span></div><div><code>occurred_at</code><span>선택 · 알림 Date를 ISO 8601 형식으로 변환</span></div><div><code>event_id</code><span>선택 · 재전송할 때 유지할 동일한 이벤트 ID</span></div></div><p>값에는 고정 예시 문구 대신 알림 변수를 넣으세요. 메시지 자동화는 <code>body</code>에 단축어 입력의 메시지 본문을 연결하면 돼요. 없는 선택 필드는 생략하세요.</p><button type="button" className="text-button" onClick={() => void onCopy(requestTemplate, '필드 구성 예시를')}><Copy size={13}/>필드 구성 예시 복사</button></li>
      <li><strong>자동 실행을 켜고 실제 수신 확인</strong><p>해당 iOS에서 지원하는 자동 실행 설정과 필요한 동작 권한을 허용하세요. 새 알림이 온 뒤 이 화면의 ‘마지막 수신’을 확인하세요. 연결 전의 과거 알림은 가져오지 않아요.</p></li>
    </ol>
    <p className="shortcut-callout">아이폰에서 접속할 수 있는 HTTPS 서버 주소를 사용하세요. 서버가 꺼져 있거나 인터넷이 끊기면 전송되지 않으니 단축어 실행 결과와 수집함을 확인해 주세요.</p>
  </div>
}
