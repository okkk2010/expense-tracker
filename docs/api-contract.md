# Frontend / Backend contract

Base: `/api`. JSON camel_case is NOT used; field names below are snake_case. IDs are strings. Dates `YYYY-MM-DD`, months `YYYY-MM`. Amounts are integer KRW, non-negative; kind is `expense`, `income`, or `transfer`. The Node.js/Fastify backend preserves the error envelope `{detail: string|object|array}`. Access via optional `Authorization: Bearer <personal access token>`; no user accounts.

## Shared types

- Account: `{id,name,description,color}`; seed names 기업은행, 국민카드, 토스 카드, 여유 생활비. Descriptions preserve salary / fixed living costs / current subscriptions+previous transport / leisure unassigned instrument.
- Category: `{id,name,color}` seeded 식사, 생활, 구독, 교통, 취미, 기타.
- Tag: `{id,name,color,archived:false}`.
- Transaction: `{id,date,amount,kind,account_id,category_id,tag_ids:[],note,version,created_at,updated_at,account_name,category_name,tag_names:[]}`.
- Budget: `{tag_id,tag_name,month,amount,spent,remaining,inherited,from_month}`; one tag per budget. Last explicitly saved amount at or before month inherits to later unspecified months; remaining/overage never carries. Setting future amount does not mutate past months or separately set future months.
- AnalysisCard: `{id,kind:"bar"|"line"|"donut"|"metric"|"text",title,data:[{label,value,category_id?,tag_id?,date?}],text?,metadata:{start,end,tag_ids:[],tag_mode:"or"|"and",source:"tools",generated_at,transaction_ids:[]}}`.
- Workspace: `{id,title,snapshot,version,created_at,updated_at}`; snapshot arbitrary JSON with cards, layout, request_summary, filters. Snapshots preserve actual card data, not query-only definitions.

## API

- GET `/health` -> `{status:"ok",version:"0.1.0",auth_required:boolean}` (public).
- GET `/bootstrap` -> `{accounts:[],categories:[],tags:[],settings:{}}`.
- GET `/transactions?start=&end=&account_id=&category_id=&tag_ids=id1,id2&tag_mode=or&kind=expense&q=&limit=500` -> `{items:[],total}`. Dates inclusive; omitted kind includes all. Max limit 5000.
- POST `/transactions/batch` `{items:[{date,amount,kind,account_id,category_id,tag_ids,note}]}` -> `{items:[]}` (atomic).
- PATCH `/transactions/{id}` `{version,...editable_fields}` -> Transaction. Conflict 409 `detail:{message,current,submitted}`. DELETE `/transactions/{id}?version=N`.
- GET `/dashboard?month=YYYY-MM` -> `{month,total_expense,transaction_count,previous_expense,by_category:[{id,name,color,total}],by_account:[{id,name,color,total}],daily:[{date,total}],budgets:[],recent_transactions:[],metadata:{start,end,date_basis:"transaction_date",tag_mode:"or"}}`.
- GET `/budgets?month=YYYY-MM` -> `{items:[]}`. PUT `/budgets/{tag_id}/{month}` `{amount}` -> Budget. DELETE same path removes explicit override. Budget amount=0 is allowed to deactivate.
- POST `/tags` `{name,color}` -> Tag; PATCH `/tags/{id}` `{name?,color?}`; DELETE `/tags/{id}?mode=archive|detach` (default archive retains historical links; detach removes links). POST/PATCH `/categories` analogous if implemented.
- GET `/workspaces` -> `{items:[]}`. POST `/workspaces` `{title,snapshot}` -> Workspace. PUT `/workspaces/{id}` `{title,snapshot,version}` -> Workspace (409 conflict). DELETE `/workspaces/{id}`.
- GET `/backup` -> JSON backup including schema_version and all user data. POST `/restore` with that JSON -> `{restored:true}`; validate all references and replace atomically. Secrets excluded.
- POST `/analysis` `{prompt,filters?:{start,end,tag_ids,tag_mode,category_id,account_id},reference?:{cards,layout,request_summary,filters}}` -> `{status:"complete"|"clarification",message?,cards:[],provider:"rules"|"compatible",suggestions?:[]}`.

## iPhone Shortcuts collection

Management endpoints below require a configured `APP_ACCESS_TOKEN` and the normal personal Bearer credential. Collection keys are random per-connection credentials, stored only as hashes. They authorize **only** `POST /shortcuts/ingest`; they cannot read the ledger or manage connections. Tokens are returned once at creation/rotation and never in lists or backups.

- POST `/accounts` `{name,description?,color?}` -> Account (201). Allows a bank account to be added separately from the initial credit-card account.
- GET `/shortcuts/connections` -> `{items:[]}`.
- POST `/shortcuts/connections` `{name,source:"toss"|"kb",account_id,match_text?,category_id?,tag_ids?,auto_record?,enabled?}` -> `{connection,token}` (201). Explicit account mapping is required; auto-record defaults off.
- PATCH `/shortcuts/connections/{id}` updates the public connection fields; DELETE revokes the credential and preserves historical collection events.
- POST `/shortcuts/connections/{id}/rotate` -> `{connection,token}`. Old credential is immediately revoked. Restored connections need rotation before enabling.
- POST `/shortcuts/ingest` uses `Authorization: Bearer <dedicated collection key>`, JSON `{body,title?,subtitle?,source_app?,occurred_at?,event_id?}`; body limit16KiB. `occurred_at` is an ISO timestamp with timezone. `event_id`, if supplied, identifies the original event and must survive retries. Returns `{status:"recorded"|"pending"|"duplicate",event_id,transaction_id,message}`.
- GET `/shortcuts/events?status=pending|recorded|ignored|duplicate&limit=100` -> `{items:[]}`. Omit status for all.
- POST `/shortcuts/events/{id}/record` `{transaction:TransactionDraft}` -> `{event,transaction}`. Repeating a completed record returns its original transaction. Ignored events cannot be recorded; refund/cancellation events must be handled by adjusting the original transaction, not inserting new income/expense.
- POST `/shortcuts/events/{id}/ignore` -> `{event}`. Repeating ignore is safe; an already recorded transaction is not silently removed.

Connection: `{id,name,source,account_id,match_text,category_id,tag_ids,auto_record,enabled,last_received_at,created_at}`. Source is the collection app; it does not imply bank/card identity.

Event: `{id,connection_id,connection_name,source,title,subtitle,body,source_app,occurred_at,received_at,status,reason,parsed,transaction_id}`. `parsed` is a proposed draft, with nullable amount/kind/account/category. The parser may set `kind:"refund"` for review only; this is not a valid ledger transaction kind. Original events are kept separate from posted ledger transactions.

Auto-posting requires a confident KRW payment approval, an explicitly linked account and matching identification phrase, valid category/tags, and no duplicate/uncertainty condition. Generic withdrawals, transfers, settlement, cancellation/refund and foreign currency are held for review. Parsing is local server code and does not send raw notifications to the optional AI provider. Stable event ID or full normalized notification plus supplied notification timestamp supports retry deduplication. Without stable event identity, identical recent text is held for review rather than silently dropping a potentially separate real purchase. Cross-source likely duplicates are held for review.

Schema-version1 backups accept optional `shortcuts_connections` and `shortcuts_events`; old backups remain valid. No reusable collection credential is exported. Restored connections are disabled and automatic recording is turned off until the user rekeys and reviews them.

Device setup and platform limitations: [iPhone setup](iphone-shortcuts.md). Server-side tests do not establish that a particular iOS/bank app forwards notification content.

## Analysis module interface

`backend/src/analysis.js` exports `async function analyzeRequest(payload, queryTransactions, context)`.
The callback takes transaction filters above and returns decorated Transaction dicts. Context has accounts/categories/tags. No arbitrary SQL or data writes. Backend route wires it. Optional compatible LLM env: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`. If not configured, honest rules-based analysis without pretending an LLM is connected. Use actual tool-computed data and clarify ambiguous ranges; user-selected filters are explicit range context.

## Initial implementation choices (editable)

Dashboard starts with monthly expenses, categories and individual tag budgets. Tag archive preserves history; UI offers permanent detach separately. Saving a modified saved workspace offers both save-as-new and update-original. Expense total deduplicates transactions; tag subtotals can overlap. No sample transactions in real DB; explicitly separate demo display is allowed and labeled.
