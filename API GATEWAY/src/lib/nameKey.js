/**
 * Nombre del paciente como parte de una clave del índice: minúsculas, sin
 * tildes (á → a, ñ → n) y cualquier cosa que no sea letra como "-".
 * "María José Peña" → "maria-jose-pena". La búsqueda normaliza lo escrito
 * igual, así que "pena maria" la encuentra.
 */
export function nameSlug(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}
