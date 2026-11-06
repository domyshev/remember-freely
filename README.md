# Remember Freely

Practice your own question packs by topic, track progress and review mistakes in a self-hosted application. React provides the interface; Go and SQLite provide authentication and progress storage.

The application ships with an empty library. Question packs and their images are installed separately, without rebuilding the application. The three independently authored questions in `examples/starter` demonstrate the format and are not installed automatically.

## Application and customer data boundary

This repository contains the reusable application, documentation, independently
written examples and synthetic test fixtures. It must not contain customer
question packs, real learning materials, uploaded ZIPs, images from those packs,
import reports, source correspondence, user progress or runtime databases.
Customer content is never embedded in application source code or build artifacts.

Keep authored packs, original archives and returned reports in a separate folder
or content repository outside this application checkout. Store imported content
and SQLite in a separate runtime directory or mounted data volume. The importer
retains normalized educational content and archive/report checksum pairs there;
this runtime storage is separate from the application's code and Git history.
Use only independently authored examples or synthetic fixtures in committed tests.

## Run locally

Requires Node.js 22.13+, Go 1.24+ and Python 3.9+ for content management.

```bash
npm ci
npm run dev:api
```

In another terminal:

```bash
npm run dev
```

Open `http://127.0.0.1:5173`. The interface is in English; question and explanation text can be written in any language. In local log mode, login codes appear in the API console.

See `.env.example` for supported settings. Export environment variables through your shell or process manager; the server does not automatically load `.env` files. SQLite defaults to `data/practice.db`; content defaults to `data/content`. Both are ignored by Git. Use a fresh database for this application.

## Load questions

A pack is a folder or ZIP containing `pack.json` and optional images. To try the example:

```bash
python3 scripts/content.py validate examples/starter
cd examples/starter && zip -r /tmp/remember-freely-starter.zip pack.json && cd ../..
python3 scripts/content.py import /tmp/remember-freely-starter.zip --report /tmp/remember-freely-starter-report.json
```

Restart the API process and refresh the page. The new pack appears as a top-level section, with its topics underneath. Rebuilding the frontend is unnecessary.

For your own questions:

```bash
python3 scripts/content.py validate /path/to/my-pack.zip
python3 scripts/content.py import /path/to/my-pack.zip --report /path/to/import-report.json
python3 scripts/content.py list
```

Use the global `--store` option **before** the command when installing to a different content directory:

```bash
python3 scripts/content.py --store /path/to/content import /path/to/my-pack.zip --report /path/to/import-report.json
```

Set `CONTENT_DIR` to that same directory before starting the API. The server loads a verified, immutable snapshot at startup. An import does not change an already running server; restart it after a successful import. Administrator CLI packs are shared by all signed-in users. Account imports through Settings or the API are private to their owner and become available without a server restart.

Imports accept ZIP files and return a separate JSON report with input-to-internal
IDs, outcomes and answer-letter mappings. The engine records the SHA-256 of the
exact input ZIP and the exact report bytes. It retains normalized educational
content under internal IDs, not the original ZIP, source identifiers, filenames
or returned report. The uploader keeps the original ZIP, report and any source
correspondence. Imports are atomic: an invalid archive activates no questions.
Original-source export is unavailable; back up the content store and SQLite.

For private account imports, open **User menu → Settings**. Create a named,
expiring API key (shown only once), upload a ZIP with progress, revoke/delete keys
and view upload history with both hashes and UTC timestamps. Reports are returned
only to the caller; save them before closing Settings. An API key can import
packs and read its account's upload history, but cannot manage keys or train.

See [the account import API](docs/import-api.md) for client-agent instructions,
limits and a streaming Python client. Its URL is `/api/imports` on the frontend's
same origin. Account content lives in `IMPORT_DIR` (by default `account-content`
beside SQLite); keep it outside application code and include it in runtime backups.

Read [the pack format](docs/question-packs.md) for fields, limits, topic organization and update rules. Read [the agent guide](docs/agent-import.md) to delegate pack preparation and import to a coding agent.

## Features

- A question can belong to several leaf topics, sharing progress across them.
- Topic trees can have multiple levels; practice starts from a leaf topic.
- Full runs, separate batches of newly added questions and mistake reviews.
- Individual saved progress, date-filtered history and topic statistics.
- Email-code login, with console delivery for local development and optional Resend delivery.
- Account-private ZIP imports, expiring/revocable API keys and UTC upload history.
- Questions with 2–8 answer choices, exactly one correct answer and up to eight images.

Each pack has its own ID namespace. Display numbers and answer letters are presentation details. Imported question IDs are derived from the pack ID and the stable local question ID, and do not depend on wording, topic placement or filenames.

## Verification

```bash
python3 scripts/content.py validate examples/starter
python3 -m unittest discover -s scripts -p 'test_*.py'
node --experimental-strip-types --test scripts/test-*.mjs
npm run lint
npm run build
go test ./backend/...
go vet ./backend/...
```

Backend tests use synthetic fixtures, including an end-to-end pack import, authenticated image access, training, persisted progress after restart and corrupt-snapshot rejection before database creation.

## Container

```bash
docker build -t remember-freely .
docker run --rm -p 127.0.0.1:5050:8080 \
  -v remember-freely-data:/app/data \
  -e SESSION_SECRET='replace-with-a-long-random-secret' \
  -e EMAIL_MODE=log \
  -e COOKIE_SECURE=false \
  remember-freely
```

The container serves the frontend and API on port 8080. The image includes Python 3 for the shared, embedded account importer. Administrator CLI imports can still run on the host against `/app/data/content` and require a container restart; API account imports activate immediately. Preserve the complete shared content store, account-content directory and SQLite database when moving an installation. For HTTPS deployments, set `COOKIE_SECURE=true` and configure a strong session secret and email delivery.

Before upgrading a production database, create a SQLite online backup and verify `PRAGMA quick_check` and `PRAGMA foreign_key_check`. Do not copy only a live database file while WAL mode is active. Deployment is managed separately from this repository.
