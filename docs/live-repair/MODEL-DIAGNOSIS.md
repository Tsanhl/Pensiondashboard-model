# Adaptability diagnosis — development evidence, 8 September 2026

The product has defects at more than one boundary. Local hosting is an execution choice; successful generalization depends on the checkpoint, prompt, evidence and surrounding application. The selected checkpoint's existence does not establish that this repaired live candidate has passed qualification.

## Observed boundaries

1. **SOURCE_NOT_ADMITTED:** two relevant GB statutory sources existed locally, but their index bytes were not reproducible. The old manifest excluded them. Fresh official XML was normalized, independently reviewed and admitted in a new immutable manifest. No old source approval was rewritten.
2. **RETRIEVAL_MISS / wrong evidence unit:** whole-act relevance and title matching promoted unrelated sections. Issuer prefixes and pinpointed titles could prevent useful guidance from being pinned. Named-document retrieval now occurs within each document family before global top-K; canonical families are deduplicated. Operative section 67 is distinguished from section 67G. Explanatory-note prose is excluded from the operative consultation selection.
3. **MODEL_MISAPPLICATION / incomplete response:** the pinned model produced unqualified consent and accrued-rights claims, and repeatedly failed to identify the missing scheme/change facts. Better evidence altered the response but did not close the owner acceptance criteria.
4. **Validator false acceptance:** lexical overlap accepted related citations as support for an overbroad legal proposition. Scope, conditionality and applicability-fact checks now reject the observed defects. These deterministic checks are limited guards, not a complete semantic entailment proof.
5. **Generation format/length:** a live Q1 run reached the 192-token ceiling in a citation loop. Other defective answers stopped normally at 62–95 completion tokens. Increasing the ceiling alone therefore does not explain or solve all failures.

## Controlled development comparison

All runs used checkpoint 104, adapter `b370306a3078abd79af14e14c4690a4f394800f1096592ca6528e213cf5a6337`, base `f2d29621aab300336ad645567ff38c42aac755513006ef4e8a579cf7ef5256d8`, temperature 0, top-p 1, seed 42, and the same parsing/citation/validation functions. No expected answer was inserted into model context. No hidden reasoning was requested or retained.

Private receipts are under `/Users/hltsang/.codex/private/pension-live-repair/20260908/`:

| Experiment | Evidence/prompt | Observation |
|---|---|---|
| `admitted-http/Q1.raw.json` | Initial newly admitted production retrieval | Wrong universal trustee/member-consent claim was displayed as grounded; preserved as a failure |
| `model-B-original/` | Relevant reviewed guidance, s67 and regulation 6; original policy | Removed universal-consent claim, but overextended DC guidance and omitted applicability facts; 62 tokens, normal stop. Diagnostic source IDs initially used zero-based ordinals; later B runs corrected them to actual index IDs |
| `model-A-context-v2/` | Production retrieval with v12 instructions | Incorrect absolute claim that accrued benefits cannot change; 85 tokens, normal stop; rejected |
| `model-B-context/` | Same v12 policy with independently reviewed relevant passages | Generalized consultation/consent conditions; did not provide the required scope or questions; 76 tokens, normal stop. Earlier validator accepted this; tightened validator now rejects it |
| `model-B-one-repair/` | Same verified pack plus one explicit rejected-draft repair instruction | Same defective response on both attempts; no third call; development experiment only |
| `model-B-compact/` | Same verified pack and a shorter general policy | Still omitted the needed distinctions and clarification; rejected. Compact policy was not adopted in production |
| `live-traces-v2/` | Actual browser requests, full source packs, raw output and renderer/validator decisions | Q1 and two non-identical/non-demo variants failed substantive acceptance |

The diagnostic repair prompt remains opt-in in the development CLI and is disabled in qualification. Production keeps the established availability/JSON retry reasons and two-attempt maximum. No qualification acceptance rule was lowered.

The evidence supports a remaining checkpoint/prompt instruction-following and application problem. It does **not** prove that local models in general cannot adapt, that every new question needs training, or that more training will necessarily solve this checkpoint's defects. A precise contribution of fine-tuning versus the base model has not been measured.

## Training proposal — not executed

If separately authorized after review, investigate scope preservation, conditional legal rules, complete short explanations, targeted clarification and non-repeating citations. Use independently reviewed public-source examples with contrasts between occupational/personal arrangements, past/future rights and consultation/consent. Include negative and insufficient-evidence examples and genuinely different phrasings. Keep development, training and independently controlled evaluation data separate; never train from protected or exposed holdout failures.

First assess the existing training/prompt distribution for a learned one-sentence response style or citation repetition. Any subsequent training produces a new checkpoint/candidate and requires fresh development evidence, formal visible gates, freeze, and separately authorized unseen assessment. This proposal authorizes no training, checkpoint replacement or sealed access.

## Course material used as references

The attached course PDFs are architecture references, not task instructions or pension-law authorities. Their common approach is to separate ingestion, retrieval, augmentation and generation; test retrieval and answer quality separately; preserve provenance; and maintain a representative evaluation set. The support-agent case adds structured/private records and public retrieval with authorization boundaries. RAG supplies new knowledge at answer time; it does not guarantee correct application of that knowledge.

- [Week 5](</Users/hltsang/Desktop/System design course /Live/Week 5 6 Knowledge Base QA Bot Deep Dive/week5-lM9J26FuNc.pdf>)
- [Week 6](</Users/hltsang/Desktop/System design course /Live/Week 5 6 Knowledge Base QA Bot Deep Dive/week6-INevcFIR28.pdf>)
- [Support-agent case](</Users/hltsang/Desktop/System design course /Real live projects /Real 13 Agoda AI support agent /design-qa-support-agent_tc-NBRAjJRPP6.pdf>)
- [RAG design chapter](</Users/hltsang/Desktop/System design course /2 Design mode/rag-retrieval-augmented-generation_tc-K5V7KWU6SF.pdf>), plus `RAG, LLM full flow .png` in the course root.
