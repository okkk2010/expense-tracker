import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ArrowUpRight, BookOpen, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, CircleHelp, FlaskConical, LayoutDashboard, PanelLeftClose, Settings2, Sparkles, Target, WifiOff, X } from 'lucide-react'
import { api, errorMessage } from './api'
import { demoBootstrap, demoDashboard } from './demo'
import type { Bootstrap, Dashboard as DashboardData, Page, Transaction } from './types'
import { monthLabel, monthRange, shiftMonth, today } from './utils'
import { Dashboard } from './components/Dashboard'
import { Transactions, TransactionEditor } from './components/Transactions'
import { Budgets } from './components/Budgets'
import { Workspace } from './components/Workspace'
import { Settings } from './components/Settings'

const emptyBootstrap:Bootstrap={accounts:[],categories:[],tags:[],settings:{}}
function emptyDashboard(month:string,bootstrap:Bootstrap):DashboardData{return {month,total_expense:0,transaction_count:0,previous_expense:0,by_category:bootstrap.categories.map(item=>({...item,total:0})),by_account:bootstrap.accounts.map(item=>({...item,total:0})),daily:[],budgets:[],recent_transactions:[],metadata:{...monthRange(month),date_basis:'transaction_date',tag_mode:'or'}}}
const navigation=[{id:'overview',title:'한눈에 보기',icon:LayoutDashboard},{id:'transactions',title:'거래 기록',icon:BookOpen},{id:'budgets',title:'태그 예산',icon:Target},{id:'workspace',title:'AI 작업 공간',icon:Sparkles}] as const
export default function App(){
  const [page,setPage]=useState<Page>('overview')
  const [month,setMonth]=useState(today().slice(0,7))
  const [bootstrap,setBootstrap]=useState<Bootstrap>(emptyBootstrap)
  const [data,setData]=useState<DashboardData>(()=>emptyDashboard(month,emptyBootstrap))
  const [connected,setConnected]=useState(false)
  const [loading,setLoading]=useState(true)
  const [connectionError,setConnectionError]=useState('')
  const [demo,setDemo]=useState(false)
  const [refreshKey,setRefreshKey]=useState(0)
  const [syncKey,setSyncKey]=useState(0)
  const [editing,setEditing]=useState<Transaction|null|undefined>(undefined)
  const [toast,setToast]=useState<{message:string;error:boolean}|null>(null)
  const [sidebarSmall,setSidebarSmall]=useState(false)
  const [workspaceSession,setWorkspaceSession]=useState(0)
  const connectionContext=useRef('')
  const notify=(message:string,error=false)=>setToast({message,error})
  const refresh=()=>setRefreshKey(value=>value+1)
  useEffect(()=>{
    let active=true
    let inFlight=false
    let lastStartedAt=0
    const controller=new AbortController()
    const context=`${demo?'demo':'real'}-${workspaceSession}`
    const changedConnection=connectionContext.current!==context
    connectionContext.current=context
    if(demo){setBootstrap(demoBootstrap);setData(demoDashboard(month));setLoading(false);return()=>{active=false}}
    if(changedConnection){setBootstrap(emptyBootstrap);setData(emptyDashboard(month,emptyBootstrap));setConnected(false)}
    const synchronize=async(background=false)=>{
      if(!active||inFlight||(background&&(document.visibilityState==='hidden'||Date.now()-lastStartedAt<1500)))return
      inFlight=true;lastStartedAt=Date.now()
      if(!background){setLoading(true);setConnectionError('')}
      try{
        await api('/health',{signal:controller.signal})
        const [boot,dashboard]=await Promise.all([api<Bootstrap>('/bootstrap',{signal:controller.signal}),api<DashboardData>(`/dashboard?month=${month}`,{signal:controller.signal})])
        if(active){setBootstrap(boot);setData(dashboard);setConnected(true);setConnectionError('');if(background)setSyncKey(value=>value+1)}
      }catch(error){if(active){setConnected(false);setConnectionError(errorMessage(error))}}
      finally{inFlight=false;if(active&&!background)setLoading(false)}
    }
    void synchronize()
    const onReturn=()=>{if(document.visibilityState==='visible')void synchronize(true)}
    const interval=window.setInterval(()=>void synchronize(true),15000)
    window.addEventListener('focus',onReturn)
    window.addEventListener('online',onReturn)
    document.addEventListener('visibilitychange',onReturn)
    return()=>{active=false;controller.abort();clearInterval(interval);window.removeEventListener('focus',onReturn);window.removeEventListener('online',onReturn);document.removeEventListener('visibilitychange',onReturn)}
  },[month,refreshKey,demo,workspaceSession])
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(null),toast.error?8500:4500);return()=>clearTimeout(timer)},[toast])
  const changePage=(next:Page)=>{setPage(next);window.scrollTo({top:0,behavior:'smooth'})}
  const openEntry=(initial:Transaction|null=null)=>{if(demo){notify('지금은 예시 데이터를 둘러보고 있어요. 서버에 연결하면 실제 거래를 기록할 수 있어요.');return}if(!connected){setPage('settings');notify('먼저 내 서버를 연결해 주세요.');return}setEditing(initial)}
  const props={bootstrap,month,demo,refreshKey:refreshKey+syncKey,onRefresh:refresh,notify}
  return <div className={`app-shell ${sidebarSmall?'sidebar-small':''}`}><a href="#main-content" className="skip-link">본문으로 바로 가기</a>
    <aside className="sidebar">
      <a className="brand" href="#" onClick={event=>{event.preventDefault();changePage('overview')}} aria-label="모아 홈"><span className="brand-symbol"><svg width="26" height="29" viewBox="0 0 26 29" fill="none" aria-hidden="true"><path d="M3 23V13a10 10 0 0 1 20 0v10" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"/><path d="M9 24V13a4 4 0 0 1 8 0v11" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"/></svg></span><span>모아<span className="brand-period">.</span></span></a>
      <nav aria-label="주요 메뉴">{navigation.map(({id,title,icon:Icon})=><button key={id} className={`nav-item ${page===id?'active':''}`} onClick={()=>changePage(id)} aria-current={page===id?'page':undefined} title={title}><Icon size={19} strokeWidth={1.7}/><span>{title}</span></button>)}</nav>
      <div className="sidebar-bottom"><div className="sidebar-settings">
        <button className={`nav-item ${page==='settings'?'active':''}`} onClick={()=>changePage('settings')} title="설정"><Settings2 size={19} strokeWidth={1.7}/><span>설정</span></button>
        <button className="icon-button sidebar-collapse" onClick={()=>setSidebarSmall(!sidebarSmall)} aria-label={sidebarSmall?'메뉴 펼치기':'메뉴 접기'}><PanelLeftClose size={17}/></button>
      </div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumbs"><span>나의 가계부</span><span>/</span><strong>{page==='settings'?'설정':navigation.find(item=>item.id===page)?.title}</strong></div><div className="topbar-actions"><div className="month-control"><button className="icon-button" aria-label="이전 달" onClick={()=>setMonth(shiftMonth(month,-1))}><ChevronLeft size={17}/></button><label><CalendarDays size={15}/><span>{monthLabel(month)}</span><input type="month" aria-label="조회 월 선택" value={month} onChange={event=>{if(/^\d{4}-\d{2}$/.test(event.target.value))setMonth(event.target.value)}}/></label><button className="icon-button" aria-label="다음 달" onClick={()=>setMonth(shiftMonth(month,1))}><ChevronRight size={17}/></button></div><span className="topbar-divider"/><button className={`connection-status ${connected&&!demo?'connected':''} ${demo?'demo-status':''}`} onClick={()=>changePage('settings')}><span/>{demo?'둘러보기':loading?'확인 중':connected?'서버 연결됨':'연결 필요'}</button></div></header>
      <main id="main-content" className={`main-content ${page==='workspace'?'workspace-page':''}`}>
        {demo?<div className="demo-banner"><span><FlaskConical size={16}/><strong>둘러보기</strong> 예시 데이터예요. 실제 기록과 분리되어 있어요.</span><button onClick={()=>{setDemo(false);refresh()}}>내 기록으로 돌아가기 <ArrowRight size={14}/></button></div>:connectionError?<div className="connection-banner"><span><WifiOff size={17}/><span><strong>내 서버를 연결해 주세요</strong><small>{connectionError}</small></span></span><div className="button-row"><button onClick={()=>changePage('settings')}>연결 설정 <ArrowUpRight size={14}/></button><button onClick={()=>setDemo(true)}>화면 둘러보기</button></div></div>:null}
        {page==='overview'&&<Dashboard data={data} month={month} onAdd={()=>openEntry()} demo={demo}/>}
        {page==='transactions'&&<Transactions {...props} onAdd={()=>openEntry()} onEdit={item=>openEntry(item)}/>}
        {page==='budgets'&&<Budgets {...props}/>}
        <div hidden={page!=='workspace'}><Workspace key={`${demo?'demo':'real'}-${workspaceSession}`} {...props}/></div>
        {page==='settings'&&<Settings {...props} connected={connected&&!demo} onConnect={()=>{setDemo(false);setWorkspaceSession(value=>value+1);refresh()}}/>}
      </main><nav className="mobile-nav" aria-label="모바일 주요 메뉴">{[...navigation,{id:'settings' as const,title:'설정',icon:Settings2}].map(({id,title,icon:Icon})=><button key={id} className={page===id?'active':''} onClick={()=>changePage(id)} aria-current={page===id?'page':undefined}><Icon size={20}/><span>{title}</span></button>)}</nav>
    </div>
    {editing!==undefined&&<TransactionEditor bootstrap={bootstrap} initial={editing} onClose={()=>setEditing(undefined)} onSaved={refresh} notify={notify}/>}
    {toast&&<div className={`toast ${toast.error?'error':''}`} role={toast.error?'alert':'status'}>{toast.error?<CircleHelp size={18}/>:<CheckCircle2 size={18}/>}<span>{toast.message}</span><button className="icon-button" onClick={()=>setToast(null)} aria-label="알림 닫기"><X size={16}/></button></div>}
  </div>
}
