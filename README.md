# Remember Freely

Practice your own question packs by topic, track progress and review mistakes in a self-hosted application. React provides the interface; Go and SQLite provide authentication and progress storage.

The application ships with an empty library. Question packs and their images are installed separately, without rebuilding the application. The three independently authored questions in `examples/starter` demonstrate the format and are not installed automatically.

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
python3 scripts/content.py import examples/starter
```

Restart the API process and refresh the page. The new pack appears as a top-level section, with its topics underneath. Rebuilding the frontend is unnecessary.

For your own questions:

```bash
python3 scripts/content.py validate /path/to/my-pack.zip
python3 scripts/content.py import /path/to/my-pack.zip
python3 scripts/content.py list
python3 scripts/content.py export my-pack /path/to/exported-pack.zip
```

Use the global `--store` option **before** the command when installing to a different content directory:

```bash
python3 scripts/content.py --store /path/to/content import /path/to/my-pack.zip
```

Set `CONTENT_DIR` to that same directory before starting the API. The server loads a verified, immutable snapshot at startup. An import does not change an already running server; restart it after a successful import. All signed-in users of an installation can access its installed packs; private per-user packs and browser uploads are not implemented.

Read [the pack format](docs/question-packs.md) for fields, limits, topic organization and update rules. Read [the agent guide](docs/agent-import.md) to delegate pack preparation and import to a coding agent.

## Features

- A question can belong to several leaf topics, sharing progress across them.
- Topic trees can have multiple levels; practice starts from a leaf topic.
- Full runs, separate batches of newly added questions and mistake reviews.
- Individual saved progress, date-filtered history and topic statistics.
- Email-code login, with console delivery for local development and optional Resend delivery.
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

The container serves the frontend and API on port 8080. It does not need Python at runtime: run the content command on the host against the content directory mounted into `/app/data/content`, then restart the container. Preserve the complete content store and SQLite database when moving an installation. For HTTPS deployments, set `COOKIE_SECURE=true` and configure a strong session secret and email delivery.

Before upgrading a production database, create a SQLite online backup and verify `PRAGMA quick_check` and `PRAGMA foreign_key_check`. Do not copy only a live database file while WAL mode is active. Deployment is managed separately from this repository.
