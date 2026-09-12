"""Qwen3 assistant-only loss: retain full context, project only target positions.

For this bounded batch-one experiment, all reviewed completions plus padding fit
128 positions. Call validate_target_window on every processed row before training.
No evidence/answer tokens are truncated and model parameters are unchanged.
"""
import mlx.core as mx
import mlx.nn as nn

TARGET_WINDOW = 128


def validate_target_window(total, offset, max_seq_length, window=TARGET_WINDOW):
    padded = min(1 + 32*((total+31)//32), max_seq_length)
    first_projected_prediction = max(0, padded-1-window)
    if not 0 < offset < total <= max_seq_length or offset-1 < first_projected_prediction:
        raise ValueError('Target window would omit a supervised token')


def assistant_target_loss(model, batch, lengths, window=TARGET_WINDOW):
    if model.model_type != 'qwen3' or batch.shape[0] != 1:
        raise ValueError('Only verified Qwen3 batch-one training supported')
    inputs = batch[:, :-1]
    start = max(0, inputs.shape[1]-window)
    hidden = model.model(inputs)[:, start:]
    logits = (model.model.embed_tokens.as_linear(hidden) if model.args.tie_word_embeddings
              else model.lm_head(hidden))
    targets = batch[:, start+1:]
    positions = mx.arange(start+1, batch.shape[1])
    # Original token indices are [0, total). total itself is padding, not EOS.
    mask = (positions >= lengths[:, 0:1]) & (positions < lengths[:, 1:])
    tokens = mask.sum()
    loss = (nn.losses.cross_entropy(logits, targets)*mask).astype(mx.float32).sum()/tokens
    return loss, tokens
