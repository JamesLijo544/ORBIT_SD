# Resilient DAG Orchestrator

A small TypeScript, Express, SQLite, and React application for running three
backend-defined workflow templates. Users can configure and execute templates,
but cannot create tasks or change DAG dependencies.

## Run on Windows

From PowerShell in the project directory:

```powershell
npm install
npm run build:app
npm test
npm start
```

Open `http://127.0.0.1:3000`. To use the Vite development server, run `npm start`
in one terminal and `npm run dev` in another, then open
`http://127.0.0.1:5173`.

The built application includes the Resilience Simulator, persistent execution history,
task attempt inspector, execution console, replay support, and SQLite-derived analytics.

The SQLite database defaults to `data/orchestrator.sqlite`. Override it with
`$env:DATABASE_PATH = "C:\path\to\orchestrator.sqlite"`; set
`$env:PORT = "3000"` to choose the API port. The database directory is created
when the server starts.

## Templates

- **CSV Data Processing Pipeline** — upload a CSV (up to 512 KB) or use
  `data/sample.csv`; the pipeline checks required columns and row values, cleans
  missing values and duplicates, calculates statistics, and writes a processed
  file to `data/exports`. A completed run provides a CSV download.
- **Resilience and Failure Recovery Pipeline** — runs a data-fetch, validation,
  processing, and report branch alongside an independent health check. Options
  configure deterministic scenarios or random failure probability, max
  attempts, timeout, and artificial delay. The temporary-failure scenario
  demonstrates CLOSED, OPEN, HALF-OPEN, and recovered CLOSED circuit states in
  execution logs.
- **Text Analysis Pipeline** — accepts up to 100,000 characters, validates the
  input, calculates character, word, sentence, average sentence-length, and
  paragraph statistics, and generates an extractive summary with topic keywords,
  keyword frequencies, and validation findings.

## REST API

- `GET /api/health`
- `GET /api/templates` and `GET /api/templates/:id`
- `POST /api/executions` with `{ "templateId": "...", "parameters": {}, "input": {} }`
- `GET /api/executions?limit=50&offset=0`
- `GET /api/executions/:id`
- `GET /api/executions/:id/tasks`
- `GET /api/executions/:id/logs`
- `GET /api/executions/:id/output` (CSV template runs)
- `GET /api/dashboard/stats`

Execution creation returns `202 Accepted` with an execution ID. The browser
polls active executions and task details. API validation failures return JSON
with a 4xx status.

## Resilience and persistence

The engine validates the fixed DAGs, schedules dependencies with bounded
concurrency, retries transient failures with capped exponential backoff, and
skips descendants of failed tasks while allowing independent branches to
finish. Task handlers receive an `AbortSignal`; timeouts and cancellation are
cooperative and cannot forcibly stop arbitrary JavaScript work.

Workflow definitions, execution/task states, attempts, outputs, circuit
snapshots, and logs are persisted in SQLite. On startup, unfinished executions
are recovered at least once. Handlers with external side effects must be
idempotent; exactly-once execution is not promised. Circuit breakers are local
to this single process and are not distributed.

## Validation

```powershell
npm run build:app
npm run typecheck:tests
npm test
npm audit
```
