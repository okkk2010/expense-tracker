import type { Bootstrap, Dashboard, Transaction } from './types'
import { monthRange } from './utils'

export const demoBootstrap: Bootstrap = {
  accounts: [
    {id:'a1', name:'기업은행', description:'월급을 받는 통장', color:'#243d32'},
    {id:'a2', name:'국민카드', description:'고정 생활비 · 식비 등', color:'#9aaf81'},
    {id:'a3', name:'토스 카드', description:'당월 구독료 · 전월 교통비', color:'#c6a776'},
    {id:'a4', name:'여유 생활비', description:'여가 · 취미 · 데이트 / 금융수단 미정', color:'#a6b7cb'},
  ],
  categories: [{id:'c1',name:'식사',color:'#294a3b'},{id:'c2',name:'생활',color:'#8caa78'},{id:'c3',name:'구독',color:'#b4c998'},{id:'c4',name:'교통',color:'#c6a878'},{id:'c5',name:'취미',color:'#afbfc9'},{id:'c6',name:'기타',color:'#d5d8ce'}],
  tags: [{id:'t1',name:'평일 점심',color:'#82a578',archived:false},{id:'t2',name:'함께하는 시간',color:'#c4a184',archived:false},{id:'t3',name:'정기 구독',color:'#9cafd0',archived:false},{id:'t4',name:'나를 위한 소비',color:'#a396bd',archived:false}], settings: {},
}
export function demoTransactions(month: string): Transaction[] {
  const rows: [number,number,string,string,string[],string][] = [[21,12000,'a2','c1',['t1'],'든든한 점심 한 끼'],[20,17900,'a3','c3',['t3'],'넷플릭스 정기 결제'],[19,48500,'a4','c1',['t2'],'주말 저녁 식사'],[18,32400,'a2','c2',[],'집에 필요한 것들'],[17,28000,'a4','c5',['t4'],'오래 읽고 싶은 책'],[16,65000,'a3','c4',[],'지난달 대중교통 이용'],[15,11500,'a2','c1',['t1'],'점심 식사'],[12,36000,'a4','c5',['t2','t4'],'함께 본 영화']]
  const remainder=[414500,246000,107000,103500,82000,44000]
  const counts=[16,12,6,6,6,4]
  remainder.forEach((total,categoryIndex)=>{const count=counts[categoryIndex];const amount=Math.floor(total/count/100)*100;for(let i=0;i<count;i++){const category=demoBootstrap.categories[categoryIndex];const tags=categoryIndex===0&&i%3===0?['t1']:categoryIndex===0&&i%5===0?['t2']:categoryIndex===2?['t3']:categoryIndex===4?[i%2===0?'t2':'t4']:[];rows.push([1+(i*7+categoryIndex)%14,i===count-1?total-amount*(count-1):amount,categoryIndex<2?'a2':categoryIndex<4?'a3':'a4',category.id,tags,['점심과 저녁','생활에 필요한 물품','정기 서비스 구독','이동한 날의 기록','취미를 즐긴 시간','소소한 일상'][categoryIndex]])}})
  return rows.map(([day,amount,account_id,category_id,tag_ids,note],i):Transaction => ({id:`demo-${i}`,date:`${month}-${String(day).padStart(2,'0')}`,amount,kind:'expense',account_id,category_id,tag_ids,note,version:1,created_at:'',updated_at:'',account_name:demoBootstrap.accounts.find(x=>x.id===account_id)!.name,category_name:demoBootstrap.categories.find(x=>x.id===category_id)!.name,tag_names:tag_ids.map(id=>demoBootstrap.tags.find(x=>x.id===id)!.name)})).sort((a,b)=>b.date.localeCompare(a.date))
}
export function demoDashboard(month: string): Dashboard {
  const items=demoTransactions(month)
  return {month,total_expense:items.reduce((sum,item)=>sum+item.amount,0),transaction_count:items.length,previous_expense:1396200,
    by_category: demoBootstrap.categories.map(category=>({...category,total:items.filter(item=>item.category_id===category.id).reduce((sum,item)=>sum+item.amount,0)})),
    by_account:demoBootstrap.accounts.map(account=>({...account,total:items.filter(item=>item.account_id===account.id).reduce((sum,item)=>sum+item.amount,0)})),
    daily:Array.from({length:21},(_,i)=>{const date=`${month}-${String(i+1).padStart(2,'0')}`;return {date,total:items.filter(item=>item.date===date).reduce((sum,item)=>sum+item.amount,0)}}),
    budgets:demoBootstrap.tags.slice(0,3).map((tag,index)=>{const amount=[250000,300000,150000][index];const spent=items.filter(item=>item.tag_ids.includes(tag.id)).reduce((sum,item)=>sum+item.amount,0);return {tag_id:tag.id,tag_name:tag.name,month,amount,spent,remaining:amount-spent,inherited:index!==1,from_month:index!==1?'2026-09':null}}),recent_transactions:items.slice(0,5), metadata:{...monthRange(month),date_basis:'transaction_date',tag_mode:'or'}}
}
