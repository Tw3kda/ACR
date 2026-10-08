#!/usr/bin/env node
/**
 * Publicar, retirar y listar formularios de consentimiento en AWS.
 *
 *   node scripts/publish-template.mjs check   templates/CA-F-15.json   solo valida, no toca AWS
 *   node scripts/publish-template.mjs publish templates/CA-F-15.json   valida, publica y activa
 *        --no-activate   publica la versión pero no la ofrece todavía a las tablets
 *   node scripts/publish-template.mjs retire  CA-F-15                  deja de ofrecerlo
 *   node scripts/publish-template.mjs list                            catálogo activo
 *   --yes   sin pedir confirmación
 *
 * Valida con las mismas reglas que la app y luego invoca la Lambda del API
 * directamente (IAM). Es la Lambda quien escribe: la política del bucket de
 * evidencia solo deja escribir a su rol, y solo una vez por clave.
 *
 * Las tablets ven el cambio la próxima vez que abren la lista de
 * consentimientos (el API cachea el catálogo hasta 60 s).
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';

import { parseTemplate } from '../src/lib/templateSchema.js';

const FUNCTION = process.env.LAMBDA_FUNCTION ?? 'medical-consent-api';
const [command, target, ...rest] = process.argv.slice(2);
const flags = new Set(rest.concat(process.argv.slice(2).filter((a) => a.startsWith('--'))));

const die = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

// Una sola cadena y no una lista de argumentos: en Windows `aws` es un .cmd y
// necesita shell, y Node desaconseja combinar shell con argumentos sueltos.
const quote = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function aws(args) {
  try {
    return execSync(`aws ${args.map(quote).join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    die(`aws ${args[0]} ${args[1]} falló: ${err.stderr || err.message}`);
  }
}

function invoke(payload) {
  const dir = mkdtempSync(path.join(tmpdir(), 'acr-tpl-'));
  try {
    const input = path.join(dir, 'in.json');
    const output = path.join(dir, 'out.json');
    writeFileSync(input, JSON.stringify(payload));
    aws(['lambda', 'invoke', '--function-name', FUNCTION, '--cli-binary-format', 'raw-in-base64-out',
      '--payload', `fileb://${input}`, output]);
    return JSON.parse(readFileSync(output, 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function confirm(question) {
  if (flags.has('--yes')) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`${question} [s/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== 's' && answer !== 'si' && answer !== 'sí' && answer !== 'y') die('Cancelado');
}

function loadTemplate(file) {
  if (!file) die('Falta el archivo de la plantilla');
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    die(`No se pudo leer ${file}: ${err.message}`);
  }
  try {
    return parseTemplate(raw);
  } catch (err) {
    die(err.message);
  }
}

function describe(t) {
  console.log(`\n  ${t.code} v${t.version} — ${t.title}`);
  console.log(`  examen: ${t.examType} · vigente desde ${t.effectiveDate}`);
  console.log(`  ${t.blocks.length} bloques · campos: ${t.fields.map((f) => f.key).join(', ') || '—'} · firmas: ${t.signatures.map((s) => `${s.key} (${s.signer})`).join(', ')}`);
}

function result(res) {
  if (!res?.ok) die(`${res?.status ?? '?'} ${res?.message ?? JSON.stringify(res)}`);
  return res.result;
}

const printCatalog = (active) => {
  if (!active?.length) return console.log('\n  (ningún formulario activo)');
  for (const t of active) console.log(`  • ${t.code} v${t.version} — ${t.title}  [${t.examType}]`);
};

const actor = () => JSON.parse(aws(['sts', 'get-caller-identity', '--output', 'json'])).Arn;

switch (command) {
  case 'check': {
    describe(loadTemplate(target));
    console.log('\n✓ Plantilla válida');
    break;
  }
  case 'publish': {
    const template = loadTemplate(target);
    // Lo publicado no se puede borrar: un marcador de borrador no debe llegar nunca a S3.
    if (/PENDIENTE/i.test(JSON.stringify(template))) {
      die('La plantilla todavía contiene textos "PENDIENTE". Complétela antes de publicar (publicar es permanente).');
    }
    const activate = !flags.has('--no-activate');
    describe(template);
    console.log(`\n  ${activate ? 'Se publicará y quedará ACTIVA en las tablets.' : 'Se publicará sin activar.'}`);
    console.log('  Una versión publicada no se puede modificar ni borrar: para corregirla, suba la versión.');
    await confirm('¿Publicar?');
    const r = result(invoke({ source: 'acr.admin', action: 'publishTemplate', template, activate, actor: actor() }));
    console.log(`\n✓ ${r.created ? 'Publicada' : 'Ya estaba publicada (mismo contenido)'}: ${r.key}\n  sha256 ${r.sha256}`);
    if (r.active) {
      console.log('\nCatálogo activo:');
      printCatalog(r.active);
    }
    break;
  }
  case 'retire': {
    if (!target) die('Falta el código, ej. CA-F-15');
    await confirm(`¿Retirar ${target}? Dejará de aparecer en las tablets (sus versiones se conservan).`);
    const r = result(invoke({ source: 'acr.admin', action: 'retireTemplate', code: target, actor: actor() }));
    console.log(`\n✓ ${target} retirado.\n\nCatálogo activo:`);
    printCatalog(r.active);
    break;
  }
  case 'list': {
    const r = result(invoke({ source: 'acr.admin', action: 'listTemplates' }));
    console.log(`\nCatálogo activo (actualizado ${r.updated_at_utc ?? '—'}):`);
    printCatalog(r.templates);
    break;
  }
  default:
    die('Uso: publish-template.mjs check|publish <archivo.json> · retire <código> · list   [--no-activate] [--yes]');
}
