# 單步記憶體修正與限額判斷

Owner最新要求「then extend the limit? and do 需找出並降低單步記憶體峰值」。先修正真實分配路徑，不將詢問視為任意RAM／swap數值授權；本次上限不增加。

## 原因與改動

Pinned MLX0.32.2 Metal SDPA在training tracing使用unfused路徑，VJP也fallback；Qwen3-8B有32Q heads／8KV heads。padded輸入3648 positions的完整attention score含425,852,928元素，单float32矩陣約1.59GiB（只是shape算術，不是實測gradient peak）。同時減少trainable layers不保證消除每層此峰值。

官方對應版本程式：[Metal選路](https://github.com/ml-explore/mlx/blob/v0.32.2/mlx/backend/metal/scaled_dot_product_attention.cpp)、[fallback分配](https://github.com/ml-explore/mlx/blob/v0.32.2/mlx/fast.cpp)。本地版本與Qwen實作已核對，未升級套件。

實作opt-in frozen-prefix-query128：凍結的34層在AD外逐層eval／釋放cache，保留train模式、5%LoRA dropout及RNG消耗；拒絕任何prefix／embedding／head／norm可訓練參數。尾部2層用128query分塊與checkpoint重算，每塊保留所有causal K/V且其梯度累加，不截斷來源或stop-gradient。validation/generation使用原路徑，context manager只在梯度計算期間替換Qwen3 attention呼叫，退出即恢復。

小型CPU參考驗證：三種含非整除chunk長度、GQA輸出及Q/K/V梯度、完整小Qwen的loss／梯度／兩個Adam更新、5%dropout後RNG一致；atol2e-5/rtol2e-4。最初檢查誤用Dropout.p產生AttributeError，已按pinned實作改正後加入實際dropout，保留失敗測試收據。不是8B證明。

獨立Metal attention微測試（不載入模型、sequence512／8Q heads／2KV heads／dim64／querychunk64）：原峰值35,934,764bytes，分塊29,655,680bytes（約17.5%下降），兩者objective7337.0439453125。這不是full-model峰值，且正式實驗chunk128不能冒稱相同節省率。

## 本輪有限執行

在使用者降低單步峰值的執行要求下，最多一個新changed-code proof，root checkpointed-v8-bounded-memory-proof；兩個disposable updates、原V8雙審32PASS、完整3625/max3680、parent19、2trainable layers、原Adam／loss／dropout。保留舊兩次失敗；新attempt失敗不自動再跑。

所有上限保持：prestart6144MiB、absolute8192MiB、growth2048MiB、free10%、footprint12GiB、MLX14GB；proof1800秒，compile_and_update150秒含frozen-prefix和尾段（prefix進度不重設deadline）。完整RNG／optimizer／sampler保存恢復、8例validation及normal-stop generation仍必需。

只有新matching proof通過，才可啟動原未執行main12，總主工作30→最多42、lineage19→最多31；不是新增另一個12budget。比較與browser/formal門檻不變。

## 是否增加上限

兩層前輪在2793.81MiB增量時free19%、footprint7.326GiB，故2048增量guard是當次直接停機點，但完整gradient峰值未知。3072MiB僅比已見2793.81多278.19MiB，不能從截斷trace證明足夠。若放到4096MiB，額外允許2GiB全機換頁，且仍可能觸發absolute8192／free10／150秒限制；這是風險／延遲取捨，不是memory修復。先取得上述不同實作的實測，不以加大至通過作策略。本文件不授權提高OS wired memory或其他全機設定。
