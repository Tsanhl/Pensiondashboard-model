# Pension Dashboard v3 — 使用說明

## 這個包已經完成甚麼？

已修訂完整 Codex 合約，建立50個情境、10個跟進訊息及對應的虛構資料／文件／評分要求。這不是本機Pension Dashboard的已執行測試；沒有在此啟動你的Mac、兩個DB、Qwen、reviewers或訓練程序。

`48`現在是首輪有界比較的上限／比較點，不是必須選用的最佳步數。建議一條訓練軌跡保存0/12/24/36/48的版本，先用既有validation選擇，再以50題做產品比較。0表示以checkpoint104為基準沒有新增更新，不是另一個模型。若現有權限/資源不容許新增保存及評估工作，Codex須列出具體差異，不能擅自執行。

## 交給Codex

把整個包交給原本的Codex專案，貼`START_CODEX.txt`。完整指令在`Pension_Dashboard_Full_Execution_Contract_v3.txt`，不要只交問題列表。`CHANGELOG_v3.md`解釋相對原v2的改動。不要把大型合約全部塞進AGENTS.md；保存全文並明確讀取，以簡短指引連接。

## 50題的用途與資料分工

- `PDU50_Questions.md`：供你預覽的英文真實使用問法，共50主題＋10跟進。
- `evaluation/pdu50/product_messages.jsonl`：只包含訊息，正常產品實際接收的就是這些文字。
- `evaluation/pdu50/harness_setup.jsonl`：執行器專用fixture和使用者切換／資料變更安排；不能放進模型。
- `fixtures/synthetic_portfolios.json`：26份虛構fixture規格及少量受控變更；由Codex映射到真正的DB schema，在隔離開發副本種入，不是原生DB匯入腳本。
- `evaluation/pdu50/evaluator_manifest.jsonl`、`Evaluator_Guide.md`：評分者專用的draft接受條件，不是模型提示或已批准訓練答案。
- `official_source_catalog.json`：24個官方來源起點，清楚區分已讀／只搜索／尚待查核的種子。不是已admit的法律證據。
- `numeric_reference.json`：只適用於精確matching的虛構投影假設；不是用戶預測，不能直接交模型冒充計算。
- `policy/`：48步比較規則及新50題使用／訓練迴圈規則。

## 來源及評分仍需甚麼？

法例數值、地域及生效日必須經本機正常source admission與獨立審查後才成為可評分依據。這個包中的法律接受條件是draft，不保證就是完整或唯一正确答案。fixture寫VERIFIED_RECORD代表測試中已核對的虛構紀錄，絕不表示真實機構或實際用戶已被查證。

不同案例會刻意提供未知、衝突或已過時內容；不能要求所有案例有肯定法律結論。對可回答問題不必要拒答仍算失敗。Source/label尚未建好的case要列CASE_NOT_READY，而不是偷偷刪除或算模型答錯。原既有五題失敗仍要處理，新50題不取代原Live-50。

## 評估與訓練分離

目前24 training＋8 validation保持原本角色。PDU50是可見開發比較，預設不入gradient training，不作逐checkpoint選擇。50題的失敗可用來定位原因；只有確實是模型行為，才另製有lineage的不同情境教材、review並批准新訓練。再次測原題只能稱regression/development，不能稱新的unseen。既有sealed unseen完全不讀、不改、不執行。

50情境每個候選跑60個user turns；baseline＋一個選定candidate是120 turns，另加實際planner/reviewer呼叫及允許重試。因此不是50次模型呼叫。所有完整重跑須有明確預算與候選變更證據。

## 如何知道兩個DB和模型路由真的通？

必須看到：真實伺服器身份 → 兩個實際資料角色與版本 → query返回的正確紀錄 → 檢索原文span → 真正送入模型的context → 原始回答 → 兩名reviewer執行收據 → 網頁／history／citation drawer。連線成功或把fixture整包貼到prompt，都不能證明整條流程通過。

## 本包自檢

在解壓目錄執行：`python3 tools/validate_pack.py`。
只檢查JSON/ID/對應資料/基本數學/檔案integrity；不會使用網絡、修改DB、執行模型或消耗訓練額度。`PACK_CHECK_REPORT.json`的通過只代表包的結構自檢通過，不是產品PASS。

## 未授權的事

沒有批准提高swap/RAM/時間上限、移除guard、重置已用完probe、使用新雲端服務、推送Git、部署或讀取sealed unseen。以原有精確且未耗盡的有效授權為準。
