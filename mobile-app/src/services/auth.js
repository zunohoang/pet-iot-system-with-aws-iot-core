import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserAttribute,
} from 'amazon-cognito-identity-js';
import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

const { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID } = Constants.expoConfig.extra;

const userPool = new CognitoUserPool({
  UserPoolId: COGNITO_USER_POOL_ID,
  ClientId:   COGNITO_CLIENT_ID,
});

/** Sign in and return { idToken, accessToken, refreshToken } */
export function signIn(username, password) {
  return new Promise((resolve, reject) => {
    const authDetails = new AuthenticationDetails({
      Username: username,
      Password: password,
    });
    const cognitoUser = new CognitoUser({ Username: username, Pool: userPool });

    cognitoUser.authenticateUser(authDetails, {
      onSuccess: async (session) => {
        const tokens = {
          idToken:      session.getIdToken().getJwtToken(),
          accessToken:  session.getAccessToken().getJwtToken(),
          refreshToken: session.getRefreshToken().getToken(),
          userId:       session.getIdToken().payload.sub,
          email:        session.getIdToken().payload.email,
        };
        await SecureStore.setItemAsync('auth_tokens', JSON.stringify(tokens));
        resolve(tokens);
      },
      onFailure: reject,
      newPasswordRequired: (attrs) => reject({ code: 'NEW_PASSWORD_REQUIRED', attrs }),
    });
  });
}

/** Sign up a new user */
export function signUp(username, password, email) {
  return new Promise((resolve, reject) => {
    const attributes = [
      new CognitoUserAttribute({ Name: 'email', Value: email }),
    ];
    userPool.signUp(username, password, attributes, null, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

/** Confirm sign up with verification code */
export function confirmSignUp(username, code) {
  return new Promise((resolve, reject) => {
    const cognitoUser = new CognitoUser({ Username: username, Pool: userPool });
    cognitoUser.confirmRegistration(code, true, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

/** Get current session tokens from SecureStore */
export async function getTokens() {
  const raw = await SecureStore.getItemAsync('auth_tokens');
  return raw ? JSON.parse(raw) : null;
}

/** Sign out and clear local tokens */
export async function signOut() {
  await SecureStore.deleteItemAsync('auth_tokens');
  const current = userPool.getCurrentUser();
  if (current) current.signOut();
}

/** Get currently authenticated user's sub (userId) */
export async function getCurrentUserId() {
  const tokens = await getTokens();
  return tokens?.userId || null;
}
