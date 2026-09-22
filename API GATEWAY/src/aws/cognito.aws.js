import {
  CognitoIdentityProviderClient,
  AdminInitiateAuthCommand,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import config from '../config/env.js';
import { withSecretHash } from '../lib/cognitoSecretHash.js';

// El cliente se crea una sola vez por contenedor: reutiliza conexiones TLS entre
// invocaciones y se lleva la resolución de credenciales al arranque en frío.
let client;
const getClient = () => {
  client ??= new CognitoIdentityProviderClient({
    region: config.cognito.region,
    endpoint: config.cognito.endpoint,
  });
  return client;
};

const { userPoolId, clientId, clientSecret, authFlow } = config.cognito;

export const driver = 'aws';

export async function initiateAuthWithPassword({ username, password }) {
  const res = await getClient().send(
    new AdminInitiateAuthCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      AuthFlow: authFlow,
      AuthParameters: withSecretHash({ USERNAME: username, PASSWORD: password }, username, {
        clientId,
        clientSecret,
      }),
    }),
  );
  return {
    authenticationResult: res.AuthenticationResult ?? null,
    challengeName: res.ChallengeName ?? null,
  };
}

export async function initiateAuthWithRefreshToken({ refreshToken, username }) {
  const res = await getClient().send(
    new AdminInitiateAuthCommand({
      UserPoolId: userPoolId,
      ClientId: clientId,
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      AuthParameters: withSecretHash({ REFRESH_TOKEN: refreshToken }, username ?? '', {
        clientId,
        // Sin username no se puede calcular un SECRET_HASH válido; se omite y
        // Cognito responderá 401, que es exactamente lo que la capa de servicio
        // traduce a "vuelva a iniciar sesión".
        clientSecret: username ? clientSecret : '',
      }),
    }),
  );
  return {
    authenticationResult: res.AuthenticationResult ?? null,
    challengeName: res.ChallengeName ?? null,
  };
}

export async function adminCreateUser({ username, email, name }) {
  const res = await getClient().send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId,
      Username: username,
      // Sin correo de invitación: el registro devuelve la sesión ya iniciada.
      MessageAction: 'SUPPRESS',
      UserAttributes: [
        { Name: 'email', Value: email },
        { Name: 'email_verified', Value: 'true' },
        ...(name ? [{ Name: 'name', Value: name }] : []),
      ],
    }),
  );
  return { username: res.User?.Username ?? username };
}

export async function adminSetPassword({ username, password }) {
  await getClient().send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId,
      Username: username,
      Password: password,
      Permanent: true,
    }),
  );
}

export async function adminGetUser({ username }) {
  const res = await getClient().send(
    new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }),
  );
  const attrs = Object.fromEntries((res.UserAttributes ?? []).map((a) => [a.Name, a.Value]));
  return {
    username: res.Username,
    sub: attrs.sub,
    email: attrs.email,
    name: attrs.name,
    status: res.UserStatus,
  };
}
