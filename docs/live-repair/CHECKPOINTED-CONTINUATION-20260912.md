# V7 資料修正與完整狀態續跑

依據本 task 的訓練修正授權及最新「yes continue」繼續，不重設舊失敗收據或主更新數。這是準備／執行契約，結果以 STATUS.json 及私有收據為準。

## 有限範圍

- 只修正 v6 的 train009：保留原來源、題目、其餘31列及 validation；補齊原文的前置檢查與 qualifying earnings 選項。新 v7 最多兩個既有隔離 reviewer 呼叫，不自動直到通過。
- V7 實際結果 A31PASS/1HOLD、B32PASS；train009 兩方均接受，但 A 指出 train008 只列例外條件、未說明免除本條再次諮詢的效果。已核對原 regulation6(3)/(5)，允許本輪最後一個 source-checked v8 單筆修正與兩次 review（本輪資料審查合計上限4次）。保留 V7 HOLD；再有 HOLD 即停止本輪資料修正，不遷移 validation 到 training 或降低標準。
- 24 training／8 validation 不變；validation 不進入梯度。PDU50、正式題目及 sealed unseen 不加入本流程。
- 完整輸入最長3625 tokens；新上限3680。這是序列工作量變更，不是增加 RAM／swap 上限，不能沿用3292-token 診斷充當新證據。
- 新診斷最多一次、兩個 disposable 更新；同一程式、四個 trainable layers、Adam1e-5、batch1／accumulation1，最長與另一 padded shape，各一次，然後新程序完整8例 validation 及正常停止 generation。
- 診斷成功及資料雙審通過後，最多一次12更新主段；每步保存完整 adapter、optimizer、MLX／Python／NumPy RNG、資料 permutation／cursor／epoch，再由新程序恢復。模型一次只載一份。
- 從已保存的 lineage19 權重開始，首步明確重置 Adam：舊檔缺少 RNG/order，且資料版本已改，不能假稱接回旧 stochastic trajectory。新主段內部才是完整狀態續跑。原104及lineage19均保留。
- 歷史主更新30；新段最多12，總實際工作最多42（低於原48 cap），新分支權重 lineage最多31。不是必須跑完「剩17」，也不是原0/12/24/36/48完整研究。

## 保護與時限

prestart swap6144MiB、absolute8192MiB、growth2048MiB、free10%、process footprint12GiB、MLXpeak14decimalGB 均不變。診斷總1800秒；主段總7200秒；各程序 load90秒、compile/update150秒、save45秒、full-validation180秒、generation90秒。階段與總期限由 supervisor 檢查，不依賴模型持續輸出。只清理自己建立的 process group，未清理的後代使此次失敗。資源停機／未知必要 metrics／非正常退出不會自動重啟。

同一段 attempt.json 不重用。每個 checkpoint 的 complete.json 另由上一階段收據 SHA 綁定，恢復前驗證。主段啟動須比對新診斷的完整資料、模型、code、optimizer 及序列 workload identity；不同資料或程式不能套用舊 PASS。

## 效果比較與後續

預先鎖定 baseline104、parent19、成功完成的新段12（lineage31），最多24次 validation generation、6次既有隔離 reviewer 呼叫，不 best-of、不換 reviewer。使用 v7 的完整 inference messages，移除最後的 assistant target；temperature0.1、max320，保留 literal /no_think。每個候選另做完整8例 teacher-forced loss。這仍是 supplied-evidence validation，不是 retrieval／transport／browser acceptance。

先檢查 identity、完整 adapter、引用／事實／範圍等 hard gates；再比較雙審正確完整數、遺漏及多餘追問，loss僅次要且1%內平手偏好較少更新。不因最後一步較新便選用；不自動推廣至正式模型。若主段因資源停機，保留 checkpoint 但本輪不把未完成預定候選冒充已完成比較。

新流程接在既有 `continueAdaptabilityStudy.mjs --checkpointed <prepared-main-root>`，共用已驗證的完整狀態 helper／resource telemetry。PDU50來源與case readiness、真實瀏覽器及正式qualification是後續獨立門檻，不能由本文件、資料雙審或診斷PASS取代。
