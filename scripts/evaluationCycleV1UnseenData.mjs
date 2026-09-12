/**
 * Intentionally empty after the Phase 4 authoring ceremony.
 *
 * The plaintext unseen gold authoring data was destroyed after the encrypted
 * packs and manifests were verified. Keeping it in the repository would make
 * the sealed answers accessible to prompt development and training jobs.
 * The immutable encrypted artefacts under 04-unseen are now the source of
 * truth and may only be opened by the dedicated evaluation runner.
 */
export const unseenItems = Object.freeze([]);
