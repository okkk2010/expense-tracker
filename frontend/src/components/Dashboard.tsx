import { useState } from 'react'
import { ArrowDown, ArrowUpRight, Plus } from 'lucide-react'
import { api, errorMessage } from '../api'
import { demoTransactions } from '../demo'
import type { Dashboard as DashboardData, Transaction } from '../types'
import { money, monthLabel, monthRange, won } from '../utils'
import { Empty, Loading, Modal, TransactionList } from './Shared'

export function Dashboard({data,month,onAdd,onManageAccounts,demo=false}: {data:DashboardData;month:string;onAdd:()=>void;onManageAccounts:()=>void;demo?:boolean}) {
  const [evidence,setEvidence]=useState<{title:string;categoryId:string}|null>(null)
  const [evidenceItems,setEvidenceItems]=useState<Transaction[]>([])
  const [evidenceBusy,setEvidenceBusy]=useState(false)
  const [evidenceError,setEvidenceError]=useState('')
  async function showCategory(id:string,name:string){
    setEvidence({title:`${name}에 포함된 거래`,categoryId:id});setEvidenceItems([]);setEvidenceBusy(true);setEvidenceError('')
    try{
      const range=monthRange(month)
      const query=new URLSearchParams({...range,category_id:id,kind:'expense',limit:'5000'})
      const result=demo?{items:demoTransactions(month).filter(t=>t.category_id===id&&t.kind==='expense'),total:0}:await api<{items:Transaction[];total:number}>(`/transactions?${query}`)
      setEvidenceItems(result.items)
      if(result.total>5000)setEvidenceError(`포함된 거래 ${result.total.toLocaleString('ko-KR')}건 중 최신 5,000건을 표시합니다.`)
    }catch(error){setEvidenceError(errorMessage(error))}finally{setEvidenceBusy(false)}
  }
  const difference=data.previous_expense?Math.round((data.total_expense/data.previous_expense-1)*100):null
  const maximum=Math.max(...data.by_category.map(item=>item.total),1)
  const dailyMax=Math.max(...data.daily.map(item=>item.total),1)
  const categories=data.by_category.filter(item=>item.total>0)

  return <>
    <div className="page-intro"><div><h1>한눈에 보기</h1><p>{monthLabel(month)}</p></div><button className="primary-button" onClick={onAdd}><Plus size={17}/>거래 기록하기</button></div>
    <div className="overview-top overview-top-compact"><section className="expense-hero">
      <div className="hero-top"><span>월 지출</span></div>
      <div className="hero-value">{won(data.total_expense)}<span>원</span></div>
      <div className="hero-comparison">{difference!==null?<><span className={`change-pill ${difference<=0?'positive':''}`}>{difference<=0?<ArrowDown size={13}/>:<ArrowUpRight size={13}/>} {Math.abs(difference)}%</span><span>지난달 전체 지출 대비</span></>:<span>지난달 지출 {money(data.previous_expense)}</span>}</div>
      {data.daily.some(day=>day.total>0)&&<div className="daily-bars" role="img" aria-label="날짜별 지출 추이">{data.daily.map((day,index)=><div key={day.date} className={index===data.daily.length-1?'current':''} style={{height:`${day.total>0?12+day.total/dailyMax*68:0}%`}} title={`${day.date} · ${money(day.total)}`}/>)}</div>}
      <div className="hero-bottom"><span>거래 수</span><strong>{data.transaction_count}건</strong></div>
    </section></div>
    <div className="dashboard-grid">
      <section className="panel category-panel"><div className="section-heading"><h2>종목별 지출</h2></div>
        {categories.length>0?<div className="category-bars">{categories.map((item,index)=><button type="button" className="category-line chart-click-target" key={item.id} onClick={()=>void showCategory(item.id,item.name)} aria-label={`${item.name} 지출에 포함된 거래 보기`} style={{display:'block',width:'100%',textAlign:'left',border:0,padding:0,background:'transparent',cursor:'pointer'}}><div className="category-label"><span><span className="color-dot" style={{background:item.color}}/>{item.name}</span><strong>{money(item.total)}<small>{data.total_expense?Math.round(item.total/data.total_expense*100):0}%</small></strong></div><div className="category-track"><span style={{width:`${item.total/maximum*100}%`,background:item.color,animationDelay:`${index*80}ms`}}/></div></button>)}</div>:<p className="dashboard-empty-compact">이 기간의 지출이 없습니다.</p>}
      </section>
      <section className="panel accounts-panel"><div className="section-heading"><h2>금융수단별 지출</h2><button className="text-button" onClick={onManageAccounts} aria-label="금융수단 관리">관리 <ArrowUpRight size={14}/></button></div>{data.by_account.length?<div className="accounts-list">{data.by_account.map(account=><div className="account-item" key={account.id}><span className="color-dot" style={{background:account.color}} aria-hidden="true"/><div className="account-summary-details"><strong className="account-name">{account.name}{account.archived&&<span className="muted small"> · 보관됨</span>}</strong>{account.description&&<p>{account.description}</p>}</div><strong className="account-sum">{money(account.total)}</strong></div>)}</div>:<p className="dashboard-empty-compact">등록한 금융수단이 없습니다. 관리에서 추가해 주세요.</p>}</section>
    </div>
    {evidence&&<Modal title={evidence.title} subtitle={`${monthRange(month).start} — ${monthRange(month).end} · 거래일 기준 · 지출`} onClose={()=>setEvidence(null)}>{evidenceError&&<p className="inline-note">{evidenceError}</p>}{evidenceBusy?<Loading/>:evidenceItems.length?<TransactionList items={evidenceItems}/>:<Empty title="포함된 거래가 없어요" text="선택한 종목과 기간에 맞는 기록을 확인해 주세요."/>}</Modal>}
  </>
}
