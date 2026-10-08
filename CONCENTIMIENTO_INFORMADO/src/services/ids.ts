/**
 * Identifier generation for records the app creates before the backend sees
 * them. Both helpers are deliberately client-side: a consent has to be
 * identifiable while the tablet is offline, and the audit log needs a stable
 * key the moment it is built.
 */

/**
 * RFC 4122 v4 UUID from `Math.random`.
 *
 * Not cryptographically strong — it identifies a log entry, it does not
 * authenticate one. If the backend ever needs unguessable ids it should mint
 * them itself and overwrite `log_id`.
 */
export function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/**
 * Human-readable consent id, `CONS-YYYY-MMDD-<10 hex>`: sortable by date, and
 * unique enough to be a storage key.
 *
 * It IS a storage key: the backend stores each consent's audit events under
 * `events/<consent_id>/…` in S3, and a second consent with the same id is a
 * conflict, not a merge. Three random digits (the original format) collide
 * with >1% probability at five consents a day; 40 bits of a UUID do not
 * collide at any volume a clinic will see. The backend cannot assign the id
 * itself because the PDF and its hash exist before the backend is involved.
 */
export function createConsentId(when: Date = new Date()): string {
  const year = when.getUTCFullYear();
  const month = String(when.getUTCMonth() + 1).padStart(2, '0');
  const day = String(when.getUTCDate()).padStart(2, '0');
  const suffix = uuidv4().replace(/-/g, '').slice(0, 10);
  return `CONS-${year}-${month}${day}-${suffix}`;
}
