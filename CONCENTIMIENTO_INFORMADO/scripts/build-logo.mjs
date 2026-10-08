/**
 * Embeds the logo SVG into src/components/logos/acrLogo.ts as a string.
 *
 * Metro cannot import a .svg file as text, and reading it at runtime would go
 * through the filesystem sandbox that already bites us elsewhere. So the SVG
 * source is compiled into a TS module instead — run this whenever the logo
 * file changes:
 *
 *   npm run logo:build
 *
 * It picks up the single .svg in src/components/logos/ (or the path given as
 * the first argument).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const LOGO_DIR = join('src', 'components', 'logos');
const OUTPUT = join(LOGO_DIR, 'acrLogo.ts');

function findSvg() {
  if (process.argv[2]) return process.argv[2];

  const svgs = readdirSync(LOGO_DIR).filter((name) => name.toLowerCase().endsWith('.svg'));
  if (svgs.length === 0) {
    throw new Error(`No .svg file found in ${LOGO_DIR}. Add one, or pass a path as an argument.`);
  }
  if (svgs.length > 1) {
    throw new Error(
      `Multiple .svg files in ${LOGO_DIR} (${svgs.join(', ')}). Pass the one to use as an argument.`
    );
  }
  return join(LOGO_DIR, svgs[0]);
}

const sourcePath = findSvg();

const svg = readFileSync(sourcePath, 'utf8')
  // An XML prolog and DOCTYPE are invalid inside an HTML body.
  .replace(/<\?xml[\s\S]*?\?>/g, '')
  .replace(/<!DOCTYPE[\s\S]*?>/g, '')
  .trim();

if (!svg.startsWith('<svg')) {
  throw new Error(`${sourcePath} does not look like an SVG document.`);
}

// Escape for a TS template literal.
const escaped = svg.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const output = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Source: ${basename(sourcePath)}
 * Regenerate with: npm run logo:build
 *
 * The logo lives here as SVG source so it can be inlined directly into the
 * document HTML that becomes the PDF — no asset download, no filesystem read,
 * and sharp at print resolution.
 */
export const ACR_LOGO_SVG = \`${escaped}\`;
`;

writeFileSync(OUTPUT, output, 'utf8');
console.log(
  `Wrote ${OUTPUT} from ${sourcePath} (${(escaped.length / 1024).toFixed(1)} KB of SVG).`
);
