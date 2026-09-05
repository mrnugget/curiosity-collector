# curiosity-collector

A calm little inbox for links and thoughts that end up in the
[Joy & Curiosity](https://registerspill.thorstenball.com/) newsletter.
It replaces one long Apple Note: open it, paste, type, done.

- One page. A capture box at the top that is always ready — typing or pasting
  anywhere on the page goes into it. `Enter` adds, `Shift+Enter` makes a new line.
- Notes are freeform text, grouped into **Inbox**, **Intro** and **Later**.
- Every URL in a note gets its title, description and a cleaned URL
  (`utm_*`, `si=`, `s=`, `fbclid`, … stripped) fetched in the background, with
  one-tap `copy title` / `copy url` / `copy md`. YouTube and X go through oEmbed.
- Click a note to edit it in place. `✓ done` archives it (restorable).
- Installable PWA. On Android/Chrome it shows up in the share sheet
  (Web Share Target). iOS has historically not supported share targets; use the
  Shortcut recipe below instead.
- SQLite via Node's built-in `node:sqlite`. No native dependencies.

## Run it

```sh
pnpm install
pnpm dev            # http://localhost:5173, local-only auth bypass when OAuth is unset
```

Production:

```sh
pnpm build
ORIGIN=https://your.host node build   # configure OAuth below first; PORT defaults to 3000
```

Or with Docker (the database lives in the `/data` volume):

```sh
docker build -t curiosity-collector .
docker run -p 3000:3000 -v collector-data:/data \
  --env-file .env -e ORIGIN=https://your.host curiosity-collector
```

### Environment

| Variable             | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `AMP_OAUTH_CLIENT_ID` | Registered Amp server OAuth client ID. |
| `AMP_OAUTH_CLIENT_SECRET` | Registered server client secret; server-only. |
| `AMP_OAUTH_REDIRECT_URI` | Exact registered HTTPS callback URL ending in `/auth/callback` (HTTP allowed only on loopback). |
| `COLLECTOR_SESSION_SECRET` | Random secret of at least 32 characters; encrypts cookies. Rotation signs everyone out. |
| `COLLECTOR_ALLOWED_USER_IDS` | Comma-separated Amp OIDC subject IDs allowed to read/write notes. Empty denies everyone. Not app-owner/admin permissions. |
| `COLLECTOR_SHARE_TOKEN` | Optional separate bearer credential for `/share` only. Setting it disables all legacy password/key sharing. |
| `COLLECTOR_PASSWORD` | Transitional `/share` bearer/key fallback only when `COLLECTOR_SHARE_TOKEN` is unset. Never permits browser login. Both unset disables machine access. |
| `DATABASE_PATH`      | SQLite file. Default `data/collector.db`.                                          |
| `ORIGIN`             | Public URL, required in production for form posts (login, share target).           |
| `PORT`               | Port for `node build`. Default `3000`.                                             |

### Sign in with Amp

The OAuth implementation reuses the existing
[Jelly Bug Tracker](https://ampcode.com/@amp/jelly-bug-tracker) authorization-code
flow: `https://auth.ampcode.com/oauth2/authorize`, `/oauth2/token`, `/oauth2/jwks`,
S256 PKCE, state and nonce. ID tokens are verified against Amp's RSA signing keys,
issuer, audience, expiration and nonce. Requested scopes are `openid profile email
offline_access`; no Git scopes are needed. OAuth tokens live only in encrypted,
HttpOnly session cookies and server memory. Sessions last up to 30 days and refresh
expiring access tokens. Sign-out is `POST /auth/signout` (also available at `/login`).

Register a **server** OAuth client in the owning Amp workspace, after approval:

```sh
amp oauth-clients create --type server --workspace amp --name curiosity-collector \
  --redirect-uri https://curiosity-collector--amp.onamp.dev/auth/callback
```

Configure the client ID/secret, exact redirect URI, session secret and allowed Amp
subject IDs as app environment/secrets before deploying. A signed-in but denied
user can see their own subject ID at `/login`; an administrator must explicitly
allow it. No first-user auto-enrollment. Do not reuse the Jelly client's secret or
registration. Local OAuth testing needs its own registered callback. Plain `pnpm
dev` without an OAuth client retains local unauthenticated use; **production never
uses that bypass**, even without configuration. Do not expose that dev server publicly.

Migration: shared-password login and old `cc_session` cookies are no longer accepted.
For the first rollout, leave `COLLECTOR_SHARE_TOKEN` unset and retain the existing
`COLLECTOR_PASSWORD`: existing Shortcut bearer headers and `/share?key=` links keep
working, but grant no browser login, notes API access, or widget permission.
Coordinate clients before setting `COLLECTOR_SHARE_TOKEN`: setting it immediately
disables the old password and all URL-key authentication. Clients must then send
the new token as a bearer header. Remove `COLLECTOR_PASSWORD` after migration.
Notes and API responses are not
cached, and the service worker no longer stores private HTML for offline use.

Amp identity is not app ownership. Deployed apps do not receive the documented
thread-portal identity headers. Notes allowlists grant no Jellyware widget rights;
app creator/workspace-admin orb permission and runner-owner production permission
must come from the platform's authorized widget contract.

The root server layout calls `GET https://ampcode.com/api/jellyware/context?app=amp/curiosity-collector`
with the server-only OAuth access token. Only an authorized `{widget: {scriptURL,
appID}}` response enables the browser's async platform script; null, errors and
timeouts hide it. Tokens never enter page data. Sending a DOM comment opens an
Amp-owned confirmation page: sign-in alone does not authorize agent execution.

The obelisk builds via `.amp/obelisk.yaml`, runs `node build` with
`ORIGIN=$AMP_DEPLOYMENT_URL`, and stores SQLite at `/home/user/data/collector.db`,
outside `/home/user/workspace/app`, so redeploying the checkout preserves data.
This is not a backup policy; the application has no independent backup/replication.

Verification: `pnpm check` and `pnpm test` (build, OAuth cryptography tests and
production SvelteKit request tests against an in-memory database). These tests do
not substitute for a real registered-client/account consent flow.

## Sharing into it

**Android / desktop Chrome:** install the app (address bar → Install). It then
appears in the system share sheet; shared pages land in the Inbox.

**iOS Shortcut:** create a Shortcut that accepts URLs and Text from the share
sheet with one action, *Get Contents of URL*:

- URL: `https://your.host/share`
- Method: `POST`
- Headers: `Authorization` = `Bearer <COLLECTOR_SHARE_TOKEN>`
- Request Body: JSON, `text` = *Shortcut Input*

**Anything else:** `GET https://your.host/share?text=…&url=…&title=…` with the
`Authorization: Bearer` header. Both redirect to the
app; send `Accept: application/json` to get the created note back instead.

## API

All endpoints require the session cookie (`/login`) or, for `/share`, a bearer token.

```
GET    /api/items            open notes  (?done=1 for archived)
POST   /api/items            { body, bucket? }
PATCH  /api/items/:id        { body?, bucket?, done? }
DELETE /api/items/:id
POST   /share                title/text/url as form fields or JSON
GET    /share?text=…         same, via query string
```
