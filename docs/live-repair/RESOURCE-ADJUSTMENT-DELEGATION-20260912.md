# Owner委託：有依據的限額調整自行執行

最新owner訊息：「yes and can u just durectly do these adjustments urself otherwise everytime stop for swap limit + these validation up limit urself」。此指示同意上一輪validation180→300秒及一次480秒補驗，也授權代理自行作有實測依據的訓練／驗證資源調整；不再為同類調整反覆詢問。它覆蓋舊文件內一般數值調整必須另問owner的文字。

每次先記錄原值、新值、實測理由、工作量、有限次數與停止條件，再執行。不得在正在執行的run中偷偷改規則；不得刪除failure、偽造PASS、無限加高直到通過。真正資源壓力或未知metrics仍停止並診斷。

本輪：一次verification-only，validation300秒／generation90秒／總480秒；只讀已保存checkpoint2，0個梯度更新。swap growth2048MiB、absolute8192MiB、prestart6144MiB、free10%、footprint12GiB、MLX14GB維持。成功後沿用原未執行main12（歷史30→最多42，權重19→最多31），不新增一段12。

代理自設有限工作護欄：若未來實測需要，同類stage可依完整工作量調整至至多600秒；swap增量僅可在有healthy/free/footprint證據下提出並記錄一次至多4096MiB的有限實驗，absolute8192、free10及其他記憶體保護仍保留。這不是目前已調高或已預約重試；持續壓力不能用放寬掩蓋。更大硬體／雲端費用、全機記憶體設定、殺其他app、deploy／push、放寬模型品質門檻或sealed unseen不在此授權內。

正常完成與停機後均記錄實際程序、額度、更新數及持久checkpoint。驗證超時優先補驗已有權重，不能重做已完成梯度。主訓練重啟仍必須保留總更新及完整RNG／sampler／optimizer狀態。
