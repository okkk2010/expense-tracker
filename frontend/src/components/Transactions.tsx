import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CalendarDays, Check, ChevronDown, Filter, Plus, Search, Trash2, X } from 'lucide-react'
import { api, ApiError, errorMessage, json } from '../api'
import { demoTransactions } from '../demo'
import type { Bootstrap, Kind, ScreenProps, Transaction, TransactionDraft } from '../types'
import { dateLabel, money, monthRange, today } from '../utils'
import { Empty, Loading, Modal, TagPicker, TransactionList } from './Shared'

export function Transactions(props: ScreenProps & {onAdd:()=>void;onEdit:(item:Transaction)=>void}) {
  const {bootstrap,month,demo,refreshKey,notify,onAdd,onEdit}=props
  const [items,setItems]=useState<Transaction[]>([])
  const [total,setTotal]=useState(0)
  const [loading,setLoading]=useState(true)
  const [failure,setFailure]=useState('')
  const [q,setQ]=useState('')
  const [expanded,setExpanded]=useState(false)
  const [range,setRange]=useState(monthRange(month))
  const [account,setAccount]=useState('')
  const [category,setCategory]=useState('')
  const [kind,setKind]=useState('')
  const [tags,setTags]=useState<string[]>([])
  const [mode,setMode]=useState<'or'|'and'>('or')
  const loadedView=useRef('')
  useEffect(()=>setRange(monthRange(month)),[month])
  useEffect(()=>{
    let active=true
    const controller=new AbortController()
    const viewKey=JSON.stringify({month,demo,q,range,account,category,kind,tags,mode})
    const background=loadedView.current===viewKey
    const timer=setTimeout(async()=>{
      if(!background){setLoading(true);setFailure('')}
      try {
        if(range.start>range.end) throw new Error('시작일이 종료일보다 늦습니다. 날짜를 확인해 주세요.')
        if(demo){ const filtered=demoTransactions(month).filter(item=>item.date>=range.start&&item.date<=range.end&&(!account||item.account_id===account)&&(!category||item.category_id===category)&&(!kind||item.kind===kind)&&(!q||`${item.note} ${item.account_name} ${item.tag_names.join(' ')}`.includes(q))&&(!tags.length||(mode==='and'?tags.every(tag=>item.tag_ids.includes(tag)):tags.some(tag=>item.tag_ids.includes(tag)))));if(active){setItems(filtered);setTotal(filtered.length)} }
        else {const query=new URLSearchParams({start:range.start,end:range.end,tag_mode:mode,limit:'5000'});if(q)query.set('q',q);if(account)query.set('account_id',account);if(category)query.set('category_id',category);if(kind)query.set('kind',kind);if(tags.length)query.set('tag_ids',tags.join(',')); const response=await api<{items:Transaction[];total:number}>(`/transactions?${query}`,{signal:controller.signal});if(active){setItems(response.items);setTotal(response.total)}}
        if(active){loadedView.current=viewKey;setFailure('')}
      } catch(error){if(active&&!background)setFailure(errorMessage(error))} finally {if(active)setLoading(false)}
    },250)
    return()=>{active=false;controller.abort();clearTimeout(timer)}
  },[month,demo,refreshKey,q,range,account,category,kind,tags,mode])
  const expenses=items.filter(item=>item.kind==='expense').reduce((sum,item)=>sum+item.amount,0)
  return <><div className="page-intro"><div><div className="eyebrow">ONE RECORD AT A TIME</div><h1>거래 기록</h1><p>원하는 날짜를 골라 여러 거래를 한 번에 기록하세요.</p></div><button className="primary-button" onClick={onAdd}><Plus size={17}/>거래 기록하기</button></div>
    <div className="record-summary"><div><span>조회한 거래</span><strong>{total}<small>건</small></strong></div><div><span>{total>items.length?'표시된 거래의 지출 합계':'조회한 지출 합계'}</span><strong>{money(expenses)}</strong></div><p>수입과 이체는 지출 합계에 포함하지 않아요.</p></div>
    <section className="panel"><div className="transaction-toolbar"><label className="search-input"><Search size={17}/><input aria-label="거래 검색" placeholder="메모, 기록을 검색해 보세요" value={q} onChange={event=>setQ(event.target.value)}/>{q&&<button className="icon-button" onClick={()=>setQ('')} aria-label="검색어 지우기"><X size={14}/></button>}</label><button className={`secondary-button ${expanded?'active-button':''}`} onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}><Filter size={16}/>필터{(account||category||kind||tags.length>0)&&<span className="filter-dot"/>}<ChevronDown size={14}/></button></div>
      {expanded&&<div className="filters-panel"><div className="form-grid four"><label>시작일<input type="date" value={range.start} onChange={event=>setRange({...range,start:event.target.value})}/></label><label>종료일<input type="date" value={range.end} onChange={event=>setRange({...range,end:event.target.value})}/></label><label>금융수단<select value={account} onChange={event=>setAccount(event.target.value)}><option value="">모두 보기</option>{bootstrap.accounts.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>종목<select value={category} onChange={event=>setCategory(event.target.value)}><option value="">모두 보기</option>{bootstrap.categories.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><div className="filter-subrow"><label className="inline-field">유형<select value={kind} onChange={event=>setKind(event.target.value)}><option value="">모든 유형</option><option value="expense">지출</option><option value="income">수입</option><option value="transfer">이체</option></select></label><div className="segmented"><button className={mode==='or'?'selected':''} onClick={()=>setMode('or')}>태그 하나라도 · OR</button><button className={mode==='and'?'selected':''} onClick={()=>setMode('and')}>태그 모두 · AND</button></div><button className="text-button" onClick={()=>{setRange(monthRange(month));setQ('');setAccount('');setCategory('');setKind('');setTags([])}}>필터 초기화</button></div><TagPicker tags={bootstrap.tags} value={tags} onChange={setTags} includeArchived/></div>}
      <div className="list-heading"><span>{range.start} — {range.end}</span><span>최근 날짜순</span></div>{loading?<Loading/>:failure?<Empty icon={<AlertTriangle size={23}/>} title="거래를 불러오지 못했어요" text={failure} action={<button className="secondary-button" onClick={props.onRefresh}>다시 불러오기</button>}/>:items.length?<TransactionList items={items} onEdit={onEdit}/>:<Empty icon={<CalendarDays size={24}/>} title={q||tags.length||account||category||kind?'조건에 맞는 거래가 없어요':'아직 기록이 없어요'} text="날짜와 필터를 확인하거나, 새로운 거래를 남겨보세요." action={<button className="secondary-button" onClick={onAdd}><Plus size={15}/>거래 기록하기</button>}/>}{total>items.length&&<div className="panel-footnote">전체 {total}건 중 {items.length}건을 표시하고 있어요. 기간을 좁혀 나머지 기록을 확인해 주세요.</div>}
    </section>
  </>
}

interface DraftRow extends Omit<TransactionDraft,'amount'> { rowId: string; amount: string }
function createRow(bootstrap: Bootstrap,date:string): DraftRow {return {rowId:crypto.randomUUID(),date,amount:'',kind:'expense',account_id:bootstrap.accounts[1]?.id||bootstrap.accounts[0]?.id||'',category_id:bootstrap.categories[0]?.id||'',tag_ids:[],note:''}}
export function TransactionEditor({bootstrap,initial,onClose,onSaved,notify}: {bootstrap:Bootstrap;initial:Transaction|null;onClose:()=>void;onSaved:()=>void;notify:ScreenProps['notify']}) {
  const [selectedDate,setSelectedDate]=useState(initial?.date||today())
  const [rows,setRows]=useState<DraftRow[]>(()=>initial?[{...initial,rowId:initial.id,amount:String(initial.amount)}]:[createRow(bootstrap,today())])
  const [busy,setBusy]=useState(false)
  const [error,setError]=useState('')
  const [version,setVersion]=useState(initial?.version||1)
  const [conflict,setConflict]=useState<Transaction|null>(null)
  const update=(id:string,patch:Partial<DraftRow>)=>setRows(current=>current.map(row=>row.rowId===id?{...row,...patch}:row))
  const payload=():TransactionDraft[]=>rows.map(row=>({date:row.date,amount:Number(row.amount),kind:row.kind,account_id:row.account_id,category_id:row.category_id,tag_ids:row.tag_ids,note:row.note}))
  async function save(overwriteVersion?:number) {
    setError('');if(rows.some(row=>row.amount===''||!Number.isSafeInteger(Number(row.amount))||Number(row.amount)<0||!row.date||!row.account_id||!row.category_id)){setError('날짜, 금융수단, 종목과 0원 이상의 정수 금액을 입력해 주세요.');return}
    setBusy(true)
    try {if(initial)await api<Transaction>(`/transactions/${initial.id}`,{method:'PATCH',body:json({...payload()[0],version:overwriteVersion??version})});else await api('/transactions/batch',{method:'POST',body:json({items:payload()})});notify(initial?'거래를 수정했어요.':`${rows.length}건의 기록을 저장했어요.`);onSaved();onClose()}
    catch(caught){if(caught instanceof ApiError&&caught.status===409){const detail=caught.detail as {current?:Transaction};if(detail.current)setConflict(detail.current);else setError(caught.message)}else setError(errorMessage(caught))}finally{setBusy(false)}
  }
  async function remove() {if(!initial||!window.confirm('이 거래를 삭제할까요? 삭제한 거래는 되돌릴 수 없습니다.'))return;setBusy(true);try{await api(`/transactions/${initial.id}?version=${version}`,{method:'DELETE'});notify('거래를 삭제했어요.');onSaved();onClose()}catch(caught){if(caught instanceof ApiError&&caught.status===409){const current=(caught.detail as {current?:Transaction}).current;if(current)setConflict(current);else setError(caught.message)}else setError(errorMessage(caught))}finally{setBusy(false)}}
  return <Modal title={initial?'거래 수정':'차곡차곡, 거래 기록'} subtitle={initial?'기록한 내용을 확인하고 수정해 주세요.':'날짜를 고르면 추가하는 거래에도 같은 날짜가 유지돼요.'} onClose={onClose} wide>
    <form onSubmit={event=>{event.preventDefault();void save()}}><div className="entry-date"><CalendarDays size={20}/><div><span>{initial?'기록 날짜':'새 거래의 기본 날짜'}</span><label><input type="date" aria-label="기본 날짜 선택" value={selectedDate} required onChange={event=>{setSelectedDate(event.target.value);if(initial)update(rows[0].rowId,{date:event.target.value});else setRows(current=>current.map(row=>row.amount===''&&!row.note&&row.tag_ids.length===0?{...row,date:event.target.value}:row))}}/></label></div><span className="muted small">{selectedDate?dateLabel(selectedDate):'날짜를 골라주세요'}</span></div>
      <div className="entry-rows">{rows.map((row,index)=><div className="entry-row" key={row.rowId}><div className="entry-row-title"><span>기록 {String(index+1).padStart(2,'0')}</span>{!initial&&rows.length>1&&<button type="button" className="icon-button" onClick={()=>setRows(rows.filter(item=>item.rowId!==row.rowId))} aria-label={`${index+1}번 기록 제거`}><X size={17}/></button>}</div><div className="form-grid four"><label>날짜<input required type="date" value={row.date} onChange={event=>update(row.rowId,{date:event.target.value})}/></label><label>유형<select value={row.kind} onChange={event=>update(row.rowId,{kind:event.target.value as Kind})}><option value="expense">지출</option><option value="income">수입</option><option value="transfer">이체</option></select></label><label>금액 <span className="muted">(원)</span><input required type="number" min="0" step="1" inputMode="numeric" placeholder="0" value={row.amount} onChange={event=>update(row.rowId,{amount:event.target.value})}/></label><label>금융수단<select value={row.account_id} required onChange={event=>update(row.rowId,{account_id:event.target.value})}><option value="" disabled>선택</option>{bootstrap.accounts.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><div className="form-grid entry-details"><label>종목 <span className="muted">· 하나 선택</span><select value={row.category_id} required onChange={event=>update(row.rowId,{category_id:event.target.value})}><option value="" disabled>선택</option>{bootstrap.categories.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>메모<input maxLength={2000} placeholder="어떤 기록인가요?" value={row.note} onChange={event=>update(row.rowId,{note:event.target.value})}/></label></div><div className="field-label">태그 <span className="muted">· 여러 개 선택 가능</span></div><TagPicker tags={bootstrap.tags} value={row.tag_ids} onChange={tag_ids=>update(row.rowId,{tag_ids})}/></div>)}</div>
      {!initial&&<button className="add-row-button" type="button" onClick={()=>setRows([...rows,createRow(bootstrap,selectedDate)])}><Plus size={16}/>{selectedDate?`${dateLabel(selectedDate)} 거래 추가`:'거래 추가'}</button>}
      {error&&<div className="error-message" role="alert"><AlertTriangle size={16}/>{error}</div>}
      {conflict&&<div className="conflict-box" role="alert"><h3><AlertTriangle size={17}/> 다른 곳에서 기록이 수정됐어요</h3><p>아래 내용을 비교하고 어떻게 저장할지 선택해 주세요.</p><div className="conflict-compare"><div><strong>서버의 최신 기록</strong><span>{conflict.date} · {money(conflict.amount)}</span><span>{conflict.note||'메모 없음'} · {conflict.account_name}</span><small>버전 {conflict.version}</small></div><div><strong>내가 수정한 내용</strong><span>{rows[0].date} · {money(Number(rows[0].amount))}</span><span>{rows[0].note||'메모 없음'} · {bootstrap.accounts.find(a=>a.id===rows[0].account_id)?.name}</span><small>버전 {version}에서 수정</small></div></div><div className="button-row"><button type="button" className="secondary-button" disabled={busy} onClick={()=>{setRows([{...conflict,rowId:conflict.id,amount:String(conflict.amount)}]);setSelectedDate(conflict.date);setVersion(conflict.version);setConflict(null)}}>최신 내용 불러오기</button><button type="button" className="primary-button" disabled={busy} onClick={()=>void save(conflict.version)}>내 수정 내용으로 저장</button></div></div>}
      <div className="modal-actions">{initial?<button type="button" className="danger-button" onClick={()=>void remove()} disabled={busy}><Trash2 size={16}/>삭제</button>:<span className="muted small">{rows.length}건 · {money(rows.filter(row=>row.kind==='expense').reduce((sum,row)=>sum+Number(row.amount),0))} 지출</span>}<div className="button-row"><button type="button" className="secondary-button" onClick={onClose}>취소</button><button className="primary-button" type="submit" disabled={busy||!!conflict}>{busy?'저장 중…':<><Check size={16}/>{initial?'변경 저장':`${rows.length}건 저장하기`}</>}</button></div></div>
    </form>
  </Modal>
}
