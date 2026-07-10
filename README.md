# bin-reporter

A tiny MCP server that reports a missed bin to Barnsley Council
(https://my.barnsley.gov.uk/form/report-a-missed-bin/missed-bin-details) using Playwright to
drive the actual form.

Pre-configured behaviour:
- Address is fixed via env vars (`BIN_HOUSE_NUMBER`, `BIN_POSTCODE`, optionally `BIN_UPRN`).
- Date of missed collection is always today.
- "Was it just your bin or the whole street?" is always answered "Whole street".
- The only thing the tool call needs to collect is the bin **colour**.

## Setup

```
npm install
npx playwright install chromium
```

Set environment variables:
- `BIN_HOUSE_NUMBER` — e.g. `260`
- `BIN_POSTCODE` — e.g. `S75 6GP`
- `BIN_UPRN` (optional) — only needed if the house number/postcode combination matches more
  than one property. Run the `list_addresses` tool to see the matches and their UPRNs.

## Tools

- `list_addresses` — looks up the configured address and returns UPRN matches (useful for
  disambiguating and setting `BIN_UPRN`).
- `report_missed_bin({ colour, dryRun })` — `colour` is one of `Blue`, `Brown`, `Green`, `Grey`.
  Set `dryRun: true` to fill in the form and see the summary without submitting anything.

## Running with Docker

The server listens over HTTP (Streamable HTTP transport) on `/mcp`, protected by OAuth 2.1
(dynamic client registration + authorization code + PKCE), plus an unauthenticated `/healthz`.
`MCP_AUTH_TOKEN` is now only used as a passphrase you enter on the `/authorize` consent page the
first time a client (Claude Code, Claude Desktop, etc.) connects — clients then hold a
short-lived OAuth access token instead of the raw passphrase.

```
cp .env.example .env   # fill in your address, PUBLIC_URL, and a real MCP_AUTH_TOKEN
docker build -t bin-reporter .
docker run -d --name bin-reporter -p 3000:3000 --env-file .env bin-reporter
```

## Registering with Claude Code

Local (stdio):
```
claude mcp add bin-reporter -e BIN_HOUSE_NUMBER=260 -e BIN_POSTCODE="S75 6GP" -- node /Users/aidenellis/bin-reporter/src/index.js
```

Hosted (HTTP, OAuth):
```
claude mcp add --transport http bin-reporter https://your-host/mcp
```
This will open a browser to the `/authorize` consent page — enter your `MCP_AUTH_TOKEN`
passphrase to approve.

## Registering with Claude Desktop

Settings → Connectors → Add custom connector → paste `https://your-host/mcp` as the URL. Claude
Desktop will redirect you to the consent page to approve with your passphrase.

## CI/CD

`.github/workflows/docker-publish.yml` builds and pushes the image to
`ghcr.io/<owner>/<repo>` on every push to `main`. GHCR packages published via the default
`GITHUB_TOKEN` inherit the repo's visibility on first publish but **you must manually set the
package visibility to Private** afterwards under the package's GitHub settings — the token
can't do this itself, and this image should not be public since it holds the auth secret's
counterpart and can submit real reports on your behalf.
