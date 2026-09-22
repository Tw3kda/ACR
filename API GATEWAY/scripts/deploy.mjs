#!/usr/bin/env node
/**
 * Despliegue: imagen → ECR → Terraform.
 *
 *   node scripts/deploy.mjs              build + push + apply de infra/api (pide confirmación)
 *   node scripts/deploy.mjs --yes        igual, sin preguntar
 *   node scripts/deploy.mjs --plan       build + push + plan de infra/api, sin aplicar
 *   node scripts/deploy.mjs --no-build   solo apply de infra/api con la última imagen subida
 *   node scripts/deploy.mjs --platform   aplica infra/platform (y bootstrap si hace falta). Sin build.
 *
 * Tres estados de Terraform, tres responsabilidades:
 *
 *   infra/bootstrap   el bucket del estado. Una vez por cuenta.
 *   infra/platform    KMS, DynamoDB, S3, Cognito. Guarda datos; se aplica a mano
 *                     con --platform, rara vez.
 *   infra/api         ECR, Lambda, API Gateway, IAM. Se aplica en cada push.
 *
 * El despliegue normal solo toca infra/api. Por mal que salga, no alcanza a la
 * tabla, al bucket ni al user pool: están en otro estado y este módulo solo
 * los lee.
 *
 * Nunca usa `aws lambda update-function-code`: eso cambia la función por fuera
 * de Terraform y el siguiente apply la devolvería a la imagen anterior.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INFRA = {
  bootstrap: path.join(ROOT, 'infra', 'bootstrap'),
  platform: path.join(ROOT, 'infra', 'platform'),
  api: path.join(ROOT, 'infra', 'api'),
};
const REPO_NAME = 'acr-consent-api';

const args = new Set(process.argv.slice(2));
const AUTO_APPROVE = args.has('--yes');
const PLAN_ONLY = args.has('--plan');
const SKIP_BUILD = args.has('--no-build');
const PLATFORM = args.has('--platform');
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
for (const tool of PLATFORM || SKIP_BUILD ? ['aws', 'terraform'] : ['docker', 'aws', 'terraform']) {
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

// --- despliegue del API ----------------------------------------------------------------
if (!stateBucketExists() || !platformStateExists()) {
  fail(
    'infra/platform no está aplicado todavía. infra/api lee de su estado y sin él el plan falla.\n' +
      '  Primero: node scripts/deploy.mjs --platform'
  );
}

if (capture('docker info') === null && !SKIP_BUILD) {
  fail('Docker está instalado pero el engine no responde. Arranca Docker Desktop.');
}

// --- 2. tag de la imagen ------------------------------------------------------
function imageTag() {
  const sha = capture('git rev-parse --short=12 HEAD');
  if (sha) {
    const dirty = capture('git status --porcelain');
    if (dirty) {
      console.warn('  ⚠ hay cambios sin commit: la imagen no corresponderá a ningún commit exacto');
      return `${sha}-dirty-${Date.now()}`;
    }
    return sha;
  }
  // Sin git: marca de tiempo, que es lo único que garantiza un tag nuevo (el
  // repositorio de ECR es IMMUTABLE y rechaza reutilizar uno).
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

const registry = `${account}.dkr.ecr.${region}.amazonaws.com`;
const repoUrl = `${registry}/${REPO_NAME}`;
const tfvarsPath = path.join(INFRA.api, 'image.auto.tfvars');

log('infra/api init');
init('api');

if (SKIP_BUILD) {
  if (!existsSync(tfvarsPath)) fail('--no-build necesita un despliegue previo (no existe infra/api/image.auto.tfvars)');
  log('Sin build: se aplica la última imagen registrada en image.auto.tfvars');
} else {
  const tag = imageTag();
  log(`Imagen: ${repoUrl}:${tag}`);

  // --- 3. repositorio ----------------------------------------------------------
  // No se puede subir a un repositorio que no existe, y no se puede crear una
  // Lambda desde una imagen que no está subida: de ahí el apply parcial la
  // primera vez.
  const repoExists = capture(`aws ecr describe-repositories --repository-names ${REPO_NAME} --region ${region}`) !== null;
  if (!repoExists) {
    log('El repositorio de ECR no existe todavía: apply parcial para crearlo');
    terraform('api', `apply -target=aws_ecr_repository.api -var="api_image_tag=${tag}" ${APPROVE}`);
  }

  // --- 4. build + push ----------------------------------------------------------
  log('Login en ECR');
  const password = capture(`aws ecr get-login-password --region ${region}`);
  if (!password) fail('aws ecr get-login-password falló');
  // Un solo string: con shell:true, pasar args por separado dispara el aviso
  // DEP0190 de Node (los concatena sin escapar de todas formas).
  const login = spawnSync(`docker login --username AWS --password-stdin ${registry}`, {
    input: password,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: true,
  });
  if (login.status !== 0) fail('docker login falló');

  log('docker build (target lambda, linux/amd64, sin atestaciones)');
  // --platform explícito: Lambda corre x86_64 y una imagen arm64 —lo que sale
  // por defecto en un Mac con Apple Silicon— falla en el arranque.
  //
  // --provenance=false --sbom=false: BuildKit adjunta por defecto un manifiesto
  // de atestación y convierte el push en un OCI *image index* (una lista de
  // manifiestos). Lambda solo acepta un manifiesto de imagen único y rechaza
  // el índice con "image manifest, config or layer media type ... is not
  // supported". Sin atestaciones, lo que se sube es la imagen a secas.
  run(
    `docker build --platform linux/amd64 --provenance=false --sbom=false --target lambda -t "${repoUrl}:${tag}" .`
  );

  log('docker push');
  run(`docker push "${repoUrl}:${tag}"`);

  // --- 5. registrar el tag ------------------------------------------------------
  writeFileSync(
    tfvarsPath,
    `# Escrito por scripts/deploy.mjs. Terraform lo carga automáticamente.\napi_image_tag = "${tag}"\n`
  );
  console.log(`  infra/api/image.auto.tfvars → api_image_tag = "${tag}"`);
}

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
