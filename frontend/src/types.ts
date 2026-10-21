export type Kind = 'expense' | 'income' | 'transfer'
export type Page = 'overview' | 'transactions' | 'budgets' | 'workspace' | 'settings'
export interface Account { id: string; name: string; description: string; color: string }
export interface Category { id: string; name: string; color: string }
export interface Tag { id: string; name: string; color: string; archived: boolean }
export interface Bootstrap { accounts: Account[]; categories: Category[]; tags: Tag[]; settings: Record<string, unknown> }
export interface TransactionDraft { date: string; amount: number; kind: Kind; account_id: string; category_id: string; tag_ids: string[]; note: string }
export interface Transaction extends TransactionDraft { id: string; version: number; created_at: string; updated_at: string; account_name: string; category_name: string; tag_names: string[] }
export interface Budget { tag_id: string; tag_name: string; month: string; amount: number; spent: number; remaining: number; inherited: boolean; from_month: string | null }
export interface Dashboard { month: string; total_expense: number; transaction_count: number; previous_expense: number; by_category: {id: string; name: string; color: string; total: number}[]; by_account: {id: string; name: string; color: string; total: number}[]; daily: {date: string; total: number}[]; budgets: Budget[]; recent_transactions: Transaction[]; metadata: {start: string; end: string; date_basis: string; tag_mode: string} }
export interface AnalysisFilters { start: string; end: string; tag_ids: string[]; tag_mode: 'or' | 'and'; category_id?: string; account_id?: string }
export interface AnalysisCard { id: string; kind: 'bar' | 'line' | 'donut' | 'metric' | 'text'; title: string; data: {label: string; value: number; category_id?: string; tag_id?: string; date?: string}[]; text?: string; metadata: {start: string; end: string; tag_ids: string[]; tag_mode: 'or' | 'and'; source: string; generated_at: string; transaction_ids: string[]} }
export interface Snapshot { cards: AnalysisCard[]; layout: unknown; request_summary: string; filters: AnalysisFilters }
export interface Workspace { id: string; title: string; snapshot: Snapshot; version: number; created_at: string; updated_at: string }
export interface AnalysisResult { status: 'complete' | 'clarification'; message?: string; cards: AnalysisCard[]; provider: 'rules' | 'compatible'; suggestions?: string[] }
export interface Connection { url: string; token: string }
export interface ScreenProps { bootstrap: Bootstrap; month: string; demo: boolean; refreshKey: number; onRefresh: () => void; notify: (message: string, error?: boolean) => void }
