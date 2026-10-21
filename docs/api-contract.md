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

## Analysis module interface

`backend/src/analysis.js` exports `async function analyzeRequest(payload, queryTransactions, context)`.
The callback takes transaction filters above and returns decorated Transaction dicts. Context has accounts/categories/tags. No arbitrary SQL or data writes. Backend route wires it. Optional compatible LLM env: `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`. If not configured, honest rules-based analysis without pretending an LLM is connected. Use actual tool-computed data and clarify ambiguous ranges; user-selected filters are explicit range context.

## Initial implementation choices (editable)

Dashboard starts with monthly expenses, categories and individual tag budgets. Tag archive preserves history; UI offers permanent detach separately. Saving a modified saved workspace offers both save-as-new and update-original. Expense total deduplicates transactions; tag subtotals can overlap. No sample transactions in real DB; explicitly separate demo display is allowed and labeled.
