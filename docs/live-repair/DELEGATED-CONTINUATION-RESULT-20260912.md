# 12 September：自主限額調整與主訓練完成

最新 owner 已委託代理自行作有實測依據、有限額的訓練／驗證資源調整，不再反覆要求相同授權。執行依據為 [委託紀錄](RESOURCE-ADJUSTMENT-DELEGATION-20260912.md)。品質門檻不變，沒有以提高上限掩蓋資源失控。

## 實際完成

- 原兩步 proof 的 180 秒驗證逾時紀錄保留不變。另一次只讀 saved checkpoint 的補驗使用 300 秒驗證／480 秒總上限：新增梯度 **0**，完整 8 筆驗證、正常停止生成及重新載入均完成，333.158 秒，loss 1.10652219729686。
- 補驗實測完整 validation 約 280 秒，因此在主段啟動前記錄 effective validation watchdog **420 秒**。底層原 plan 保持原 bytes；`delegated-control.json` 明列原值、有效值、原／執行 supervisor hashes 及相容性理由。
- 主段 **12/12 optimizer updates** 全部保存，每一步保存並於下一個新程序恢復 adapter、optimizer、MLX/Python/NumPy RNG 和 sampler 狀態；12 步及最後 verify 共 13 個 phase 全部 exit0。
- 主段完整 8 筆 validation 有限，loss **1.0706597361542762**；生成正常 `stop`；总耗時 **1008.041 秒**。這不是 8/8 語意正確，也不是 browser 或 qualification PASS。
- 歷史主訓練實際工作 30 加本段 12，合計 **42**；保存權重 lineage 19 加 12，為 **31**。舊遺失更新不能算進權重 lineage。從 legacy19 開始的 optimizer reset 明確記錄；本段內才是完整狀態續跑。

## 記憶體結果

主段 195 個監測樣本，必要 probes 全部有效：最高 swap 增長 **510.69 MiB**、最高 swap **5437.25 MiB**、最低 free **16%**、最高 process footprint **7.0195 GiB**、最高 MLX **8.0442 GB**（核對完整 event log，而非只有先前進度樣本）。

原護欄維持：swap 增長 2048 MiB、absolute 8192 MiB、prestart 6144 MiB、free 10%、footprint 12 GiB、MLX 14 GB。**本次沒有提高 swap 上限。** 實際改善來自 frozen-prefix 逐層 materialize／釋放，以及 query128 checkpointed full-causal attention；沒有截斷來源上下文或刪除品質檢查。不同長度樣本的峰值不能當作同樣工作量的百分比降幅。

## 收據與保留邊界

- [補驗 result](/Users/hltsang/.codex/private/pension-adaptability/20260912/bounded-memory-verification-300/result.json)
- [主段 result](/Users/hltsang/.codex/private/pension-adaptability/20260912/checkpointed-v8-bounded-memory-main/result.json)
- [有效控制紀錄](/Users/hltsang/.codex/private/pension-adaptability/20260912/checkpointed-v8-bounded-memory-main/delegated-control.json)
- [保存的第 12 步](/Users/hltsang/.codex/private/pension-adaptability/20260912/checkpointed-v8-bounded-memory-main/checkpoints/12/complete.json)
- [安全開發測試 285 PASS、0 FAIL](/var/folders/sm/6g7jmw3x43b5r6rjcw1fnbr00000gn/T/pension-development-tests-5aqLEa/result.json)

第12步 adapter SHA256：`140879a7499577e87783158e2e9b419c1f81856662f57a754ef918031f420cb6`；state SHA256：`cb7b8d60e642e291f4588b92d98ea899312d117f612c3edca9b89203c1906b63`。全部12個 checkpoint 權重、state 和 metadata hashes 已重新核對。

程序已退出，3001／8080／8090 無 listener。沒有選用或替換正式 adapter，checkpoint104 原樣保留；沒有 sealed unseen、commit、push 或 deploy。新增控制與補驗 regression tests 已納入既有安全開發入口；不是正式 qualification。

下一個實質工作是 baseline104／parent19／新 lineage31 同輸入語意比較，檢查來源矛盾與明確不足結論；接著處理 PDU50 來源／案例準備與真實瀏覽器驗收。新候選尚未完成此比較，不宣稱法律回答修好，也不繼續湊滿舊「剩17次」。
