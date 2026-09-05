import { error, redirect } from "@sveltejs/kit";
import {
  encodeOAuthTransaction,
  OAUTH_TRANSACTION_COOKIE,
  TRANSACTION_MAX_AGE_SECONDS,
} from "$lib/server/auth";
import {
  getOAuthConfig,
  oauthConfigurationError,
  SECURE_COOKIES,
} from "$lib/server/config";
import {
  buildAuthorizationURL,
  createOAuthTransaction,
  normalizeReturnTo,
} from "$lib/server/oauth";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ url, cookies }) => {
  const configurationError = oauthConfigurationError();
  if (configurationError) {
    error(503, `Sign in with Amp is not configured: ${configurationError}`);
  }
  const transaction = createOAuthTransaction(
    normalizeReturnTo(url.searchParams.get("returnTo"), "/"),
  );
  cookies.set(OAUTH_TRANSACTION_COOKIE, encodeOAuthTransaction(transaction), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE_COOKIES,
    maxAge: TRANSACTION_MAX_AGE_SECONDS,
  });
  redirect(302, buildAuthorizationURL(getOAuthConfig(), transaction));
};
