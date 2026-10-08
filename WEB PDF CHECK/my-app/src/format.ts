const dateFmt = new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' });

export function formatDate(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
}

const timeFmt = new Intl.DateTimeFormat('es-CO', { timeStyle: 'short' });

export function formatTime(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFmt.format(d);
}

/** ¿Es de hoy, en la zona horaria de este navegador? */
export function isToday(iso: string | null | undefined) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export function formatBytes(n: number | null | undefined) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const shortHash = (h: string | null | undefined) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : '—');

/** `EXAMEN_INGRESO_OCUPACIONAL` → `Examen ingreso ocupacional`. */
export function humanize(v: string | null | undefined) {
  if (!v) return '';
  const s = v.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}
