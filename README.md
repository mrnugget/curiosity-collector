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
pnpm dev            # http://localhost:5173, no password, data in data/collector.db
```

Production:

```sh
pnpm build
COLLECTOR_PASSWORD=… ORIGIN=https://your.host node build   # PORT defaults to 3000
```

Or with Docker (the database lives in the `/data` volume):

```sh
docker build -t curiosity-collector .
docker run -p 3000:3000 -v collector-data:/data \
  -e COLLECTOR_PASSWORD=… -e ORIGIN=https://your.host curiosity-collector
```

### Environment

| Variable             | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| `COLLECTOR_PASSWORD` | Single shared password. Unset = no auth (local dev only). Changing it logs out everyone. |
| `DATABASE_PATH`      | SQLite file. Default `data/collector.db`.                                          |
| `ORIGIN`             | Public URL, required in production for form posts (login, share target).           |
| `PORT`               | Port for `node build`. Default `3000`.                                             |

## Sharing into it

**Android / desktop Chrome:** install the app (address bar → Install). It then
appears in the system share sheet; shared pages land in the Inbox.

**iOS Shortcut:** create a Shortcut that accepts URLs and Text from the share
sheet with one action, *Get Contents of URL*:

- URL: `https://your.host/share`
- Method: `POST`
- Headers: `Authorization` = `Bearer <your password>`
- Request Body: JSON, `text` = *Shortcut Input*

**Anything else:** `GET https://your.host/share?text=…&url=…&title=…` with the
`Authorization: Bearer` header (or `&key=<password>`). Both redirect to the
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
