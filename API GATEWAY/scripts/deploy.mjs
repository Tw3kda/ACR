#!/usr/bin/env node
/**
 * Despliegue: paquete .zip → Terraform. No necesita Docker.
 *
 *   node scripts/deploy.mjs              paquete + apply de infra/api (pide confirmación)
 *   node scripts/deploy.mjs --yes        igual, sin preguntar
 *   node scripts/deploy.mjs --plan       paquete + plan de infra/api, sin aplicar
 *   node scripts/deploy.mjs --no-build   solo apply de infra/api con el último paquete
 *   node scripts/deploy.mjs --platform   aplica infra/platform (y bootstrap si hace falta). Sin build.
 *   node scripts/deploy.mjs --web        aplica infra/web, compila la web de consulta
 *                                        (WEB PDF CHECK/my-app) con la URL del API y la sube.
 *
 * Tres estados de Terraform, tres responsabilidades:
 *
 *   infra/bootstrap   el bucket del estado. Una vez por cuenta.
 *   infra/platform    KMS, DynamoDB, S3, Cognito. Guarda datos; se aplica a mano
 *                     con --platform, rara vez.
 *   infra/api         Lambda (.zip), API Gateway, IAM. Se aplica en cada push.
 *
 * El despliegue normal solo toca infra/api. Por mal que salga, no alcanza a la
 * tabla, al bucket ni al user pool: están en otro estado y este módulo solo
 * los lee.
 *
 * Nunca usa `aws lambda update-function-code`: eso cambia la función por fuera
 * de Terraform y el siguiente apply la devolvería al paquete anterior.
 */
import { execSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INFRA = {
  bootstrap: path.join(ROOT, 'infra', 'bootstrap'),
  platform: path.join(ROOT, 'infra', 'platform'),
  api: path.join(ROOT, 'infra', 'api'),
  web: path.join(ROOT, 'infra', 'web'),
};
const WEB_APP = path.resolve(ROOT, '..', 'WEB PDF CHECK', 'my-app');

const args = new Set(process.argv.slice(2));
const AUTO_APPROVE = args.has('--yes');
const PLAN_ONLY = args.has('--plan');
const SKIP_BUILD = args.has('--no-build');
const PLATFORM = args.has('--platform');
const WEB = args.has('--web');
const APPROVE = AUTO_APPROVE ? '-auto-approve' : '';

// --- utilidades --------------------------------------------------------------
const log = (msg) => console.log(`\n▶ ${msg}`);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

/** Ejecuta y muestra la salida en directo. Aborta si falla. */
function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  const result = spawnSync(cmd, { stdio: 'inherit', shell: true, cwd: ROOT, ...opts });
  if (result.status !== 0) fail(`falló: ${cmd}`);
}

/** Ejecuta y devuelve la salida. Devuelve null si falla, sin abortar. */
function capture(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: ROOT, ...opts }).trim();
  } catch {
    return null;
  }
}

// --- 1. requisitos -----------------------------------------------------------
log('Comprobando herramientas');
for (const tool of ['aws', 'terraform', 'npm']) {
  if (capture(`${tool} --version`) === null) {
    fail(`${tool} no está en el PATH. Ver el runbook en README.md.`);
  }
}

const identity = capture('aws sts get-caller-identity --output json');
if (!identity) {
  fail('No hay credenciales de AWS. Ejecuta `aws configure` o `aws sso login` primero.');
}
const { Account: account } = JSON.parse(identity);

const region =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || capture('aws configure get region') || 'us-east-1';

console.log(`  cuenta ${account} · región ${region}`);

// Mismo nombre determinista que calcula infra/bootstrap y que api/providers.tf
// usa para leer el estado de platform/.
const stateBucket = `acr-consent-tfstate-${account}`;

// --- terraform con backend remoto ------------------------------------------------
function terraform(root, subcommand) {
  // tflocal (scripts/localstack.mjs) genera este override y lo borra al
  // terminar. Si un corte lo dejó atrás, apuntaría ESTE despliegue a
  // localhost:4566 con credenciales "test". Nunca debe existir al tocar AWS.
  const stale = path.join(INFRA[root], 'localstack_providers_override.tf');
  if (existsSync(stale)) {
    console.warn(`  ⚠ eliminando override de LocalStack olvidado: ${stale}`);
    unlinkSync(stale);
  }
  run(`terraform -chdir="${INFRA[root]}" ${subcommand}`);
}

/**
 * `init` con el bucket del estado. El bloque backend no admite variables, así
 * que el nombre —que lleva el id de cuenta— entra por -backend-config.
 * `-reconfigure` hace que sea idempotente aunque cambie la cuenta.
 */
function init(root) {
  if (root === 'bootstrap') {
    if (!existsSync(path.join(INFRA.bootstrap, '.terraform'))) terraform('bootstrap', 'init');
    // scripts/localstack.mjs selecciona el workspace `localstack` y esa
    // selección persiste en .terraform/. Contra AWS siempre es `default`.
    terraform('bootstrap', 'workspace select default');
    return;
  }
  terraform(
    root,
    `init -reconfigure -backend-config="bucket=${stateBucket}" -backend-config="region=${region}"`
  );
}

const stateBucketExists = () => capture(`aws s3api head-bucket --bucket ${stateBucket}`) !== null;
const platformStateExists = () =>
  capture(`aws s3api head-object --bucket ${stateBucket} --key platform/terraform.tfstate`) !== null;

// --- modo --platform ----------------------------------------------------------------
if (PLATFORM) {
  if (!stateBucketExists()) {
    log('El bucket del estado no existe: aplicando infra/bootstrap (estado local, una sola vez)');
    init('bootstrap');
    terraform('bootstrap', `apply ${APPROVE}`);
  }

  log('infra/platform');
  init('platform');
  terraform('platform', PLAN_ONLY ? 'plan' : `apply ${APPROVE}`);

  console.log('\nplatform listo. Ahora el API: node scripts/deploy.mjs');
  process.exit(0);
}

// --- modo --web ---------------------------------------------------------------------
if (WEB) {
  if (!platformStateExists()) fail('infra/platform no está aplicado todavía: node scripts/deploy.mjs --platform');

  log('infra/web');
  init('web');
  terraform('web', PLAN_ONLY ? 'plan' : `apply ${APPROVE}`);
  if (PLAN_ONLY) process.exit(0);

  const out = (root, name) => capture(`terraform -chdir="${INFRA[root]}" output -raw ${name}`);
  const bucket = out('web', 'site_bucket');
  const distribution = out('web', 'cloudfront_distribution_id');
  const siteUrl = out('web', 'site_url');

  init('api');
  const apiUrl = out('api', 'api_endpoint');
  if (!bucket || !distribution || !apiUrl) fail('faltan outputs de infra/web o infra/api (¿está desplegado el API?)');

  // La URL del API se fija en el build: Vite la incrusta en el JavaScript.
  log(`Build de la web con VITE_API_URL=${apiUrl}`);
  run('npm ci', { cwd: WEB_APP });
  run('npm run build', { cwd: WEB_APP, env: { ...process.env, VITE_API_URL: apiUrl } });

  // Los assets llevan hash en el nombre: caché larga. index.html no, para que
  // un despliegue se vea en cuanto termina la invalidación.
  log(`Subiendo a s3://${bucket}`);
  const dist = path.join(WEB_APP, 'dist');
  run(`aws s3 sync "${dist}" s3://${bucket} --delete --exclude index.html --cache-control "public,max-age=31536000,immutable"`);
  run(`aws s3 cp "${path.join(dist, 'index.html')}" s3://${bucket}/index.html --cache-control "no-cache"`);
  run(`aws cloudfront create-invalidation --distribution-id ${distribution} --paths "/index.html" --output text --query Invalidation.Id`);

  init('platform');
  const origins = capture(`terraform -chdir="${INFRA.platform}" output -json cors_allowed_origins`) ?? '[]';
  log(`Web publicada: ${siteUrl}`);
  if (!JSON.parse(origins).includes(siteUrl)) {
    console.warn(
      `\n  ⚠ ${siteUrl} no está en cors_allowed_origins: el navegador no podrá llamar al API.\n` +
        '    Añádelo en infra/platform/terraform.tfvars y ejecuta:\n' +
        '      node scripts/deploy.mjs --platform && node scripts/deploy.mjs --no-build'
    );
  }
  process.exit(0);
}

// --- despliegue del API ----------------------------------------------------------------
if (!stateBucketExists() || !platformStateExists()) {
  fail(
    'infra/platform no está aplicado todavía. infra/api lee de su estado y sin él el plan falla.\n' +
      '  Primero: node scripts/deploy.mjs --platform'
  );
}

// --- 2. paquete de la Lambda ---------------------------------------------------
// .build/lambda/ = lo que corre en Lambda: package.json + src/ + dependencias
// de producción. Terraform (archive_file) lo comprime y lo sube; si nada
// cambió, el hash es el mismo y la función no se toca.
const BUILD_DIR = path.join(ROOT, '.build', 'lambda');

if (SKIP_BUILD) {
  if (!existsSync(BUILD_DIR)) fail('--no-build necesita un build previo (no existe .build/lambda)');
  log('Sin build: se aplica el último paquete de .build/lambda');
} else {
  log('Paquete de la Lambda (.build/lambda)');
  rmSync(BUILD_DIR, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) cpSync(path.join(ROOT, f), path.join(BUILD_DIR, f));
  cpSync(path.join(ROOT, 'src'), path.join(BUILD_DIR, 'src'), { recursive: true });
  // Solo dependencias de producción, exactamente las del lockfile.
  run('npm ci --omit=dev --no-audit --no-fund', { cwd: BUILD_DIR });
}

log('infra/api init');
init('api');

// --- 6. terraform ---------------------------------------------------------------
if (PLAN_ONLY) {
  log('terraform plan (infra/api)');
  terraform('api', 'plan');
  console.log('\nSolo plan. Para aplicar: node scripts/deploy.mjs --no-build');
  process.exit(0);
}

log('terraform apply (infra/api)');
terraform('api', `apply ${APPROVE}`);

log('Desplegado');
const endpoint = capture(`terraform -chdir="${INFRA.api}" output -raw api_endpoint`);
if (endpoint) {
  console.log(`\n  EXPO_PUBLIC_API_URL=${endpoint}`);
  console.log('  → cópialo al .env de la app móvil (terraform -chdir=infra/api output app_env tiene el bloque completo).');
}
