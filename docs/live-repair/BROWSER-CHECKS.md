# Development browser evidence

## 2026-09-09 實際重測

完整baseline104 Chrome matrix：**17PASS／4FAIL，共21個scenario，exit1**。新增「第二輪提供方案、地區及變更事實」情境亦失敗。Q2–Q6正常流程、空白使用者、引用開啟及明確命名的fault injection／recovery案例通過；它們不是17條正確模型法律答案。

修正一般動詞變化的法律路由與只追問缺失事實的提示後，以同一104權重重新啟動，獨立`serving-repair` group：**0PASS／4FAIL，exit1，matrix_completed=true**。Q1、改寫、非demo及補充事實對話仍未通過。沒有降低驗證gate或把安全fallback算成答對。

- 完整matrix：`/Users/hltsang/.codex/private/pension-live-repair/20260909/browser-restored-baseline/receipt.json`
- 修正後matrix：`/Users/hltsang/.codex/private/pension-live-repair/20260909/browser-routing-fix/receipt.json`
- 每個目錄保留逐case PNG、Playwright ZIP、request IDs、exact displayed text及timing。已實際檢視Q1畫面。
- 模型輸入、raw output、token/stop reason和validator結果：`/Users/hltsang/.codex/private/pension-live-repair/20260909/routing-fix-traces/`
- 前端HTTP bytes與本地app.js一致，212份來源／20筆structured facts、private development.sqlite及不變104 identity已核對；最後模型ready且idle。`final-runtime-reconciliation.json`位於同一日期的私人root。

**BROWSER_ACCEPTANCE=FAIL；OWNER_TEST_STATUS=NOT_READY。** 以下9月8日matrix保留為歷史證據。

Real Chrome, actual local frontend/backend, isolated sample and empty profiles. Artifacts: `/Users/hltsang/.codex/private/pension-live-repair/20260908/browser-delivery-all/` (receipt JSON, per-case screenshot PNG and Playwright trace ZIP). Result: **17 PASS, 3 FAIL; exit 1**. Legal-answer failures remain failures even when safe rejection works.

| Case | Result | Observation |
|---|---|---|
| healthy-ws-Q2-Q6 | PASS | Expected terminal state and recovery verified |
| healthy-http-empty-profile | PASS | Expected terminal state and recovery verified |
| Q1-live | FAIL | Legal answer prerequisite remains unmet |
| Q1-paraphrase | FAIL | Legal answer prerequisite remains unmet |
| Q1-non-demo | FAIL | Legal answer prerequisite remains unmet |
| live-model-cancel-and-next-request | PASS | Expected terminal state and recovery verified |
| model-paused-ws | PASS | Expected terminal state and recovery verified |
| retrieval-paused-http | PASS | Expected terminal state and recovery verified |
| http-401-recovery | PASS | Expected terminal state and recovery verified |
| http-403-recovery | PASS | Expected terminal state and recovery verified |
| http-429-recovery | PASS | Expected terminal state and recovery verified |
| http-500-recovery | PASS | Expected terminal state and recovery verified |
| http-200-recovery | PASS | Expected terminal state and recovery verified |
| manual-retry-reconciles-accepted-request | PASS | Expected terminal state and recovery verified |
| history-sync-failure-preserves-answer | PASS | Expected terminal state and recovery verified |
| ws-drop-before-accept | PASS | Expected terminal state and recovery verified |
| ws-drop-after-accept | PASS | Expected terminal state and recovery verified |
| ws-malformed | PASS | Expected terminal state and recovery verified |
| ws-missing-terminal | PASS | Expected terminal state and recovery verified |
| cancel-new-chat-profile-separation | PASS | Expected terminal state and recovery verified |

Healthy Q2–Q6 and empty-profile checks use real application replies. Q2 source opening reached the official TPR page with HTTP 200; source passage expansion and refresh were verified. Q5/Q6 are local contextual clarifications, so the healthy reload asserts the three persisted server exchanges and no regeneration; those two local-only clarification bubbles are not durable server history.

HTTP/WS fault cases deliberately inject malformed/status/frame/history failures and verify the visible terminal state and a subsequent healthy request. Manual retry loses an already accepted HTTP response, then reuses the same logical request ID; the server returns the saved result and the UI retains one user message. The missing-terminal test advances the browser clock past its declared deadline; it is not a measured healthy-model latency.

Dependency tests pause only verified owned service PIDs, verify their health request cannot finish, serve Q2 and a paraphrase, then resume in finally and send a healthy next request. The model cancellation test waits for actual model busy state, cancels, verifies the next deterministic response, waits for the owned model to settle, and checks that history preserves the cancellation.

Known limits: development coverage is finite. It is not the formal reliability gate (15 sequential, four concurrent, five journeys and its own signed outage/cancellation receipts), reviewer calibration or universal concurrency proof. Earlier failed harness/product checks are retained in the private evidence directory and the previous matrix is under `history/`.
