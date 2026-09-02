import unittest
from ml.pinned_prompt_cache import SystemPrefixCache


class Tokenizer:
    def apply_chat_template(self, messages, **kwargs):
        return list(messages[0]["content"])


class PrefixTests(unittest.TestCase):
    def test_exact_prefix_reuse_does_not_keep_user_tokens_or_mutations(self):
        cache, built = SystemPrefixCache(), []
        def build(tokens):
            built.append(tokens)
            return {"tokens": list(tokens)}
        messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "private"}]
        suffix, kv, count = cache.prepare(messages, list("sysprivate"), Tokenizer(), build)
        self.assertEqual((suffix, count), (list("private"), 3))
        kv["tokens"].append("user")
        suffix, kv, count = cache.prepare(messages, list("sysother"), Tokenizer(), build)
        self.assertEqual(kv["tokens"], list("sys"))
        self.assertEqual(suffix, list("other"))
        self.assertEqual(len(built), 1)
        messages[0]["content"] = "new"
        cache.prepare(messages, list("newother"), Tokenizer(), build)
        self.assertEqual(len(built), 2)

    def test_nonmatching_template_or_no_system_never_reuses_cache(self):
        cache = SystemPrefixCache()
        def forbidden(tokens):
            self.fail("Should not build an unsafe prefix")
        for messages, prompt in [([], [1]), ([{"role": "user", "content": "x"}], [1]),
                                 ([{"role": "system", "content": "sys"}], list("different")),
                                 ([{"role": "system", "content": "sys"}], list("sys"))]:
            self.assertEqual(cache.prepare(messages, prompt, Tokenizer(), forbidden), (prompt, None, 0))


if __name__ == "__main__":
    unittest.main()
