#!/usr/bin/env node
/**
 * Corre el MVP de ACR Consentimiento Digital en esta máquina, con AWS simulado.
 *
 *   node iniciar-mvp.mjs            instala dependencias y arranca todo
 *   node iniciar-mvp.mjs --check    solo comprueba que todo arranca y se detiene
 *   node iniciar-mvp.mjs --ayuda    opciones
 *
 * Arranca tres piezas:
 *   1. API (puerto 3000) con Cognito, S3 y la evidencia simulados en memoria.
 *      Crea un usuario con acceso a la app y a la web de consulta, y siembra
 *      formularios y consentimientos de ejemplo. No toca AWS aunque esta
 *      máquina tenga credenciales configuradas.
 *   2. Web de consulta (puerto 5173): http://localhost:5173
 *   3. App de tableta con Expo (puerto 8081): muestra un código QR para abrirla
 *      en un teléfono o tableta con la app Expo Go, en la misma red Wi-Fi.
 *
 * El MVP real está desplegado en AWS; este modo existe para evaluarlo sin
 * cuenta de AWS. Solo usa módulos de Node: no necesita instalar nada antes.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIRS = {
  api: path.join(ROOT, 'API GATEWAY'),
  web: path.join(ROOT, 'WEB PDF CHECK', 'my-app'),
  app: path.join(ROOT, 'CONCENTIMIENTO_INFORMADO'),
};
const PORTS = { api: 3000, web: 5173, app: 8081 };
const LOGS = path.join(ROOT, '.mvp');
const APP_REPO = 'https://github.com/Tw3kda/ACR_Concentimiento-Informado.git';

// --- opciones ------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (flag('--ayuda') || flag('--help') || flag('-h')) {
  console.log(`
Uso: node iniciar-mvp.mjs [opciones]

  --check            Instala, arranca el API y la web, verifica que respondan y se detiene.
  --sin-app          Arranca solo el API y la web (sin Expo).
  --reinstalar       Vuelve a instalar las dependencias aunque ya estén.
  --ip <dirección>   IP de esta máquina en la red Wi-Fi (si la detectada no es la correcta).
  --usuario <correo> Usuario de prueba (por defecto profesor@acr.test).
  --clave <clave>    Su contraseña (por defecto Profesor2026).
`);
  process.exit(0);
}

const USER = {
  email: (option('--usuario') ?? 'profesor@acr.test').toLowerCase(),
  password: option('--clave') ?? 'Profesor2026',
  name: 'Profesor Evaluador',
};
const CHECK = flag('--check');
const WITH_APP = !CHECK && !flag('--sin-app');

// --- salida --------------------------------------------------------------------

const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const cyan = paint(36);

const step = (msg) => console.log(`\n${cyan('▶')} ${bold(msg)}`);
const ok = (msg) => console.log(`  ${green('✓')} ${msg}`);
const warn = (msg) => console.log(`  ${yellow('!')} ${msg}`);

function fail(msg, hint) {
  console.error(`\n${red('✗')} ${bold(msg)}`);
  if (hint) console.error(`  ${hint.split('\n').join('\n  ')}`);
  cleanup();
  process.exit(1);
}

// --- procesos hijos ------------------------------------------------------------

const children = [];
let cleaning = false;

function cleanup() {
  if (cleaning) return;
  cleaning = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill();
  }
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('exit', cleanup);

function run(command, cwd) {
  return new Promise((resolve) => {
    // npm es un .cmd en Windows: solo se lanza con shell.
    const child = spawn(command, { cwd, shell: true, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

function startLogged(name, file, argv, cwd, env) {
  const log = fs.openSync(path.join(LOGS, `${name}.log`), 'w');
  const child = spawn(process.execPath, [file, ...argv], { cwd, env, stdio: ['ignore', log, log] });
  children.push(child);
  child.on('exit', (code) => {
    if (!cleaning) {
      fail(
        `El proceso "${name}" se detuvo (código ${code}).`,
        `Revise el registro: ${path.join(LOGS, `${name}.log`)}\n${tail(name)}`,
      );
    }
  });
  return child;
}

function tail(name, lines = 15) {
  try {
    return fs.readFileSync(path.join(LOGS, `${name}.log`), 'utf8').trim().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

// --- comprobaciones --------------------------------------------------------------

function checkNode() {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const v = major * 1e6 + minor * 1e3 + patch;
  const supported =
    (major === 20 && v >= 20019004) || (major === 22 && v >= 22013000) || (major === 24 && v >= 24003000) || major >= 25;
  if (!supported) {
    fail(
      `Node.js ${process.versions.node} no es compatible.`,
      'Instale Node.js 22 LTS o 24 LTS desde https://nodejs.org y vuelva a ejecutar este script.\n' +
        'Windows: winget install OpenJS.NodeJS.LTS · macOS: brew install node@22',
    );
  }
  ok(`Node.js ${process.versions.node}`);
}

function checkSources() {
  for (const [name, dir] of Object.entries(DIRS)) {
    if (!fs.existsSync(path.join(dir, 'package.json'))) {
      const hint =
        name === 'app'
          ? `La app es un repositorio aparte. Desde la carpeta del proyecto:\n  git clone ${APP_REPO} CONCENTIMIENTO_INFORMADO`
          : 'Descargue el proyecto completo (el .zip entregado o el repositorio).';
      fail(`Falta la carpeta ${path.relative(ROOT, dir)}.`, hint);
    }
  }
  ok('Código del API, la web y la app');
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port);
  });
}

async function checkPorts() {
  const wanted = WITH_APP ? PORTS : { api: PORTS.api, web: PORTS.web };
  for (const [name, port] of Object.entries(wanted)) {
    if (!(await portFree(port))) {
      fail(
        `El puerto ${port} (${name}) está ocupado.`,
        '¿Quedó abierta otra ejecución del MVP? Ciérrela (Ctrl+C en su ventana) y vuelva a intentar.',
      );
    }
  }
  ok(`Puertos libres: ${Object.values(wanted).join(', ')}`);
}

/** IPv4 de la red local, la que el teléfono usa para llegar al API y a Expo. */
function lanAddress() {
  const forced = option('--ip');
  if (forced) return forced;
  const virtual = /vethernet|virtualbox|vmware|wsl|docker|hyper-v|vboxnet|utun|bridge|tailscale|zerotier/i;
  const candidates = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const priv = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      candidates.push({ address: a.address, score: (priv ? 2 : 0) + (virtual.test(ifname) ? -3 : 0) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.address ?? '127.0.0.1';
}

// --- dependencias --------------------------------------------------------------

/**
 * `npm ci` (o `npm install` si falla) cuando no hay node_modules, cuando cambió el
 * package-lock.json o cuando node_modules se instaló en otro sistema operativo
 * (copiado dentro de un .zip): los binarios nativos de Vite y Expo no sirven
 * entre Windows, macOS y Linux.
 */
async function install(name, dir) {
  const lock = path.join(dir, 'package-lock.json');
  const marker = path.join(dir, 'node_modules', '.acr-mvp-install.json');
  const lockHash = fs.existsSync(lock) ? createHash('sha256').update(fs.readFileSync(lock)).digest('hex') : '';
  const expected = JSON.stringify({ platform: process.platform, arch: process.arch, lockHash });

  const current = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
  if (current === expected && !flag('--reinstalar')) {
    ok(`Dependencias ${name} ya instaladas`);
    return;
  }

  console.log(`  Instalando dependencias ${name} (la primera vez tarda unos minutos)…`);
  const npmFlags = '--no-audit --no-fund --loglevel=error';
  let code = fs.existsSync(lock) ? await run(`npm ci ${npmFlags}`, dir) : 1;
  if (code !== 0) code = await run(`npm install ${npmFlags}`, dir);
  if (code !== 0) {
    fail(`No se pudieron instalar las dependencias ${name}.`, 'Revise la conexión a Internet y vuelva a ejecutar con --reinstalar.');
  }
  fs.writeFileSync(marker, expected);
  ok(`Dependencias ${name} instaladas`);
}

// --- arranque ------------------------------------------------------------------

async function waitFor(url, label, seconds = 60) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // todavía no escucha
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  fail(`${label} no respondió en ${seconds} s.`, tail(label === 'API' ? 'api' : 'web'));
}

async function api(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(`http://127.0.0.1:${PORTS.api}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function startApi(ip) {
  const origins = [PORTS.web, PORTS.app].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`, `http://${ip}:${p}`]);
  const env = { ...process.env };
  // Que nada de esta máquina lo apunte a AWS real.
  for (const key of Object.keys(env)) {
    if (/^(COGNITO_|PDF_BUCKET|EVIDENCE_BUCKET|AUTH_READER_GROUP)/.test(key)) delete env[key];
  }
  Object.assign(env, {
    NODE_ENV: 'development',
    PORT: String(PORTS.api),
    COGNITO_DRIVER: 'stub',
    EVIDENCE_DRIVER: 'stub',
    S3_DRIVER: 'stub',
    STUB_SEED_EMAIL: USER.email,
    STUB_SEED_PASSWORD: USER.password,
    STUB_SEED_NAME: USER.name,
    STUB_SEED_CONSENTS: 'true',
    CORS_ALLOWED_ORIGINS: origins.join(','),
    TRACE_COLORS: 'false',
  });
  return startLogged('api', 'src/local.js', [], DIRS.api, env);
}

function startWeb() {
  const vite = path.join(DIRS.web, 'node_modules', 'vite', 'bin', 'vite.js');
  const env = { ...process.env, VITE_API_URL: `http://localhost:${PORTS.api}` };
  return startLogged('web', vite, ['--host', '--port', String(PORTS.web), '--strictPort'], DIRS.web, env);
}

function startExpo(ip) {
  const cli = path.join(DIRS.app, 'node_modules', 'expo', 'bin', 'cli');
  const env = {
    ...process.env,
    // Gana sobre los .env de la app: el teléfono llega al API por la IP de la red local.
    EXPO_PUBLIC_API_URL: `http://${ip}:${PORTS.api}`,
    REACT_NATIVE_PACKAGER_HOSTNAME: ip,
  };
  delete env.CI; // con CI=true Expo no muestra el QR ni acepta teclas
  // --clear: las variables EXPO_PUBLIC_* quedan dentro del bundle; sin limpiar la
  // caché, una URL de una ejecución anterior podría seguir en uso.
  const child = spawn(process.execPath, [cli, 'start', '--clear', '--port', String(PORTS.app)], {
    cwd: DIRS.app,
    env,
    stdio: 'inherit',
  });
  children.push(child);
  child.on('exit', (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
}

function banner(ip) {
  const line = '─'.repeat(68);
  console.log(`
${line}
${bold('  ACR Consentimiento Digital — MVP en modo local (AWS simulado)')}
${line}
  ${bold('Usuario de prueba')} (app y web):  ${cyan(USER.email)}  /  ${cyan(USER.password)}
  ${bold('Web de consulta')}:  ${cyan(`http://localhost:${PORTS.web}`)}
  ${bold('API')}:              http://localhost:${PORTS.api}   (desde el teléfono: http://${ip}:${PORTS.api})
  ${bold('Cédulas de ejemplo')}: 1018293847 (Laura Gómez Pérez) · 79845123 (Carlos Ruiz Díaz)
  ${bold('Registros')}:        ${path.relative(ROOT, LOGS)}${path.sep}api.log · web.log
${line}`);
  if (!WITH_APP) return;
  console.log(`
  ${bold('App en el teléfono o la tableta (recomendado):')}
    1. Instale "Expo Go" desde Google Play o la App Store.
    2. Conecte el dispositivo a la misma red Wi-Fi que este computador.
    3. Android: abra Expo Go y toque "Scan QR code".  iPhone/iPad: use la cámara.
    4. Escanee el código QR que aparece abajo e inicie sesión con el usuario de prueba.
  ${bold('En el navegador:')} presione ${bold('w')}. Sirve para recorrer las pantallas, pero ahí el
    PDF se abre en el diálogo de impresión y no se envía al API: para el flujo
    completo use Expo Go.
  ${bold('Detener todo:')} Ctrl+C
${line}
`);
}

// --- principal -----------------------------------------------------------------

async function main() {
  console.log(bold('\nACR Consentimiento Digital — arranque del MVP con AWS simulado'));

  step('1/4 Comprobaciones');
  checkNode();
  checkSources();
  await checkPorts();
  const ip = lanAddress();
  if (ip === '127.0.0.1') warn('No se encontró una red local: el teléfono no podrá conectarse (use --sin-app o la vista web).');
  else ok(`IP de esta máquina en la red local: ${ip}`);

  fs.mkdirSync(LOGS, { recursive: true });
  fs.writeFileSync(path.join(LOGS, '.gitignore'), '*\n');

  step('2/4 Dependencias');
  await install('del API', DIRS.api);
  await install('de la web', DIRS.web);
  await install('de la app', DIRS.app);

  step('3/4 API simulado y usuario de prueba');
  startApi(ip);
  await waitFor(`http://127.0.0.1:${PORTS.api}/health`, 'API');
  ok(`API escuchando en el puerto ${PORTS.api}`);
  const login = await api('/auth/login', { method: 'POST', body: { email: USER.email, password: USER.password } });
  if (login.status !== 200 || !login.body?.token) fail('El usuario de prueba no pudo iniciar sesión.', JSON.stringify(login.body));
  ok(`Usuario ${USER.email} creado, con acceso a la app y a la web de consulta`);
  const templates = await api('/templates', { token: login.body.token });
  const codes = (templates.body?.templates ?? []).map((t) => `${t.code} v${t.version}`);
  if (templates.status !== 200 || codes.length === 0) fail('El API no devolvió formularios.', JSON.stringify(templates.body));
  ok(`Formularios publicados: ${codes.join(', ')}; consentimientos de ejemplo sembrados`);

  step('4/4 Web de consulta' + (WITH_APP ? ' y app con Expo' : ''));
  startWeb();
  await waitFor(`http://127.0.0.1:${PORTS.web}/`, 'web');
  ok(`Web de consulta en http://localhost:${PORTS.web}`);

  if (CHECK) {
    const cli = path.join(DIRS.app, 'node_modules', 'expo', 'bin', 'cli');
    if (!fs.existsSync(cli)) fail('No se encontró Expo CLI en la app.', 'Ejecute con --reinstalar.');
    ok('Expo CLI disponible');
    console.log(`\n${green(bold('Todo listo.'))} Ejecute ${bold('node iniciar-mvp.mjs')} para usar el MVP.\n`);
    cleanup();
    process.exit(0);
  }

  banner(ip);
  if (WITH_APP) startExpo(ip);
  else console.log('  API y web en marcha. Ctrl+C para detener.\n');
}

main().catch((err) => fail('Error inesperado.', err?.stack ?? String(err)));
