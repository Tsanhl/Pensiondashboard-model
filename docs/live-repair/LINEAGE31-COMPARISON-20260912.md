# 三版本比較：完成，有改善但未達替換標準

## 結果

24/24 本地生成、三版本各8筆完整 loss、6/6 隔離 reviewer 呼叫全部完成；沒有新增梯度或重試。模型 child、supervisor 和 reviewer 已退出，服務3001／8080／8090仍 offline。

| 版本 | 雙評核通過 | Loss | 截斷 | 重大遺漏計數 | 不必要提問計數 |
| --- | --- | --- | --- | --- | --- |
| baseline104 | 1/8 | 1.2275672090 | 3/8 | 4 | 5 |
| parent19 | 2/8 | 1.1127172091 | 0/8 | 3 | 0 |
| 新 lineage31 | 5/8 | 1.0706597362 | 0/8 | 3 | 0 |

計數按每題兩名 reviewer 的較大值合計，並非獨立錯誤機率。新候選通過001、002、004、005、007，涵蓋本輪前兩版本已通過的題目；但這只有8個可見合成驗證題，不能宣稱法律／產品已修好。原3/8、6/8等不同格式的歷史比較保持分開。

新候選尚未通過：

- **003（兩名 reviewer 均指出硬性問題）**：原文僅允許「三月且先前自願退出」時重加入，月份與退出原因均未知。回答卻以 `No` 開頭，之後才列缺失資料。應明確說不能判定，而非作出否定結論。
- **006（兩名 reviewer 均指出硬性問題）**：已正確說明提名是偏好、管理人決定受益人，但又稱適用條款缺失；來源已提供相關條款。A另指出漏掉具體提名的是 sibling。
- **008（完整性不足）**：A給94/PARTIAL，因回答只提掃描／OCR檢查，漏掉原文明示「沒有人工確認」；B給PASS。沒有用多數或降低95分門檻解除分歧。

選擇程式結果：`NO_FULLY_ASSESSED_HARD_GATE_CLEAN_CANDIDATE`，selected=null。正式 baseline104 保留原樣，並不表示它已合格。新候選較少截斷、同題通過數提升，但**不能替換正式模型**。

模型階段665個監測樣本，最高 swap 增長1969MiB／absolute6614.25MiB、最低free18%、最高footprint5.8064GiB、MLX5.9628GB；在既定護欄內正常exit0。六次 reviewer 均exit0、tool events0，單次約92–197秒，沒有提高任何本輪限額。執行後 idle snapshot：swap5453.44MiB、free70%。系統swap不是程序獨佔記憶體，生成速度差異也不能單獨當作訓練加速的因果證據。

[結果收據](/Users/hltsang/.codex/private/pension-adaptability/20260912/lineage31-comparison-v1/result.json)；[逐題 reviewer 結果](/Users/hltsang/.codex/private/pension-adaptability/20260912/lineage31-comparison-v1/review-segment12_lineage31/development-answer-review.json)；[獨立檔案／身分核對](/Users/hltsang/.codex/private/pension-adaptability/20260912/lineage31-comparison-v1/independent-artifact-audit.json)。核對全部 bound inputs、24份原始回答、8題跨版本相同prompt hashes、6份 reviewer 收據及固定 selection controls，全部有效。Controls是有限開發檢查，不是正式16題校準或專業認證。

下一個最小工作是修正這三種共通行為並做有限對照測試，不是再跑滿任意訓練次數、硬編碼驗證答案、降低品質門檻或把validation搬入training。PDU50來源／案例準備、真實瀏覽器驗收、正式qualification仍未完成；sealed unseen未接觸。沒有commit、push、deploy或模型替換。

## 啟動時的執行範圍（歷史）

本輪執行 owner 已要求的下一步，不新增梯度。從已完成主段的完整 checkpoint 讀取權重，保留正式 checkpoint104。2026-09-12 16:06:36 UTC 啟動；結果未完成前不可選用候選。

固定範圍是 baseline104、parent19、segment12_lineage31 各 8 個生成回答、各一輪完整 8 筆 teacher-forced validation，最多 24 個生成、6 次 reviewer 呼叫。三份 adapter 逐一載入同一份 Qwen3-8B base。temperature0.1、seed42、最大320生成tokens；無 best-of 或自動重試。

這 8 題均為可見的虛構方案／紀錄驗證題，用於來源支持、條件、缺失資料與確認狀態診斷，不是實際法律權威題、正常檢索、PDU50、瀏覽器或 sealed unseen。只將原始來源及問題送入生成；target 留在 teacher-forced loss 路徑，reviewer 不獲得 target 或另一名 reviewer 結論。

既有選擇程式在啟動前已綁定：完整身分／評核及所有 hard gates 優先；語意完整性、重大遺漏、不必要提問優先於 loss；1% loss tie 優先較少更新。任一重大來源矛盾不能被平均分抵銷。每批 reviewer 另有兩個固定 selection-count controls，它們不算入候選的8題。

現有兩個獨立隔離 reviewer 為 gpt-5.6-sol／gpt-5.6-terra，各 high，使用已許可的 CLI transport；每次300秒、每批最多10項（8個回答+2個controls）。模型階段總上限3600秒；swap growth2048MiB／absolute8192MiB／prestart6144MiB、free10%、footprint12GiB、MLX14GB不變。

[Frozen plan](/Users/hltsang/.codex/private/pension-adaptability/20260912/lineage31-comparison-v1/plan.json) SHA256：`8a9a310493e8a29d39fbd17d82a7582641e43659e979d42ed7d4028ef41b8c71`。

[Ownership](/Users/hltsang/.codex/private/pension-adaptability/20260912/lineage31-comparison-v1/ownership.json)；[監測曲線](/Users/hltsang/.codex/private/pension-adaptability/20260912/lineage31-comparison-v1/metrics.jsonl)。續作先查這個 run，不另開同一比較或重做訓練。
