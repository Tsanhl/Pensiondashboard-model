"""Cache only an exact system-message prefix; never user text or model output."""
import copy


class SystemPrefixCache:
    def __init__(self):
        self.tokens = ()
        self.cache = None

    def prepare(self, messages, prompt, tokenizer, build):
        if not messages or messages[0].get("role") != "system":
            return prompt, None, 0
        prefix = tokenizer.apply_chat_template(messages[:1], tokenize=True,
                                               add_generation_prompt=False, enable_thinking=False)
        # Templates may add special tokens differently for an isolated system
        # message. Reuse is safe only after checking actual token equality.
        if not prefix or len(prefix) >= len(prompt) or prompt[:len(prefix)] != prefix:
            return prompt, None, 0
        if tuple(prefix) != self.tokens:
            cache = build(prefix)
            self.tokens, self.cache = tuple(prefix), cache
        # Generation mutates KV caches: never hand the stored prefix to it.
        return prompt[len(prefix):], copy.deepcopy(self.cache), len(prefix)
