# Quota Guard Proxy — Technical Specification

> **Implementation note:** This document is the original design target, not a claim that every feature is shipped. Current v0.1 uses Node.js native HTTP (not Fastify), JSON-only runtime config (not YAML), and denies Chat Completions/function calling pending verified token accounting. Consult [README](README.md), [billing validation](docs/billing-validation.md), and [test matrix](docs/test-matrix.md) for tested functionality and NO-GO limitations.


- 版本：v0.1（實作規格）
- 日期：2026-10-11
- 優先級：P0 防止意外計費 > P1 OpenAI-compatible 相容性 > P2 多模型 Router 整合
- 核心設計：OpenAI Data Sharing 免費額度保護獨立成 Proxy；OMP 負責跨 Provider 派工及 Fallback。

## 1. 目標與不可妥協原則

**目標**：為使用者目前的 OpenAI Data Sharing 每日 1M（高階）與 10M（輕量）免費 Token 建立 OpenAI-compatible 反向代理，按 UTC 日追蹤配額，送出前預留最壞情境 Token，快用盡時拒絕新請求，並讓 OMP 切換 Codex Plus / OpenCode Go / Claude API / Grok 等獨立資源。

**硬性原則**：
1. 預設 `FREE_ONLY`，不允許任何請求自動降級成「用 OpenAI API 付費繼續」。
2. `fail_closed=true`：模型資格、Token 預估、帳務狀態、資料分享資格、儲存狀態任一不可信即拒絕。
3. 只能承諾**阻擋代理自身已知會超出安全上限的請求**；OpenAI 未提供保證即時與原子配額預留的免費額度 API。存在繞過 Proxy 的組織流量、帳務延遲或後端差異時，不得宣稱「100% 不扣費」。
4. 禁止未經許可的付費工具呼叫及其他非優惠 API 路由；禁止自動付費重試。
5. 公司專有程式碼、客戶資料、憑證與其他敏感資料不得送入啟用 Data Sharing 的專案。
6. 保留 Claude Code Max 日常使用，不把其訂閱消耗納入這個 Proxy；公司 Copilot 維持獨立帳號/政策域。

## 2. 已確認的計費事實與必須驗證的事項

- 官方 Data Sharing 優惠僅適用於符合資格、已啟用分享的專案與指定模型。高階/輕量額度**各群組共享**，不是每個模型獨立。
- 以使用者目前資格配置 `1_000_000` 與 `10_000_000` Token/UTC day，但啟動前必須人工確認資格、適用模型與配額；模型資格名單不可推測。
- Input + Output Token 計入；只要一筆請求讓每日累計超出配額，**整筆請求可能按一般費率計費**。每日 `00:00 UTC` 重置（台灣時間 08:00）。
- 官方排除 fine-tuning、evals 與 tool use 的優惠；內建付費工具預設拒絕。對 function calling 與其相關 Token 是否適用，必須以實際官方帳務校正結果驗證，**驗證前不要標記為免費**。
- Organization Usage API 提供模型用量統計（可依 model/project 等分組），但不能直接當成「精確、即時、可原子扣減的 Data Sharing 剩餘額度」。API `service_tier` 分組不等於已確認能辨識免費優惠計費歸屬。
- Dashboard 的「Data sharing incentive tier」及 Costs 應用來校驗模型歸類、免費實際用量與是否出現意外費用。
- 專案 Budget/Spend Limit 只作額外保護，**不得當作逐請求、無延遲、零扣款硬保證**。

參考：
- https://help.openai.com/en/articles/10306912-sharing-feedback-evaluation-and-fine-tuning-data-and-api-inputs-and-outputs-with-openai
- https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions
- https://developers.openai.com/api/docs/guides/token-counting

## 3. 系統架構

```text
OMP / Pi / OpenAI-compatible Client
            |
            v
  Quota Guard Proxy (localhost:8787)
    |- Auth / Model Allowlist / Data Policy
    |- Preflight Token Counter
    |- SQLite Atomic Quota Reservation
    |- SSE / JSON Upstream Transport
    |- Settle / Unknown-Outcome Handling
    |- Read-only Quota Status API
            |
            v
  Dedicated OpenAI Project API Key
            |
            v
         OpenAI API

Separately: Admin Usage Collector -> Org Usage API
            |                  
            +-> Reconciliation / High-watermark / Alert

OMP quota-router Extension <-- denied / quota state
    +-> Codex Plus (OAuth)
    +-> OpenCode Go (subscription)
    +-> Claude API credits (budget aware)
    +-> Grok via verified subscription path
```

**實作堆疊**：Node.js 22+、TypeScript、Fastify、SQLite（WAL，單一 writer/單 instance）。單機本地使用時僅監聽 `127.0.0.1`；跨主機使用需 mTLS/反向代理認證。Admin Usage Collector 與請求 Proxy 分開程序和憑證權限。

**範圍**：本規格實作 OpenAI Data Sharing Quota Guard + OMP Fallback 合約；其他供應商的 5h/週限額公平路由只定義介面，不在 v0.1 重新實作。

## 4. API 與相容性

### 客戶端 API

- `POST /v1/responses`：原生 Responses API（支援 JSON；可選 SSE）。
- `POST /v1/chat/completions`：OpenAI Chat Completions 相容介面（支援 JSON；可選 SSE）。
- `GET /v1/models`：僅列出經驗證、目前允許的 model ID。
- `GET /health/live`、`GET /health/ready`。
- `GET /quota`：回傳「保守估算的剩餘可接納 Token」，不是官方保證餘額。

其他路徑（包括 `batches`、`files`、`audio`、`images`、`fine_tuning`、`vector_stores`、官方內建工具相關端點）全部預設 403/404，不允許透過任意 `path` 通配代理到上游。

### 自訂錯誤格式

```json
{
  "error": {
    "type": "quota_guard_denied",
    "code": "FREE_QUOTA_EXHAUSTED",
    "message": "Quota Guard blocked this OpenAI request before dispatch.",
    "group": "premium",
    "retry_at": "2026-10-12T00:00:00Z"
  }
}
```

- 額度不足：HTTP 429，`FREE_QUOTA_EXHAUSTED`。
- 無法信任帳務/資格/計數：HTTP 503，`FREE_QUOTA_UNVERIFIED`。
- 未授權模型/付費功能/違反資料政策：HTTP 403，`MODEL_NOT_ELIGIBLE` 或 `PAID_FEATURE_BLOCKED`。
- 回傳 `X-Quota-Guard-Reason`、`X-Request-ID`；不要洩漏 Admin API Key 或 OpenAI 上游憑證。
- `GET /quota` 不輸出敏感計費金額、完整 Prompt 或金鑰。
- SSE 須保留 OpenAI 事件格式、usage、finish_reason、工具呼叫片段；串流不可由 Proxy 擅自重播或換模型。

## 5. Model Eligibility Policy

模型清單採**明確 allowlist**（精確版本 model ID），資料包含：

```yaml
modelPolicy:
  source: manually_verified_official_eligibility
  unknownModel: deny
  unknownEndpoint: deny
  unknownToolType: deny
  modelGroups:
    premium:
      dailyTokens: 1000000
      safetyPct: 85
      models: [] # 部署時按官方名單與實際帳務驗證後填入
    economy:
      dailyTokens: 10000000
      safetyPct: 85
      models: []
  allowedEndpoints: [responses, chat.completions]
  allowHostedTools: false
  allowUnverifiedFunctionCalling: false
```

任何 `model` alias、未明確標示版本、新版未知 Model、內建工具、批次/背景任務、音視訊、多模態、未支援的 stateful conversation 或其他無法可靠計數的功能，一律拒絕。不能默默移除工具欄位或把模型改成別的 model ID。

對 coding-agent 所需的 function tools，先以可重現的 Dashboard/Costs 實測確認優惠計費，再按具體功能白名單逐步開放；未確認前以純文字/程式碼分析工作為 P0 驗收範圍。

## 6. Quota Admission（最重要）

每個 UTC 日、每個群組分別維護：`official_proxy`（路由專案官方累計）、`official_external_known`（其他專案官方累計，已確認群組）、`unknown_external`（當日外部未知模型 Token 總和，唯一群組、雙邊同計）、`verified_proxy_baseline`（准入前已驗證的路由專案用量）、`proxy_local_committed`（已完成實際用量＋未結算預留上界）、`external_safety_reserve`（外部延遲消耗保守上界）、`admission_cap`、`last_successful_poll`。

- `admission_cap = floor(dailyTokens * safetyPct / 100)`（預設 premium 850K、economy 8.5M）。
- `effective_used = official_proxy + official_external_known + unknown_external + outstanding + max(0, anchor + settled − official_proxy) + cross_day_carry + reserve`; `remaining = max(0, admission_cap − effective_used)`；僅當 `new_request_reservation ≤ remaining` 且觀測新鮮可信才准入。其中 `unknown_external` 同時計入 Premium 與 Economy 的保守估計（雙邊各自上界安全）；已確認群組不重複扣除；`outstanding` 為當日未結算預留、`anchor + settled` 為本地已錨定用量、`cross_day_carry` 為跨日未決預留結轉、`reserve` 為外部安全保留；診斷保留；所有加總皆有 safe-int 溢位檢查，溢位即 `INVALID_USAGE` fail-closed。不依賴專案專用性：不確定 Token 寧可重複扣除，不增加可用額度。
- 組織額度由所有符合條件的服務共享；外部服務可合法繞過 Proxy，其消耗只會收緊准入，絕不觸發 collector 停止。外部 scope 分類只用官方群組映射，不看 Proxy 白名單；映射外的未知模型同時計入雙群組並留診斷紀錄。
- 路由專案可與其他服務共用，無需專用見證：官方 proxy-scope 用量超出本地上界時以 `max(0, anchor + settled − official_proxy)` 保守吸收，不低估放行；不設專用 gate，不設 tripwire。`proxyProjectDedicatedAttestedUntil` / `manualCostsAuditedUntil` / `exclusiveOrgTrafficAttestedUntil` 僅為相容保留，不再是 gate，不需定期重簽。
- 即使官方 Usage API 落後，本地預留與未確定結果也不可釋放；官方觀測總量不得回退；失敗的輪詢不得視為零用量。
- `admit` 必須在 SQLite `BEGIN IMMEDIATE` 單交易中完成餘額檢查 + 預留寫入；所有執行中的 Agent 共享同一個 SQLite DB。
- 估算 `reserve = trusted_input_count + effective_max_output_tokens + account_margin`；`max_output_tokens`（Responses）或 `max_completion_tokens`（Chat）須由 Proxy 強制上限；禁止省略及無界輸出。
- Chat Completions 的 `n` 強制為 `1`；`max_completion_tokens` 包含隱藏推理 Token。Responses 同理包含隱藏輸出 Token。
- Responses 可用 `POST /v1/responses/input_tokens` 做精確輸入計數；使用前需驗證此預檢請求自己的計費/優惠歸屬。Chat Completions 如無已驗證的保守計數上界，直接拒絕，**不可用 `字元數/4` 作免費額度准入**。
- 如果請求附帶 tool schema、圖片、檔案、stateful reference、cache 變化等，沒有可信計數就 `FREE_QUOTA_UNVERIFIED`。
- 只有完成准入和預留後才能送出上游 HTTP 請求；不得先呼叫 OpenAI 再判斷是否超額。
- 上游成功並收到完整 usage 時：以實際 `input_tokens + output_tokens` 結算，釋放未使用的預留。
- Timeout、客戶端中斷、串流無最終 usage、無法確認上游是否收到請求時：狀態改 `UNKNOWN`，預留**不得立即釋放**；待可靠對帳或人工確認處理。
- `X-Request-ID` / idempotency key 在 Proxy 層去重；不可因客戶端重試造成雙次上游呼叫。已送出的不確定請求不允許透明重試。
- 重置：按 UTC 00:00 分桶；跨日未結算請求（PENDING/UNKNOWN/MANUAL_REVIEW）保留原日責任，其 `reserved` 全額自動計入新日同群組 `effective_used`（cross-day carry），admit/prepareDispatch/gate 不再跨日阻擋。歷史紀錄與 idempotency 永遠保留，不重送、不偽造 COMPLETED、不刪除。可選的 `reviewDispatchedDay` 流程可將經證實終結於原日的 DISPATCHED UNKNOWN 保守縮減（需 24h cooldown）；日常恢復不需要它。

### 准入示意（非可直接執行程式碼）

```text
validate_auth_and_data_policy()
resolve_exact_model_group_or_deny()
validate_request_features_or_deny()
input = trusted_token_count_or_deny()
output_cap = bounded_output_cap_or_deny()
reserve = input + output_cap + margin
atomic_transaction {
  used = conservative_effective_usage(group, utc_day)
  if used + reserve > admission_cap: DENY
  INSERT reservation(status=PENDING, tokens=reserve)
}
try upstream_call_without_transparent_retries()
  if full_final_usage: SETTLE actual; release residual
  else: MARK_UNKNOWN retain reservation
```

## 7. 帳務對帳與健康狀態

- Admin Usage Collector 使用**獨立 Admin API Key** 查 `GET /v1/organization/usage/completions`，查詢**全組織**（分組 `model,project_id`，必要時以 `service_tier` 輔助驗證），依官方文件 pagination 完整取得資料；不能只看第一頁，不能只篩選路由專案。路由專案 scope 與外部 scope 分別統計後原子發布。
- 來源包括：Org Usage API（全組織）、Proxy 本地 Ledger、Dashboard/Costs 人工抽樣核對。
- `service_tier` 僅用於研究/對帳，不要在沒有正式實證前，把它當免費額度狀態的唯一真相。
- 建立 checkpoint：UTC 日、官方截止時間、路由/外部群組統計、源資料版本、延遲與最後成功/嘗試時間。Collector 在 READY、EXHAUSTED、STALE、DATA_UNVERIFIED、MANUAL_HOLD 下都持續唯讀查詢；API 失敗保留前次有效資料，可恢復的暫停由下一次完整可信觀測自動恢復，人工暫停與真正的安全異常永不自動清除。
- 官方資料落後、模型對應變動、資料分享資格被關閉、admin key 失效、帳務不一致、連線中斷：對應群組進入 `STALE` / `DATA_UNVERIFIED`，**不再放行**；外部服務正常消耗額度不在此列。
- `GET /quota` 每群組回傳 `utc_day`, `official_org_usage`, `official_external_usage`, `official_proxy_usage`, `proxy_local_committed`, `proxy_pending_reserved`, `external_safety_reserve`, `effective_used`, `estimated_remaining`, `last_successful_poll`, `last_poll_attempt`, `observation_age_seconds`, `state`, `pause_reason`, `next_reset_at`（另保留舊欄位相容）。無法取得的數字回傳 null，不可用 0 假裝官方尚未使用。
- `estimated_remaining` 不得標為「官方剩餘免費 Token」。
- 啟用前必須人工檢查 Data Sharing enrollment、專案資格、當期 Dashboard/Costs；帳號正餘額亦為官方前提。

## 8. 安全與隔離

- 上游 OpenAI Project Key 只存 Server 的 Secret Store/Keychain，不回傳客戶端；Admin Key 只給 Collector，與 Proxy 程序隔離。
- 客戶端使用獨立 Proxy access token，可撤銷；localhost 預設拒絕非本機來源。
- 禁止代理任意外部 URL、非 OpenAI host、redirect、通用 path proxy；限制 body size、連線數、並發數、速率。
- 防止 Header 注入：移除客戶端 `Authorization`、`OpenAI-Organization`、`OpenAI-Project` 等上游指定權限 Header，使用服務端固定值。
- Prompt/回應主體預設**不記錄**，只記 hash、token、結果、耗時、Provider、模型、狀態、trace ID；錯誤與崩潰報告需遮蔽憑證。
- 禁止 OpenAI Data Sharing 專案處理任何公司保密資訊、金鑰或個人敏感資料；Router 依 workspace policy 過濾。
- 建立 upstream 額外計費告警、極低付費保險絲（若平台支援硬性限制則開啟）；**保險絲不構成零費用保證**。

## 9. OMP Router 整合契約

- OMP 可把 Proxy 註冊成 `openai-datashare` Provider；API Base URL `http://127.0.0.1:8787/v1`。
- 需驗證 OMP 實際模型 ID、Responses/Chat Completions 相容性、工具 schema、串流解析；不直接假設所有 OMP 模型都可用。
- Router 收到 `FREE_QUOTA_EXHAUSTED`、`FREE_QUOTA_UNVERIFIED`、`MODEL_NOT_ELIGIBLE` 時，不得在同一 Data Sharing 群組盲目重試。
- Provider Fallback 只能在**沒有已完成副作用、可以安全重新執行**的任務邊界進行；已產生工具副作用/不確定請求須人工或 idempotent 恢復。
- 建議預設候選：一般低風險文字任務 Data Sharing economy -> Codex Plus -> Go；高階審查 Data Sharing premium -> Codex Plus -> Claude API（須 Credits 預算許可）。這是候選路由，不代表任務一定能用任一模型完成。
- Claude API Credits 另用 `PREPAID` 策略、單月成本上限；Go/Codex/Grok 使用 `SUBSCRIPTION` 策略。不能把它們的配額視為相同 Token 單位。
- Claude Code Max 繼續獨立；公司 Copilot 另隔離 Profile。

## 10. 錯誤、恢復與狀態機

```text
READY -> (admit) PENDING -> COMPLETED
                    -> UNKNOWN -> RECONCILED | MANUAL_REVIEW
READY -> (quota threshold) EXHAUSTED -> (UTC reset + verification) READY
READY -> (usage/eligibility uncertain) STALE | DATA_UNVERIFIED
STALE | DATA_UNVERIFIED -> (complete trusted observation) READY
ANY -> (operator hold) MANUAL_HOLD -> (audited review only) READY
```

- 程序重啟先掃描 PENDING，任何沒有可靠完成紀錄的 reservation 一律轉 UNKNOWN、保留 token。
- DB 損毀/磁碟滿、時鐘異常、Collector 停止、配額名單失效：health ready=false，禁止送出新請求。
- 不支援自動清空未知消費、重試所有失敗請求、無預估輸出上限的串流。跨日未決預留自動結轉新日同群組 `effective_used`（非清空）。

## 11. 設定檔（自訂 Quota Guard Schema，非 OMP 原生語法）

```yaml
server:
  host: 127.0.0.1
  port: 8787
  storage: ./data/quota-guard.sqlite
  failClosed: true

upstream:
  baseUrl: https://api.openai.com/v1
  projectId: ${OPENAI_PROJECT_ID}
  apiKeyEnv: OPENAI_API_KEY

usageCollector:
  adminKeyEnv: OPENAI_ADMIN_KEY
  intervalSeconds: 120
  requireHealthyAtStartup: true

policy:
  mode: FREE_ONLY
  safetyPct: 85
  externalSafetyReserve: { premium: 50000, economy: 200000 }
  proxyProjectDedicatedAttestedUntil: null # expiring manual attestation; null fails closed
  rejectHostedTools: true
  rejectUnknownModels: true
  rejectUnverifiedInputCounts: true
  rejectUnknownOutcomes: true
  forbidTransparentRetries: true
  resetTimezone: UTC

quotas:
  premium:
    dailyTokens: 1000000
    safetyPct: 85
    models: []
  economy:
    dailyTokens: 10000000
    safetyPct: 85
    models: []

limits:
  maxOutputTokens: 4096
  maxConcurrentRequests: 4
  maxRequestBytes: 2097152
  maxClockSkewSeconds: 5
```

Model Allowlist 必須由部署程序顯式審核填入，不能在原始碼內默認自動將「新 GPT 模型」映射成免費群組。`120s` 是 Collector 執行間隔，不代表官方帳務延遲保證。

## 12. 驗收測試（全部自動化、無需先產生實際計費）

1. premium=1M / 85%：累計與預留合計 850000 時，新請求被拒絕。
2. economy=10M / 85%：超過 8.5M 時被拒絕。
3. 兩個 Agent 同時競爭最後 50K 配額，最多一個成功預留，不允許雙放行。
4. 單筆 `input + forced max output + margin` 超過剩餘配額，送出前拒絕，上游呼叫次數 0。
5. 完整 SSE 與 JSON 使用量相同；正確結算 input + output（含 hidden reasoning）。
6. 使用者中途斷開串流：不釋放尚未確定的預留。
7. Upstream timeout / HTTP connection reset：UNKNOWN，無透明重試。
8. Client 使用同一 idempotency key 重試：不產生重複上游呼叫。
9. Admin Usage API 無法使用/延遲/回傳不完整分頁：Fail Closed。
10. 官方 usage watermark 回退：拒絕採信，不使 remaining 增加。
11. 午夜前 1 分鐘開始、跨 UTC 00:00 結束：舊請求不遺失，隔日准入不會錯誤釋放。
12. Restart、SQLite busy、磁碟滿、SQLite 壞檔：不會在不確定狀態下放行。
13. Unknown/alias model、非優惠功能、Hosted Tools、付費工具：上游呼叫次數 0。
14. Chat `n>1`、無輸出上限、不可信 token count：拒絕。
15. 資料分享資格撤銷、專案設定變動：停止所有免費路由。
16. 沒有 Proxy Token、非本機來源、header spoofing、任意 upstream path：拒絕。
17. OMP 收到本地 429/503：切到**獨立 Provider**，不在 OpenAI Data Sharing 群組內循環重試。
18. 其他 Org 專案有旁路流量時：正確記錄為外部 scope 並收緊准入；白名單外已知模型正確分組、未知模型同時計入雙群組保守上界並留診斷；collector 不得停止或報 invariant 錯誤。路由專案可與其他服務共用：proxy-scope 超量以保守加項吸收，不設 tripwire、不低估放行。跨日未決預留（PENDING/UNKNOWN/MANUAL_REVIEW）自動全額結轉新日同群組 `effective_used`，不阻擋 admit，歷史與冪等保留。
19. 透過測試帳務/人工 Dashboard 校對，確認免費標記與 Costs 沒有不預期項目；不能將 mock 成功誤當真實帳務保證。
20. 進行故障注入測試：所有不確定狀態均有可追蹤的拒絕原因與恢復操作。

## 13. 實作階段

**P0 — Quota Guard MVP（必做）**
- Fastify Proxy、精確 Model Allowlist、Text-only 受支援請求、Ledger 原子預留、輸出上限、完整 Usage 結算、429/503、SSE、Fail Closed、Admin Usage Collector、CLI `/quota`。
- 先在 `dry-run` 使用 Mock OpenAI 與模擬 Usage；再用少量真實請求核對 Dashboard/Costs，通過後才開放主要流量。

**P1 — OMP 協作（P0 安全驗證完成後）**
- OpenAI-compatible Provider、OMP Extension 依錯誤碼切換獨立 Provider、工作區 Data Policy、端到端配額觀測與成本告警。

**P2 — 多模型與進階能力**
- 經帳務驗證的 function calling、Codex/Go/Grok 額度 Collector、Claude Credits 月度政策、Router 的能力匹配/公平使用。

**交付物**：`SPEC.md`、`README.md`、`src/`、`migrations/`、`tests/unit`、`tests/integration`、`tests/fault-injection`、`.env.example`、`config.example.yml`、`docs/security.md`、`docs/runbook.md`、一個展示 OMP Fallback 的端到端 Demo。

## 14. 上線 Go / No-Go 條件

- Data Sharing enrollment 與實際優惠模型清單已驗證；每個群組上限正確。
- API Token 估算在所有已允許請求形態上都有可信上界；不支援者會拒絕。
- 無不受控且未設上界的同 Org 旁路流量（外部消耗需有 `externalSafetyReserve` 保守上界），路由專案可與其他服務共用（保守計算吸收），或已明確停用 FREE_ONLY 生產保證。
- 20 項測試通過；實際 Dashboard/Costs 對帳完成；未知結果會留在 ledger 而非被釋放。
- 沒有 admin/upstream secret 洩漏；任何限制失效會 Fail Closed。
- 文件明示 **「最小化意外扣款風險」，不承諾由 Proxy 單方面保證 OpenAI 帳戶零費用**。
