import { redirect } from "@sveltejs/kit";
import { AUTH_COOKIE } from "$lib/server/auth";
import { SECURE_COOKIES } from "$lib/server/config";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ cookies }) => {
  cookies.delete(AUTH_COOKIE, { path: "/", secure: SECURE_COOKIES });
  redirect(303, "/");
};
