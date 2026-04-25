/**
 * Amplify configuration — PubSub / AWS IoT Core only.
 *
 * Auth hiện tại vẫn dùng amazon-cognito-identity-js + SecureStore (không đổi).
 *
 * Chúng ta implement custom credentialsProvider + tokenProvider để:
 *  1. Đọc idToken từ SecureStore (do auth flow hiện tại lưu)
 *  2. Exchange token → STS credentials qua Cognito Identity Pool
 *     (dùng @aws-sdk/client-cognito-identity đã có sẵn)
 *  3. Return credentials để Amplify PubSub dùng cho SigV4 signing
 *
 * Gọi configureAmplify() MỘT LẦN ở App.jsx trước khi render.
 */
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import { Amplify } from 'aws-amplify';
import { ConsoleLogger } from 'aws-amplify/utils';

ConsoleLogger.LOG_LEVEL = 'DEBUG';

import {
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
} from '@aws-sdk/client-cognito-identity';
import { IoTClient, AttachPrincipalPolicyCommand } from '@aws-sdk/client-iot';
import Constants from 'expo-constants';
import { getTokens } from './auth';

const {
  AWS_REGION,
  COGNITO_IDENTITY_POOL_ID,
  COGNITO_USER_POOL_ID,
  COGNITO_CLIENT_ID,
  IOT_ENDPOINT,
} = Constants.expoConfig.extra;

/* ── Credential cache ──────────────────────────────────────────────── */

let _cachedCreds = null;
let _cachedExpiry = 0;

async function fetchIoTCredentials(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _cachedCreds && _cachedExpiry > now + 60_000) {
    return _cachedCreds;
  }

  const tokens = await getTokens();
  if (!tokens?.idToken) throw new Error('Not signed in');

  const loginKey = `cognito-idp.${AWS_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`;
  const logins = { [loginKey]: tokens.idToken };

  const client = new CognitoIdentityClient({ region: AWS_REGION });

  const { IdentityId } = await client.send(
    new GetIdCommand({ IdentityPoolId: COGNITO_IDENTITY_POOL_ID, Logins: logins }),
  );

  const { Credentials } = await client.send(
    new GetCredentialsForIdentityCommand({ IdentityId, Logins: logins }),
  );

  // Attach the AWS IoT Policy to this Cognito Identity ID
  // This is strictly required by AWS IoT Core for WSS/MQTT connections from Cognito
  try {
    const iotClient = new IoTClient({
      region: AWS_REGION,
      credentials: {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretKey,
        sessionToken: Credentials.SessionToken,
      },
    });
    await iotClient.send(
      new AttachPrincipalPolicyCommand({
        policyName: 'iot-smarthome-mobile-user-policy',
        principal: IdentityId,
      })
    );
    console.log('[Amplify] Attached IoT policy to identity', IdentityId);
  } catch (err) {
    console.error('[Amplify] Failed to attach IoT policy:', err?.message || err);
  }

  _cachedCreds = {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretKey,
    sessionToken: Credentials.SessionToken,
    expiration: Credentials.Expiration,
  };
  _cachedExpiry = Credentials.Expiration
    ? new Date(Credentials.Expiration).getTime()
    : now + 60 * 60 * 1000;

  console.log('[Amplify] credentials fetched, expire at', new Date(_cachedExpiry).toISOString());
  return _cachedCreds;
}

/** Custom credentialsProvider injected into Amplify libraryOptions */
const customCredentialsProvider = {
  async getCredentialsAndIdentityId({ forceRefresh }) {
    try {
      const creds = await fetchIoTCredentials(forceRefresh);
      return { credentials: creds };
    } catch (err) {
      console.error('[Amplify] credentialsProvider error:', err?.message);
      throw err;
    }
  },
  clearCredentials() {
    _cachedCreds = null;
    _cachedExpiry = 0;
  },
};

/** Custom tokenProvider — returns stored tokens in Amplify's expected shape */
const customTokenProvider = {
  async getTokens({ forceRefresh } = {}) {
    try {
      const tokens = await getTokens();
      if (!tokens?.idToken) return null;

      // Return minimal token shape that Amplify needs to mark session as "authenticated"
      return {
        accessToken: { toString: () => tokens.accessToken, payload: { sub: tokens.userId } },
        idToken: { toString: () => tokens.idToken, payload: { sub: tokens.userId } },
      };
    } catch {
      return null;
    }
  },
};

/* ── Amplify configure ─────────────────────────────────────────────── */

let configured = false;

export function configureAmplify() {
  if (configured) return;
  configured = true;

  Amplify.configure(
    {
      Auth: {
        Cognito: {
          identityPoolId: COGNITO_IDENTITY_POOL_ID,
          userPoolId: COGNITO_USER_POOL_ID,
          userPoolClientId: COGNITO_CLIENT_ID,
          allowGuestAccess: false,
        },
      },
    },
    {
      Auth: {
        tokenProvider: customTokenProvider,
        credentialsProvider: customCredentialsProvider,
      },
    },
  );

  console.log('[Amplify] configured', {
    region: AWS_REGION,
    identityPool: COGNITO_IDENTITY_POOL_ID?.slice(0, 20) + '...',
    iotEndpoint: IOT_ENDPOINT,
  });
}

/** Expose for mqtt.js to pre-warm credentials cache */
export { fetchIoTCredentials };
export { IOT_ENDPOINT, AWS_REGION };
