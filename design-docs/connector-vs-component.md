# Connector vs Component

A connector connects Icecream Sheets to a separate third-party service and requires authentication. A component is native, first-party Icecream Sheets code. IMPORTDATA, IMPORTFEED, IMPORTHTML, IMPORTXML and IMAGE use the Fetch component in the adapter layer with no authentication. Email uses the Mail connector. GOOGLEFINANCE, GOOGLETRANSLATE, DETECTLANGUAGE and IMPORTRANGE use Google connectors.

## Authentication per connector (clarified 2026-10-18)

"Requires authentication" means the connector authenticates to the third-party
service with a credential stored in the service vault — never in workbook
bytes, never in the connector spec (which carries only an opaque
`credentialRef`). The per-connector mechanisms:

| Connector | Auth mechanism |
|---|---|
| Mail connector | OAuth2 (user's mail provider) via vault credentialRef |
| Google connectors (GOOGLEFINANCE, GOOGLETRANSLATE, DETECTLANGUAGE, IMPORTRANGE) | OAuth2 / API key via vault credentialRef |
| Market-data connector (STOCKHISTORY) | API key via vault credentialRef; the Stooq default needs no key |
| SQL connector | Driver-supplied credentials via vault credentialRef |
| REST API connector | Per-spec auth: bearer/API-key via vault credentialRef, or none for public endpoints |
| CSV/JSON URL connectors | None (public URLs only; http(s) enforced at validation) |

The Fetch component (IMPORTDATA, IMPORTFEED, IMPORTHTML, IMPORTXML, IMAGE)
is deliberately **not** a connector: it performs unauthenticated fetches of
public URLs in the adapter layer and never touches the vault.

MCP clients authenticate to the MCP server with MCP's own auth (per the MCP
spec), not the gateway's JWT — see the deployment architecture notes. The
gateway never validates MCP users; it routes MCP traffic to its own ingress.
