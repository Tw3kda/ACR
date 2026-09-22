# =============================================================================
# API de consentimiento informado — imagen de ejecución
#
# Dos destinos en un mismo archivo:
#
#   runtime  (por defecto)  Express escuchando en :3000. Es lo que se usa para
#                           desarrollo, para que la app de Expo apunte a algo
#                           real, y lo que serviría si mañana esto corre en
#                           ECS/Fargate en vez de en Lambda.
#
#   lambda                  Imagen base de AWS Lambda con el handler del
#                           gateway. Sirve para probar el handler *de verdad*
#                           —evento payload 2.0 incluido— con el emulador de
#                           runtime, sin desplegar nada.
#
#   docker build -t acr-api .
#   docker run --rm -p 3000:3000 --env-file .env acr-api
#
#   docker build -t acr-api-lambda --target lambda .
#   docker run --rm -p 9000:8080 acr-api-lambda
#   curl -s "http://localhost:9000/2015-03-31/functions/function/invocations" \
#        -d @scripts/evento-ejemplo.json
#
# Sin variables de entorno arranca con los adaptadores simulados e imprime en
# consola todo lo que recibe y lo que responde.
# =============================================================================

# --- Dependencias ------------------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /app

# Solo los manifiestos: mientras no cambien, esta capa se reutiliza y el
# `npm ci` no se vuelve a ejecutar en cada build.
COPY package.json package-lock.json ./

RUN npm ci --omit=dev && npm cache clean --force


# --- Servidor Express --------------------------------------------------------
FROM node:22-alpine AS runtime

# `dumb-init` como PID 1: sin él, Node no recibe SIGTERM y el contenedor tarda
# diez segundos en morir en cada `docker stop`.
RUN apk add --no-cache dumb-init

# ALLOW_STUB_IN_PRODUCTION: este contenedor no es Lambda. Sin AWS detrás, los
#   adaptadores simulados son la única forma de que arranque, y hay que
#   autorizarlo de forma explícita porque el código se niega a hacerlo solo con
#   NODE_ENV=production. Quítelo en cuanto el .env apunte a recursos reales.
# TRACE_IO: mientras no haya conexión con los servicios, todo lo recibido y lo
#   enviado sale por consola.
ENV NODE_ENV=production \
    PORT=3000 \
    ALLOW_STUB_IN_PRODUCTION=true \
    TRACE_IO=true \
    LOG_LEVEL=info

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts

# La imagen de Node ya trae el usuario `node` (uid 1000). Nada aquí necesita
# root, y el proceso no escribe en el sistema de archivos.
USER node

EXPOSE 3000

# `/health` dice además qué adaptador está activo en cada servicio.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/local.js"]


# --- Lambda (emulador de runtime) --------------------------------------------
FROM public.ecr.aws/lambda/nodejs:22 AS lambda

# Mismas dos salvedades que arriba, y por el mismo motivo.
ENV ALLOW_STUB_IN_PRODUCTION=true \
    TRACE_IO=true

COPY --from=deps /app/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY package.json ${LAMBDA_TASK_ROOT}/
COPY src ${LAMBDA_TASK_ROOT}/src

CMD ["src/handlers/api.handler"]
