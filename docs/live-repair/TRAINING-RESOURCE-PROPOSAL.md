# 單次訓練資源診斷提案 — 9 September 2026

狀態：**AWAITING_OWNER_RESOURCE_APPROVAL**。本次 full-model attempts = **0**，main updates = **0**。這份文件與程式檢查均不是 owner approval。

[完整數值、設定與檔案綁定](/Users/hltsang/.codex/private/pension-live-repair/20260909/hybrid-repair/training-resource-proposal.json)，SHA-256 `9cf62925336c753c8f81873ad68f3c7e4d1026efe1f00f8687ccf13067f2dd24`。

只提議一次 disposable compiled 診斷、兩次 optimiser updates，使用 unchanged104 / Qwen3-8B-4bit、原 LoRA16層/rank8/9,699,328參數、Adam1e-5、seed42、batch1/accumulation1、完整最長3292tokens、max_seq_length3584、assistant_target_loss_v1及128位置的 vocabulary projection。相比第二次 eager probe，只改 compiled 執行方式；不聲稱已降低完整 gradient peak。主實驗48updates不包含於此提案授權。

兩次舊 probe 都在 gradient 階段超過2,048MiB swap增量 guard；沒有完成gradient或更新。第二次forward peak5.835GB低於第一次6.893GB，不能推論完整訓練峰值或hardware不可能執行。可能原因包括eager graph/gradient materialisation、當時host負載及實際8B working set。新增監測不代表原因已證實。

上限：prestart swap6,144MiB、absolute swap8,192MiB、swap增量2,048MiB、system free至少15%、process physical footprint12GiB、MLX peak14GB；總660秒。loading/validation各90秒，compilation_graph/compiled_update各150秒，save/reload各45秒。每一項及總時限均須寫入正式binding。停止只作用於明確owned child，SIGTERM後5秒仍未結束才SIGKILL；不得終止其他app或更改全機設定。取得不到metrics亦停止。

當次live運行中baseline為swap8,411.62MiB、system free35%，**不符合提議的prestart條件**，亦不是停服後的訓練baseline。另一次資料已獨立保存；不能用後來較好的樣本掩蓋前次條件。正式許可後才停止owned服務並重測；不達條件便不啟動。

保留完整context與target。沒有選擇縮短資料、縮小adapter、替換模型、增加swap預算或購買compute。batch已為1；增加accumulation未有證據能減少單例峰值。CPU equivalence receipts保留，沒有因準備提案而重跑full-model。

No-child檢查已完成（exit0）：
`node scripts/diagnoseAdaptabilityRuntime.mjs --check-proposal /Users/hltsang/.codex/private/pension-live-repair/20260909/hybrid-repair/training-resource-proposal.json`

結果：proposal_valid=true；owner_approval=false；child_started=false。啟動仍需要owner明確批准精確提案、正式binding及隔離smoke inputs。v4的24/8bytes及review保持原樣；這輪serving模板/provenance改動不能沿用舊review宣稱訓練格式已重新核准，須先重新驗證equivalence及必要review。

真正通過須有兩次完成updates、trainable weights確實改變、base保留、峰值/時序、adapter save/reload與實際serving generation。未達成不啟動48updates，也不把此診斷計為formal或unseen結果。


## 最新條件授權核對（不是新的提案）

Owner新增一次最多兩updates的條件授權，保留原兩次失敗。原始proposal bytes及SHA維持不變；不再概括為完全沒有owner授權。當前判定 **RESOURCE_LIMIT_APPROVAL_REQUIRED**、NEW_DIAGNOSTIC_ATTEMPTS=0。

[逐項數值與舊binding比較](</Users/hltsang/.codex/private/pension-live-repair/20260909/hybrid-repair/legal-generation-continuation/resource-admissibility.json>)：swap增量2048MiB、MLX14GB、總660秒不變；system free10%→15%更嚴。舊probe未記錄可比較的prestart swap／absolute swap／physical footprint bound；原提案分別為6144MiB／8192MiB／12GiB。新compiled graph／compiled update各150秒，舊eager gradient graph及gradient各150秒、optimizer graph及optimizer各45秒，階段不能一對一比較；generation90秒是新增明確階段。已只就這些確切數值提出確認，沒有提高上限或重建提案。

此外，現有probe程式尚缺完整validation工作量、明確finite-gradient／parameter-change／frozen-base及reload後generation證據；它目前的save/reload成功旗標不足以滿足最新proof要求。執行前必須完成相應correctness修正和獨立檢查，使用實際code/input hashes重新綁定，不能假稱原proposal-bound程式已涵蓋。最新v15 serving指示亦須如實納入格式equivalence審查；24/8資料仍完全保留。

現有main launcher有7200秒時限，但沒有同等absolute/delta swap與physical footprint bound；這個main envelope仍須綁定並符合條件授權，不能把660秒probe成功冒充所有main前提已滿足。此處記錄的是現有具體缺口，不授權執行另一個方案。
