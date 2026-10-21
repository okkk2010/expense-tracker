export const won = (value: number) => new Intl.NumberFormat('ko-KR').format(Math.round(value || 0))
export const money = (value: number) => `${won(value)}원`
export function today() { return new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date()) }
export function monthRange(month: string) { const [year, m] = month.split('-').map(Number); return {start: `${month}-01`, end: `${month}-${new Date(year, m, 0).getDate()}`} }
export function shiftMonth(month: string, delta: number) { const [year, m] = month.split('-').map(Number); const date = new Date(year, m-1+delta, 1); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}` }
export const monthLabel = (month: string) => `${month.split('-')[0]}년 ${Number(month.split('-')[1])}월`
export const dateLabel = (date: string) => new Intl.DateTimeFormat('ko-KR', {month: 'long', day: 'numeric', weekday: 'short', timeZone:'Asia/Seoul'}).format(new Date(`${date}T12:00:00+09:00`))
export function downloadJson(data: unknown, name: string) { const href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type:'application/json'})); const anchor = document.createElement('a'); anchor.href = href; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 1000) }
