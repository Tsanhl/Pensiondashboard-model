# Private pension-material admission rules

Actual scheme rules, provider policies, statements of investment principles (SIPs) and user documents cannot be created from public-law sources. They enter only after an authenticated upload and remain private to that user or authorised scheme tenant.

## Required metadata

Each version requires a stable document ID, authenticated owner, source type, full title, issuer, jurisdiction, version/date, effective date, expiry or replacement status, SHA-256 checksum, encrypted object-storage key, page completeness check, and approval status. Scheme/provider material also requires the administrator or issuer source and evidence that the uploader is entitled to use it.

## Admission states

1. `pending_upload`: metadata only; never searchable.
2. `quarantined`: failed signature, malware, prompt-injection or completeness review; never searchable.
3. `pending_review`: text extracted, but issuer/version/authority is not confirmed; searchable only as a clearly unconfirmed private upload when the user asks about their own document.
4. `active_private`: validated and indexed under `USER_DOCUMENTS`; never copied to `CURATED_PUBLIC`, fine-tuning data or another user's cache.
5. `superseded` or `deleted`: excluded from retrieval; deletion removes originals, text, chunks, embeddings, facts, citations and cache entries under the configured retention policy.

## Evidence meaning and priority

- Applicable legislation and binding case law control the legal position.
- Current executed scheme rules govern scheme-specific legal terms, subject to overriding law.
- A provider summary or member booklet may explain administration but cannot silently override executed rules.
- A SIP records investment policy and governance; it is not proof of an individual member's entitlement or a recommendation to select a fund.
- A user statement supports dated user facts only. Extracted balances, contribution rates and guarantees remain unconfirmed until the user or an authorised reviewer confirms them.
- Conflicting or incomplete versions must be shown as a conflict and routed for human review; the model must not choose a preferred private document by guesswork.

## Storage boundary

Original files and normalized text belong in encrypted object storage, metadata/facts/chunks in Postgres, embeddings in pgvector and short-lived results in user-keyed Redis. Private binaries, normalized text and restricted training examples are not committed to Git.

Use `approved-materials/review/private-source-manifest.template.json` for an admission batch, then run `npm run materials:validate-private-manifest -- path/to/manifest.json` before ingestion.
