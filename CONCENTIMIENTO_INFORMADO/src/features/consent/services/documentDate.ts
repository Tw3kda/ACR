/** The paper form prints its control date as DD-MM-YYYY. */
export function formatDocumentDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${date.getFullYear()}`;
}

/** Full stamp for the signature block: DD-MM-YYYY HH:MM. */
export function formatDocumentDateTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${formatDocumentDate(date)} ${hours}:${minutes}`;
}

/**
 * The template's own creation date (stored as `YYYY-MM-DD`) for the masthead.
 * Parsed by hand rather than via `new Date()`, which reads a bare ISO date as
 * UTC midnight and can render the previous day in western timezones.
 */
export function formatTemplateDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!match) return isoDate;
  const [, year, month, day] = match;
  return `${day}-${month}-${year}`;
}
