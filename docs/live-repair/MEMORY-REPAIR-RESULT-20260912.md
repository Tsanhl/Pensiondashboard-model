# 單步記憶體已改善；完整驗證仍待補齊

本輪依owner「then extend the limit? and do 需找出並降低單步記憶體峰值」實作並執行，不只提出建議。上限沒有增加。原104、lineage19、V8資料、來源及sealed邊界不變。

## 實測

私有收據根：`/Users/hltsang/.codex/private/pension-adaptability/20260912/checkpointed-v8-bounded-memory-proof`，workload SHA `d9701fb5e5592eaabe3b0dfa9f34441a71a52aef7673018c21ccb3b6ed789c44`。兩個gradient程序均exit0，第三個verification程序因STAGE_TIMEOUT_full_validation收到SIGTERM。總277.287秒。

- 兩個完整更新已同步完成並保存，輸入3625及3613tokens；finite gradients，非訓練adapter tensors保持不變。
- 後一更新從前一checkpoint恢復adapter／optimizer／MLX/Python/NumPy RNG／sampler。
- MLX整段觀察峰值7.993175162decimalGB，sampled footprint6.9964GiB；54次必要probes全部有效。
- system swap起始5043.31MiB，最高5622.19，增長578.88（上限2048）；最低free18%（下限10）。無memory guard crossing。
- 8例validation只完成6例，單例24.47–31.27秒，180秒後停止；未執行generation。不能宣稱完整proof PASS，也未啟動main12或效果比較。
- 已保存checkpoint2 adapter SHA `5cd1d4472d59b19bbc37521ab54d0e0e757042f9884373f05cde2cd4c7734592`；state SHA `3c20a1adf024b4c806a7b3c06ee66d8b68a2dd7e4e18e4b5578ba7d88468ffd7`。這是disposable，不是主更新或正式模型。

前兩層舊實作swap增長2793.81MiB即停，未完成梯度；新實作在不同host baseline下完成兩步。這支持本配置有限可行性與資源改善，但不能報成受控百分比節省，或聲稱所有主訓練均能成功。

## 已改與測試

`ml/adaptability_memory.py`隔離frozen prefix計算與尾段AD，分塊query保留完整causal K/V及梯度。模型權重、精度、dropout／RNG、loss和資料未變。原validation／generation路徑不替換。

Pinned Metal訓練attention fallback的官方證據：[MLX0.32.2實作](https://github.com/ml-explore/mlx/blob/v0.32.2/mlx/backend/metal/scaled_dot_product_attention.cpp)。對應prefix受training tracing影響是此次程式分析；全機swap不能唯一歸因單一operation。

小型Metal benchmark原35,934,764bytes／分塊29,655,680bytes（sequence512、8Q/2KV、chunk64、相同objective），不是8B測量。CPU測試比對GQA輸出及梯度、兩步Adam、dropout0.05與RNG；安全development套件283PASS／0FAIL，收據`/var/folders/sm/6g7jmw3x43b5r6rjcw1fnbr00000gn/T/pension-development-tests-rHRFtv/result.json`。測試不能替代未完成的8例驗證／browser／qualification。

15:14:17Z確認無owned training/model程序，system swap5342.56MiB。無commit、push、deploy或model promotion。

## 精確限額建議：只補驗，不重訓

不建議現在加大swap：此實作已低於原限額。真正新阻塞是完整validation時間估計不足。按已測六例最慢31.27秒，8例約250秒，因此建議full_validation **180→300秒**，其他階段load90/restored30/generation90/complete30及所有memory/swap限制不變。

待owner確認：一個獨立、最多480秒的verification-only invocation，重載以上exact checkpoint2，完整8例validation＋一次max192正常停止generation，**0個新增gradient update**。保留原180秒失敗收據，使用新manifest／收據綁定來源checkpoint／old-code快照與延長時限，不能改原result為PASS、重新消耗兩步或混用不同candidate。完整證明成立後才進原本條件授權的main12；不新增另一段12、不自動推廣。

同意此精確調整前，不更改active guard、不啟動補驗或主段；這不是缺少一般訓練授權，而是對新驗證時限的單一具體決定。
