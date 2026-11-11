// Features that are built but switched off. To switch one back on, see HANDOVER.md ("Switching Microsoft back on").

/**
 * Microsoft Copilot Studio (task 3.1, set aside 11 Nov 2026): Copilot Studio only blocks published agents, and a free
 * trial cannot publish, so the product is Appian-only for now. While false, /api/v1/microsoft/* answers 404.
 * Keep in step with MICROSOFT in src/lib/features.ts and the MICROSOFT_ENABLED variable of db-migrate.yml.
 */
export const MICROSOFT_ENABLED = false
