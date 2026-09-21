# FieldOps Assist

FieldOps Assist is a proof of concept for helping field technicians retrieve work-order context, check parts, consult technical knowledge, analyze a photo, and register a completed intervention after explicit confirmation.

The repository provides a locally reproducible MCP service and deterministic tests. Telegram, Copilot Studio, Azure, RAG, and vision require external services and are not required by CI.

## What the repository proves

| Capability | Evidence | Status |
| --- | --- | --- |
| Work-order and inventory MCP tools | Seed data plus automated HTTP/MCP tests | Tested locally |
| Intervention confirmation, assignment checks, idempotency, and concurrent in-process writes | Automated tests using an isolated temporary data directory | Tested locally |
| MCP endpoint authentication | Bearer-key rejection test; startup fails without a key | Tested locally |
| Telegram webhook secret and user allowlist | Deterministic relay tests | Tested locally |
| Relay text dispatch, image-size guard, correlation IDs, and safe asynchronous errors | Deterministic relay tests with injected handlers | Tested locally |
| Telegram, Direct Line, Copilot Studio, RAG, and vision integration | Requires separately configured external services | External-service dependent |
| Azure deployment | Application code and MCP Dockerfile are present; no infrastructure-as-code is included | Deployment-specific |
| Distributed persistence and locking | Not implemented | Planned for a production design |

This project does **not** implement route optimization.

## Architecture and trust boundaries

```text
Telegram
  |
  v
Webhook secret validation
  |
  v
Telegram user allowlist
  |
  v
Relay (Node.js / TypeScript)
  |
  v
Copilot Studio over Direct Line              external
  |-- Knowledge / RAG                        external configuration
  |-- Vision                                 external service
  `-- MCP client
        |
        | Authorization: Bearer <FIELDOPS_MCP_API_KEY>
        v
      FieldOps MCP                           reproducible locally
        |-- get_work_order
        |-- check_inventory
        `-- register_intervention
              |
              v
            JSON seed/demo storage
```

The Telegram webhook secret authenticates Telegram to the relay. The allowlist controls which Telegram user IDs reach agent processing. The MCP bearer key is a separate boundary and is mandatory: the server refuses to start without `FIELDOPS_MCP_API_KEY`. For a deployment, also set `FIELDOPS_ALLOWED_HOSTS` to the exact public host names.

## MCP tools

### `get_work_order`

Returns a seeded work order by `work_order_id`.

### `check_inventory`

Returns site stock, quantity, and equipment compatibility for a part.

### `register_intervention`

Requires:

- `confirmed: true`;
- an existing work order and technician;
- the technician assigned to the work order;
- a caller-provided `idempotency_key`;
- a `correlation_id`.

A replay of the same logical operation with the same idempotency key returns the stored intervention. Reusing that key for different content fails.

The JSON write queue serializes writes only within one Node.js process. It is appropriate for this PoC and its tests. It is not a distributed lock and does not make JSON files suitable for multiple App Service workers or instances.

## Reproduce the MCP locally

Requirements: Node.js 22 and npm.

```bash
cd mcp-server
npm ci
npm test
```

The test command builds the service, starts it with a temporary copy of the seed data, executes 14 tests, and deletes the temporary data. It requires no Azure, Telegram, or Copilot credentials.

To run the service manually:

```bash
cd mcp-server
npm ci
npm run build
export FIELDOPS_MCP_API_KEY="replace-with-a-long-random-secret"
export FIELDOPS_ALLOWED_HOSTS="localhost,127.0.0.1"
npm start
```

PowerShell:

```powershell
$env:FIELDOPS_MCP_API_KEY = "replace-with-a-long-random-secret"
$env:FIELDOPS_ALLOWED_HOSTS = "localhost,127.0.0.1"
npm start
```

Health remains unauthenticated:

```text
GET http://localhost:3000/health
```

MCP requests require:

```text
Authorization: Bearer <FIELDOPS_MCP_API_KEY>
```

Set `FIELDOPS_DATA_DIR` to use a directory other than `data/seed`.

## Reproduce the relay checks locally

```bash
cd relay
npm ci
npm run build
npm run typecheck
npm test
```

The eight relay tests use local HTTP listeners and test doubles. They make no Telegram, Direct Line, Copilot, or Azure calls.

For a real relay process, copy `relay/.env.example` to `relay/.env` and supply:

```dotenv
TELEGRAM_BOT_TOKEN=
COPILOT_TOKEN_ENDPOINT=
TELEGRAM_WEBHOOK_SECRET=
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
PORT=3000
```

All four integration values are required. Missing or malformed configuration fails closed during startup.

## Tested behavior

The MCP suite covers:

- health and bearer authentication;
- tool discovery;
- work-order success and failure;
- inventory availability;
- missing explicit confirmation;
- unknown work order;
- unknown technician;
- technician assignment mismatch;
- successful registration;
- idempotent replay;
- idempotency conflict;
- physical-write uniqueness;
- concurrent in-process writes.

The relay suite covers:

- malformed webhook payload;
- invalid webhook secret;
- unauthorized user;
- authorized text dispatch;
- oversized image rejection before download;
- missing environment variables;
- correlation ID generation;
- contained and logged asynchronous errors.

Downloaded photos are removed in a `finally` block after processing. A second size check runs against the downloaded file when Telegram did not provide `file_size`.

## CI

`.github/workflows/ci.yml` runs separate Node 22 jobs for `mcp-server` and `relay`. Both jobs use `npm ci` and require no external secrets. The workflow checks builds, relay typechecking, and all local tests.

## Dependency controls

Both packages commit npm lockfiles. Targeted npm overrides select patched `fast-uri`, `hono`, and `qs` versions required by transitive dependency advisories. Run `npm audit` in each package after dependency changes; compatibility is enforced by the build and test suites.

## External integration

The relay can maintain one Direct Line conversation per Telegram `chat_id`, forward text and photos, and return cleaned responses. These paths require:

- a Telegram bot and webhook;
- an externally issued Copilot/Direct Line token endpoint;
- Copilot Studio configuration;
- separately configured RAG sources;
- a vision-capable external service;
- deployment-specific Azure configuration if hosted on Azure.

The repository includes manual Direct Line exercise scripts, not a self-contained automated external E2E suite. External-service behavior should not be inferred from the local test count.

## Security notes

- `.env`, tokens, logs, build output, and local output directories are ignored.
- The relay validates the Telegram webhook secret before payload processing.
- Unauthorized Telegram users do not reach the agent handler.
- The MCP endpoint rejects missing or invalid bearer keys.
- Logs include correlation and operational identifiers, not configured secrets.
- Production deployments should store secrets in a managed secret store, use TLS, restrict ingress, rotate credentials, rate-limit requests, and use a database with transactional uniqueness.

## Limitations

- This is a PoC, not a production service.
- Relay sessions are in memory and disappear on restart.
- Operational data is stored in JSON files.
- MCP serialization and idempotency are process-local.
- No distributed transaction, database uniqueness constraint, SLA, adoption, or business-impact claim is made.
- The repository does not contain the external Copilot Studio, RAG, vision, Telegram, or Azure tenant configuration.
- The repository does not include automated external E2E tests.

## Repository structure

```text
.
|-- .github/workflows/ci.yml
|-- data/seed/
|-- mcp-server/
|   |-- src/
|   `-- tests/
|-- relay/
|   |-- src/
|   `-- tests/
|-- docs/
|-- infra/
`-- knowledge/
```
