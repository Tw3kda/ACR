/**
 * Selector de adaptador. Cada servicio de AWS tiene dos implementaciones con la
 * misma superficie: `*.aws.js` (real, SDK v3) y `*.stub.js` (memoria).
 *
 * La elección es por variable de entorno y se resuelve una sola vez, en el
 * arranque en frío del contenedor. Cuando la infraestructura exista, basta
 * definir COGNITO_USER_POOL_ID / EVIDENCE_BUCKET / PDF_BUCKET: el driver pasa a
 * `aws` solo, sin tocar código.
 */
import config, { stubbedDrivers } from '../config/env.js';
import logger from '../lib/logger.js';

import * as cognitoAws from './cognito.aws.js';
import * as cognitoStub from './cognito.stub.js';
import * as evidenceAws from './evidence.aws.js';
import * as evidenceStub from './evidence.stub.js';
import * as s3Aws from './s3.aws.js';
import * as s3Stub from './s3.stub.js';

export const cognito = config.cognito.driver === 'aws' ? cognitoAws : cognitoStub;
export const evidence = config.evidence.driver === 'aws' ? evidenceAws : evidenceStub;
export const s3 = config.s3.driver === 'aws' ? s3Aws : s3Stub;

const stubs = stubbedDrivers();
if (stubs.length > 0) {
  logger.warn('Adaptadores en modo simulado: no se está escribiendo en AWS', {
    stubbed: stubs,
    cognito: config.cognito.driver,
    evidence: config.evidence.driver,
    s3: config.s3.driver,
  });
}

export default { cognito, evidence, s3 };
