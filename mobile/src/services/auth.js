import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserAttribute,
} from "amazon-cognito-identity-js";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";

const { COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID } = Constants.expoConfig.extra;

console.log("[auth] config loaded", {
  hasUserPoolId: Boolean(COGNITO_USER_POOL_ID),
  hasClientId: Boolean(COGNITO_CLIENT_ID),
});

const userPool = new CognitoUserPool({
  UserPoolId: COGNITO_USER_POOL_ID,
  ClientId: COGNITO_CLIENT_ID,
});

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function withTimeout(promise, timeoutMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

async function probeCognitoNetwork() {
  const region = String(COGNITO_USER_POOL_ID || "").split("_")[0] || "ap-southeast-1";
  const url = `https://cognito-idp.${region}.amazonaws.com/`;
  const startedAt = Date.now();
  try {
    await withTimeout(
      fetch(url, { method: "POST", headers: { "Content-Type": "application/x-amz-json-1.1" }, body: "{}" }),
      8000,
      "Network probe timeout"
    );
    console.log("[auth] network probe ok", { elapsedMs: Date.now() - startedAt, region });
    return true;
  } catch (e) {
    console.error("[auth] network probe failed", {
      elapsedMs: Date.now() - startedAt,
      region,
      message: e?.message,
    });
    return false;
  }
}

/** Sign in and return { idToken, accessToken, refreshToken } */
export function signIn(username, password) {
  const normalizedUsername = normalizeUsername(username);
  const startedAt = Date.now();
  console.log("[auth] signIn start", {
    usernameLength: normalizedUsername.length,
    hasPassword: Boolean(password),
  });
  return new Promise((resolve, reject) => {
    if (!normalizedUsername || !password) {
      reject(new Error("Username and password are required"));
      return;
    }

    (async () => {
      const networkOk = await probeCognitoNetwork();
      if (!networkOk) {
        reject(
          new Error(
            "Cannot reach Cognito endpoint. Check phone internet/VPN/Private DNS and try again."
          )
        );
        return;
      }

      const authDetails = new AuthenticationDetails({
        Username: normalizedUsername,
        Password: password,
      });
      const cognitoUser = new CognitoUser({
        Username: normalizedUsername,
        Pool: userPool,
      });
      // More stable in RN/Expo than SRP default flow.
      cognitoUser.setAuthenticationFlowType("USER_PASSWORD_AUTH");

      let settled = false;
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };

      const timeout = setTimeout(() => {
        finish(() => {
          console.error("[auth] signIn timeout", {
            elapsedMs: Date.now() - startedAt,
          });
          reject(
            new Error(
              "Authentication timeout. Network to Cognito is unstable, please try again."
            )
          );
        });
      }, 30000);

      cognitoUser.authenticateUser(authDetails, {
        onSuccess: async (session) => {
          finish(async () => {
            clearTimeout(timeout);
            console.log("[auth] signIn success", {
              elapsedMs: Date.now() - startedAt,
              hasIdToken: Boolean(session.getIdToken()?.getJwtToken()),
              hasAccessToken: Boolean(session.getAccessToken()?.getJwtToken()),
              hasRefreshToken: Boolean(session.getRefreshToken()?.getToken()),
            });
            const tokens = {
              idToken: session.getIdToken().getJwtToken(),
              accessToken: session.getAccessToken().getJwtToken(),
              refreshToken: session.getRefreshToken().getToken(),
              userId: session.getIdToken().payload.sub,
              email: session.getIdToken().payload.email,
            };
            await SecureStore.setItemAsync("auth_tokens", JSON.stringify(tokens));
            console.log("[auth] tokens saved to SecureStore");
            resolve(tokens);
          });
        },
        onFailure: (err) => {
          finish(() => {
            clearTimeout(timeout);
            console.error("[auth] signIn failed", {
              elapsedMs: Date.now() - startedAt,
              name: err?.name,
              code: err?.code,
              message: err?.message,
            });
            reject(err);
          });
        },
        newPasswordRequired: (attrs) => {
          finish(() => {
            clearTimeout(timeout);
            console.warn("[auth] newPasswordRequired", {
              elapsedMs: Date.now() - startedAt,
              attrKeys: Object.keys(attrs || {}),
            });
            reject({ code: "NEW_PASSWORD_REQUIRED", attrs });
          });
        },
      });
    })().catch(reject);
  });
}

/** Sign up a new user */
export function signUp(username, password, email) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedEmail = normalizeEmail(email);

  return new Promise((resolve, reject) => {
    if (!normalizedUsername || !normalizedEmail || !password) {
      reject(new Error("Username, email and password are required"));
      return;
    }

    const attributes = [
      new CognitoUserAttribute({ Name: "email", Value: normalizedEmail }),
    ];
    userPool.signUp(
      normalizedUsername,
      password,
      attributes,
      null,
      (err, result) => {
      if (err) return reject(err);
      resolve(result);
      }
    );
  });
}

/** Confirm sign up with verification code */
export function confirmSignUp(username, code) {
  const normalizedUsername = normalizeUsername(username);
  return new Promise((resolve, reject) => {
    const cognitoUser = new CognitoUser({
      Username: normalizedUsername,
      Pool: userPool,
    });
    cognitoUser.confirmRegistration(code, true, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

/** Get current session tokens from SecureStore */
export async function getTokens() {
  const raw = await SecureStore.getItemAsync("auth_tokens");
  console.log("[auth] getTokens", { found: Boolean(raw) });
  return raw ? JSON.parse(raw) : null;
}

/** Sign out and clear local tokens */
export async function signOut() {
  console.log("[auth] signOut start");
  await SecureStore.deleteItemAsync("auth_tokens");
  const current = userPool.getCurrentUser();
  if (current) current.signOut();
  console.log("[auth] signOut done");
}

/** Get currently authenticated user's sub (userId) */
export async function getCurrentUserId() {
  const tokens = await getTokens();
  return tokens?.userId || null;
}
