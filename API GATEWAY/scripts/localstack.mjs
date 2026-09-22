#!/usr/bin/env node
/**
 * Entorno local completo sobre LocalStack, con el Terraform real.
 *
 *   node scripts/localstack.mjs            levanta LocalStack, aplica infra con tflocal, arranca el API
 *   node scripts/localstack.mjs --infra    solo la parte de Terraform (LocalStack ya corriendo)
 *   node scripts/localstack.mjs --down     para y borra los contenedores
 *
 * Pasos:
 *   1. docker compose up localstack, y espera a que responda.
 *   2. tflocal sobre infra/bootstrap → el bucket del estado, dentro de LocalStack.
 *      Usa el workspace `localstack` para no pisar el estado local del bootstrap
 *      real de AWS.
 *   3. tflocal sobre infra/platform con localstack.tfvars → KMS, DynamoDB con
 *      GSI1 y GSI2, S3 con Object Lock, cifrado y CORS. Cognito no (es de pago
 *      en LocalStack; el API lo simula).
 *   4. docker compose up api, que arranca con .env.localstack apuntando a lo
 *      recién creado.
 *
 * LocalStack Community no persiste entre reinicios: cada `docker compose down`
 * borra la tabla y el bucket. Volver a ejecutar este script los recrea.
 *
 * infra/api no se aplica: ECR, Lambda desde imagen y API Gateway v2 son
 * funciones de pago en LocalStack. El API corre como contenedor de Express en
 * su lugar.
 */
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = `docker compose -f "${path.join(ROOT, 'docker-compose.localstack.yml')}"`;
const INFRA = {
  bootstrap: path.join(ROOT, 'infra', 'bootstrap'),
  platform: path.join(ROOT, 'infra', 'platform'),
};
const HEALTH_URL = 'http://localhost:4566/_localstack/health';
// LocalStack siempre responde este id de cuenta; bootstrap/ compone el nombre
// del bucket del estado con él.
const LOCALSTACK_ACCOUNT = '000000000000';
const STATE_BUCKET = `acr-consent-tfstate-${LOCALSTACK_ACCOUNT}`;
const REGION = 'us-east-1';

const args = new Set(process.argv.slice(2));

const log = (msg) => console.log(`\n▶ ${msg}`);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  const result = spawnSync(cmd, { stdio: 'inherit', shell: true, cwd: ROOT, env: localstackEnv(), ...opts });
  if (result.status !== 0) fail(`falló: ${cmd}`);
}

function capture(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: ROOT, env: localstackEnv() }).trim();
  } catch {
    return null;
  }
}

/**
 * Credenciales ficticias para todo lo que corra desde aquí. tflocal ya las
 * inyecta en el proveedor; esto cubre `aws`/`awslocal` y evita que el SDK vaya
 * a buscar el perfil real de ~/.aws — que es exactamente lo que no queremos
 * tocar desde un script de pruebas.
 */
function localstackEnv() {
  return {
    ...process.env,
    LOCALSTACK_AUTH_TOKEN: authToken(),
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
    AWS_DEFAULT_REGION: REGION,
    AWS_REGION: REGION,
    HOST_IP: process.env.HOST_IP || detectHostIp(),
  };
}

/**
 * Token de LocalStack. Desde 2025 el contenedor no arranca sin él, ni en el
 * plan gratuito. Se busca en la variable de entorno y, si no, donde lo guarda
 * `localstack auth set-token` (~/.localstack/auth.json).
 */
function authToken() {
  if (process.env.LOCALSTACK_AUTH_TOKEN) return process.env.LOCALSTACK_AUTH_TOKEN;
  const file = path.join(homedir(), '.localstack', 'auth.json');
  if (existsSync(file)) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      const token = saved.LOCALSTACK_AUTH_TOKEN ?? saved.token ?? Object.values(saved).find((v) => typeof v === 'string' && v.startsWith('ls-'));
      if (token) return token;
    } catch {
      // archivo ilegible: se trata como ausente
    }
  }
  return '';
}

/** Primera IPv4 privada que no sea de Docker/WSL/loopback: la que ve la tablet. */
function detectHostIp() {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/vEthernet|WSL|docker|Loopback|VirtualBox/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) {
        return a.address;
      }
    }
  }
  return 'localhost';
}

function tflocal(root, subcommand) {
  run(`tflocal -chdir="${INFRA[root]}" ${subcommand}`);
}

/** Un corte a medias puede dejar el override de tflocal; nunca debe quedar. */
function removeOverrides() {
  for (const dir of Object.values(INFRA)) {
    const file = path.join(dir, 'localstack_providers_override.tf');
    if (existsSync(file)) unlinkSync(file);
  }
}

async function waitForLocalStack() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return await res.json();
    } catch {
      // aún arrancando
    }
    // Si el contenedor ya murió (token inválido, licencia), no tiene sentido
    // seguir esperando: se enseña el motivo y se para.
    const state = capture(`${COMPOSE} ps --format "{{.State}}" localstack`);
    if (state && state !== 'running' && state !== 'starting') {
      run(`${COMPOSE} logs --no-color --tail=15 localstack`);
      fail(`el contenedor de LocalStack terminó (${state}). Arriba está el motivo.`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail('LocalStack no respondió en 2 minutos. Mira: docker compose -f docker-compose.localstack.yml logs localstack');
}

// --- --down ------------------------------------------------------------------
if (args.has('--down')) {
  run(`${COMPOSE} down`);
  removeOverrides();
  process.exit(0);
}

// --- requisitos ---------------------------------------------------------------
log('Comprobando herramientas');
for (const tool of ['docker', 'terraform', 'tflocal']) {
  if (capture(`${tool} --version`) === null && capture(`${tool} version`) === null) {
    fail(`${tool} no está en el PATH. tflocal: pip install terraform-local`);
  }
}
if (capture('docker info') === null) {
  fail('El engine de Docker no responde. Arranca Docker Desktop y espera a que diga "running".');
}
if (!authToken()) {
  fail(
    [
      'Falta el token de LocalStack. Desde 2025 el contenedor no arranca sin él, tampoco en el plan gratuito.',
      '  1. Cuenta en https://app.localstack.cloud (plan Hobby: gratis, solo uso no comercial)',
      '  2. Copia el token de https://app.localstack.cloud/workspace/auth-tokens',
      '  3. localstack auth set-token <token>      (o exporta LOCALSTACK_AUTH_TOKEN)',
    ].join(String.fromCharCode(10))
  );
}

const hostIp = localstackEnv().HOST_IP;
console.log(`  HOST_IP = ${hostIp} (la IP que verá la tablet; exporta HOST_IP para forzar otra)`);

// --- 1. LocalStack ---------------------------------------------------------------
if (!args.has('--infra')) {
  log('LocalStack');
  run(`${COMPOSE} up -d localstack`);
}

log('Esperando a LocalStack');
const health = await waitForLocalStack();
const edition = health?.edition ?? 'desconocida';
console.log(`  edición: ${edition}`);
if (edition !== 'pro' && edition !== 'enterprise') {
  console.log('  Community: Cognito, API Gateway v2 y ECR no están. Cognito queda simulado en el API.');
}

// --- 2. bootstrap: bucket del estado, dentro de LocalStack ------------------------
log('infra/bootstrap con tflocal (workspace localstack)');
removeOverrides();
tflocal('bootstrap', 'init -input=false');
tflocal('bootstrap', 'workspace select -or-create localstack');
tflocal('bootstrap', 'apply -auto-approve -input=false');

// --- 3. platform ---------------------------------------------------------------------
log('infra/platform con tflocal');
// -reconfigure porque el mismo directorio se inicializa contra AWS con deploy.mjs.
// use_lockfile=false: es una prueba local sin concurrencia, y ahorra depender de
// que la emulación de escrituras condicionales de S3 esté al día.
tflocal(
  'platform',
  `init -reconfigure -input=false -backend-config="bucket=${STATE_BUCKET}" -backend-config="region=${REGION}" -backend-config="use_lockfile=false"`
);
tflocal('platform', 'apply -auto-approve -input=false -var-file=localstack.tfvars');
removeOverrides();

// --- 4. API ---------------------------------------------------------------------------
if (!args.has('--infra')) {
  log('API (Express) contra LocalStack');
  run(`${COMPOSE} up -d --build api`);
}

log('Listo');
console.log(`
  API:                http://${hostIp}:3000/health
  DynamoDB / S3:      http://${hostIp}:4566   (awslocal dynamodb list-tables · awslocal s3 ls)
  Tabla:              consent_audit_logs (GSI1, GSI2)
  Bucket:             medical-consent-pdfs-local

  En el .env.local de la app móvil:
    EXPO_PUBLIC_API_URL=http://${hostIp}:3000

  Login de prueba (Cognito simulado): demo@acrvitallaboral.com / Demo1234!
  Logs del API:       docker compose -f docker-compose.localstack.yml logs -f api
`);
