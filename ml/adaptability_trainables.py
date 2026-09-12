"""Keep the full parent adapter; train only a declared last-layer subset."""
def restrict_trainables(model, last_layers):
    from mlx.utils import tree_flatten
    if not isinstance(last_layers,int) or not 1 <= last_layers <= len(model.layers):
        raise ValueError('Invalid trainable layer subset')
    for layer in model.layers[:-last_layers]:
        layer.freeze()
    parameters=dict(tree_flatten(model.trainable_parameters()))
    if not parameters: raise ValueError('No trainable adapter parameters')
    return parameters

def complete_adapter(parent, changed, expected_keys):
    if set(changed)!=set(expected_keys) or not set(changed).issubset(parent):
        raise ValueError('Partial checkpoint does not match declared trainable subset')
    return {**parent,**changed}
