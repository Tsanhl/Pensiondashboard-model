# 兩層實測結果：未通過，不啟動主段

最新 owner 指示後確實執行一個新配置診斷，不是僅準備計畫。私有根目錄：`/Users/hltsang/.codex/private/pension-adaptability/20260912/checkpointed-v8-two-layer-proof`。

啟動時間2026-09-12T14:57:26.529Z；supervisor7670／child7683。45.154秒後因SWAP_GROWTH_LIMIT終止，SIGTERM，兩程序已確認不存在。一次額度已消耗，不自動重試。0 completed updates；沒有checkpoint、verify、main或新candidate comparison。

| 實測指標 | 四層（前輪） | 兩層（本輪） |
| --- | ---: | ---: |
| 起始 system swap MiB | 3464.56 | 3818.19 |
| 最高 swap 增長 MiB，上限2048 | 3182.13 | 2793.81 |
| 最低 free %，下限10 | 9 | 19 |
| 最高 sampled process footprint GiB | 8.993 | 7.326 |
| 已完成 updates | 0 | 0 |

兩次host baseline不同，不能把差異當成受控記憶體節省率。兩層讀值較低但仍不符合2048MiB增量限制；尚未證明此完整3625-token配置可行。9次必要metrics均成功，末次system swapout約363.53MiB/s，屬全機指標，不能全部歸因本程序。最後event的MLX peak4.6466GB發生在梯度前，完整gradient peak未知，不可報成訓練峰值。

程式只將trainable layer選擇顯式綁定為2或4，維持全224-tensor父adapter與其餘凍結參數、loss、完整V8資料、max3680、RNG／sampler恢復和所有resource guards。舊四層code快照已保留；新實測也封存14個bound code檔。沒有調高cap、縮短來源、切換模型或停止其他app。

歷史主工作仍30，durable lineage19，baseline104未替換。單純減少層數尚不足；再啟動前需要不同且經小型正確性驗證的單步記憶體改善，不是重跑同一設定。PDU50／browser／formal qualification仍未完成，sealed unseen未接觸。

安全development完整套件281PASS／0FAIL，收據`/var/folders/sm/6g7jmw3x43b5r6rjcw1fnbr00000gn/T/pension-development-tests-dFAe8o/result.json`。14:59:18Z再次確認無training／model程序、3001／8080／8090無listener，swap6027.88MiB。git diff --check通過；沒有commit／push／deploy。
