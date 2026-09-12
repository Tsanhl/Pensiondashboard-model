# 兩層、完整 V8 輸入的有限資源診斷

依據 owner 最新「yes do it and current training is running?」，執行上一輪提出的較低單步記憶體配置。這不是重設四層失敗的 attempt。舊契約、收據、104、lineage19 保留。

唯一模型配置改動：最後 4 個 trainable layers 改為最後 2 個，56 個 trainable LoRA tensors 改為 28 個。完整 224-tensor adapter 仍載入／保存，其餘權重凍結。未改 base、rank、精度、Adam1e-5、seed42、batch1、accumulation1、target loss、完整來源或任何 target。

假設：縮短參數梯度所需的尾部路徑可降低 activation／gradient 工作集；optimizer 狀態亦減少，但不能據此保證足夠節省 GB 級記憶體。Pinned mlx-lm 的 grad_checkpoint 修改同類所有 layer 的 __call__，原程式並非只對第一層啟用 checkpointing。保留該實作，不加入 detach 或裁剪 evidence。

本輪最多一個新 full-model proof attempt、兩個 disposable 更新，使用 V8 雙32PASS 的原 bytes（24 train／8 valid），最長3625／max3680及另一 padded shape。每步全狀態保存後新程序恢復，再於第三個程序完整8例 validation 與正常停止 generation。CPU／組件測試不能代替實測。新 root 為 checkpointed-v8-two-layer-proof；失敗即停，不自動重試。

不提高限制：prestart swap6144MiB、absolute8192MiB、growth2048MiB、free10%、footprint12GiB、MLX14decimalGB；proof1800秒、main7200秒。階段時限、必要metrics缺失停機、owned-group清理與 offline sandbox 不變。

只有相同 workload identity 的 proof 成功才允許原先未啟動的 main12（並非再加一段12）。历史主工作30→最多42；權重lineage19→最多31；首步fresh Adam，之後完整RNG／sampler／optimizer恢復。主段不從disposable adapter開始。保持原比較預算24 generation／6 reviewer，不自動替換正式模型；若proof或main失敗，比較保持NOT_RUN。

PDU50／browser／qualification及sealed邊界不變。來源／資料雙審不等於模型回答改善。Task Tool服務不可用，使用現有STATUS記錄實際執行結果，不建立其他背景排程。
