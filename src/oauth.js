import crypto from "node:crypto";
import {
  saveOAuthTokens,
  loadOAuthTokens,
  saveOAuthPending,
  consumeOAuthPending
} from "./db.js";

const VENDOR = "sophie";

const CLIENT_ID = process.env.SOPHIE_OAUTH_CLIENT_ID;
const REDIRECT_URI =
  process.env.SOPHIE_OAUTH_REDIRECT_URI ||
  "http://127.0.0.1:8787/oauth/callback";

const SCOPE = process.env.SOPHIE_OAUTH_SCOPE || "mcp:full";

const AUTHORIZATION_URL =
  process.env.SOPHIE_OAUTH_AUTHORIZATION_URL ||
  "https://hub.sophiesociety.com/oauth/authorize";

const TOKEN_URL =
  process.env.SOPHIE_OAUTH_TOKEN_URL ||
  "https://api-hub.sophiesociety.com/oauth/token";

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createCodeVerifier() {
  return base64url(crypto.randomBytes(32));
}

function createCodeChallenge(verifier) {
  return base64url(
    crypto.createHash("sha256").update(verifier).digest()
  );
}

function createState() {
  return base64url(crypto.randomBytes(32));
}

async function saveTokens(tokens) {
  await saveOAuthTokens(VENDOR, tokens);
}

async function loadTokens() {
  return loadOAuthTokens(VENDOR);
}

async function exchangeCode(code, codeVerifier) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Sophie OAuth token exchange failed (${response.status}): ${text}`
    );
  }

  const data = JSON.parse(text);

  await saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    token_type: data.token_type || "Bearer",
    expires_at: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : null
  });

  return data;
}

async function refreshAccessToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Sophie OAuth refresh failed (${response.status}): ${text}`
    );
  }

  const data = JSON.parse(text);

  await saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    token_type: data.token_type || "Bearer",
    expires_at: data.expires_in
      ? Date.now() + data.expires_in * 1000
      : null
  });

  return data.access_token;
}

export async function getAuthorizationUrl() {
  if (!CLIENT_ID) {
    throw new Error("Missing SOPHIE_OAUTH_CLIENT_ID in .env");
  }

  const state = createState();
  const codeVerifier = createCodeVerifier();
  const codeChallenge = createCodeChallenge(codeVerifier);

  await saveOAuthPending(VENDOR, state, codeVerifier);

  const url = new URL(AUTHORIZATION_URL);

  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return url.toString();
}

export async function handleOAuthCallback(code, state) {
  const pending = await consumeOAuthPending(VENDOR, state);

  if (!pending) {
    throw new Error(
      "No OAuth authorization is currently pending, or the state did not match."
    );
  }

  if (Date.now() - new Date(pending.created_at).getTime() > 10 * 60 * 1000) {
    throw new Error("OAuth authorization request expired.");
  }

  return exchangeCode(code, pending.code_verifier);
}

export async function getValidAccessToken() {
  const tokens = await loadTokens();

  if (!tokens?.access_token) {
    throw new Error(
      "Sophie OAuth is not configured. Open /oauth/start first."
    );
  }

  // Refresh 60 seconds before expiration.
  if (
    tokens.expires_at &&
    Date.now() >= tokens.expires_at - 60_000
  ) {
    if (!tokens.refresh_token) {
      throw new Error(
        "Sophie access token expired and no refresh token is available."
      );
    }

    return refreshAccessToken(tokens.refresh_token);
  }

  return tokens.access_token;
}

export async function getOAuthStatus() {
  const tokens = await loadTokens();

  if (!tokens?.access_token) {
    return {
      authenticated: false
    };
  }

  return {
    authenticated: true,
    expires_at: tokens.expires_at || null,
    has_refresh_token: Boolean(tokens.refresh_token)
  };
}