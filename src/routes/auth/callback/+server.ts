import { error, redirect } from "@sveltejs/kit";
import {
  AUTH_COOKIE,
  completeOAuthSignIn,
  decodeOAuthTransaction,
  OAUTH_TRANSACTION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "$lib/server/auth";
import {
  getOAuthConfig,
  oauthConfigurationError,
  SECURE_COOKIES,
} from "$lib/server/config";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url, cookies }) => {
  const configurationError = oauthConfigurationError();
  if (configurationError) {
    error(503, `Sign in with Amp is not configured: ${configurationError}`);
  }
  const appOrigin = new URL(getOAuthConfig().redirectURI).origin;

  const transaction = decodeOAuthTransaction(
    cookies.get(OAUTH_TRANSACTION_COOKIE),
  );
  cookies.delete(OAUTH_TRANSACTION_COOKIE, { path: "/", secure: SECURE_COOKIES });
  if (!transaction || url.searchParams.get("state") !== transaction.state) {
    redirectWithError(appOrigin, "/", "invalid_state");
  }
  if (url.searchParams.has("error")) {
    redirectWithError(appOrigin, transaction.returnTo, "access_denied");
  }
  const code = url.searchParams.get("code");
  if (!code) {
    redirectWithError(appOrigin, transaction.returnTo, "missing_code");
  }

  try {
    const { sessionCookie } = await completeOAuthSignIn(
      code,
      transaction.codeVerifier,
      transaction.nonce,
    );
    cookies.set(AUTH_COOKIE, sessionCookie, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: SECURE_COOKIES,
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  } catch (cause) {
    console.error(
      "Sign in with Amp failed:",
      cause instanceof Error ? cause.message : "unknown error",
    );
    redirectWithError(appOrigin, transaction.returnTo, "oauth_failed");
  }
  redirect(303, transaction.returnTo);
};

function redirectWithError(
  baseURL: string,
  returnTo: string,
  code: string,
): never {
  const destination = new URL('/login', baseURL);
  destination.searchParams.set('next', returnTo);
  destination.searchParams.set("auth_error", code);
  redirect(303, `${destination.pathname}${destination.search}${destination.hash}`);
}
