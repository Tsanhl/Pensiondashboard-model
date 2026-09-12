# Training duration study — predeclared, not run

The current evidence does not document why 48 is empirically optimal, so `WHY_48=NOT_DOCUMENTED`. The number is retained only as the existing bounded comparison cap.

The pinned `mlx-lm 0.31.3` loop defines `iters` as microbatch iterations. With batch size 1 and gradient accumulation 1, the proposed single trajectory has 48 microbatches, 48 completed optimiser updates, 48 presented examples and two exposure-equivalents over 24 eligible training rows. If any of those settings changes, preparation fails closed instead of relabelling microbatches as updates.

Checkpoint 104 is update 0. Snapshots 12, 24, 36 and 48 must come from the same trajectory. Selection is predeclared against the reviewed validation-eight: identity, complete-review and hard-failure gates first; semantic completeness and omissions before comparable loss; within a 1% loss tie, fewer updates wins. PDU50 is not training data and is not a checkpoint selector.

No model work was started. Training remains blocked because compatible two-update proof and explicit resource-limit/attempt authority are absent. See `TRAINING-DURATION-STUDY.json` for exact hashes and status.
