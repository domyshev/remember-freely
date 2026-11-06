# Account import API for client agents

Use this guide together with [agent-import.md](agent-import.md) to prepare the
ZIP and retain its correspondence report. Customer materials remain outside the
application repository. The API is an alternative to the administrator's CLI
import; it installs content privately in the authenticated user's account.

## Origin and credentials

The base URL is exactly the origin at which the frontend opens. If the frontend
is `https://practice.example.com/`, the import URL is
`https://practice.example.com/api/imports`. Do not use a different service or port.
Use HTTPS in production. Loopback HTTP is suitable for local development.

The user creates a key in **User menu → Settings → API keys**, supplying a name
and lifetime. The UI accepts 1–365 days; the endpoint accepts a UTC RFC3339 expiry
between one minute and 365 days in the future. The complete key is returned and
shown only at creation. Copy it then; it cannot be recovered. A key can later be
revoked or deleted. Both invalidate it, including a final validity check before
an in-flight import can activate content. Expiry is mandatory.

Send `Authorization: Bearer <key>` for import/history calls. Never place keys in
URLs, ZIP files, committed source, reports or logs. Store the key in the client's
secret store or temporary environment, not application source. The server stores
only a SHA-256 digest and a short display prefix of the randomly generated key.
Keys have only import/history scope; they cannot access training APIs or create
other keys. Invalid/expired/revoked/deleted keys return 401. Key administration
requires a signed-in browser session and rejects cross-origin browser mutations.
At most 50 non-deleted keys can exist per account.

## Endpoints

| Method and path | Authentication | Result |
| --- | --- | --- |
| `POST /api/imports` | API key or browser session | Raw ZIP upload; exact JSON report in response |
| `GET /api/imports?limit=20&offset=0` | API key or browser session | This account's paginated history |
| `GET /api/imports/{id}` | API key or browser session | This account's one upload record |
| `GET /api/keys` | Browser session | Metadata only, never complete key material |
| `POST /api/keys` | Browser session | Create `{ "name": "My agent", "expires_at": "<RFC3339 timestamp>" }`; returns `key` metadata and one-time `secret` |
| `POST /api/keys/{id}/revoke` | Browser session | Revoke; returns 204 |
| `DELETE /api/keys/{id}` | Browser session | Delete; returns 204, without deleting upload history |

## Send the ZIP and keep the report

`POST /api/imports` takes **raw ZIP bytes**, not JSON, multipart form data,
base64 or a filesystem path. Set `Content-Type: application/zip` and preferably
`Content-Length`. The ZIP is limited to **64 MiB (67,108,864 bytes)**, including
chunked requests. Existing expanded-size, per-file, topic and question limits
still apply; a ZIP cannot bypass validation. Do not add provenance files to it.

Use the bundled standard-library client (run from the engine checkout):

```sh
python3 examples/api-import.py https://practice.example.com /path/to/input.zip --report /path/to/reports/import-001.json
```

It prompts for the API key without echoing it, or reads
`REMEMBER_FREELY_API_KEY` from the process environment. It streams the upload,
prints byte progress, switches to processing, verifies both returned hashes and
saves the **exact response bytes** to a new report file. Exit 0 means accepted;
exit 1 also covers rejected archives, whose verified report is still saved.
Read its JSON summary to distinguish rejection from a transport failure.

For other HTTP clients, a minimal request is:

```http
POST /api/imports HTTP/1.1
Host: practice.example.com
Authorization: Bearer <key>
Content-Type: application/zip
Content-Length: <ZIP byte count>

<raw ZIP bytes>
```

A completed import returns 200; a validated rejection returns 422. In both cases
the body is the complete external JSON report described in question-packs.md,
and the response has these headers:

| Header | Meaning |
| --- | --- |
| `X-Import-ID` | One upload/history record ID |
| `X-Archive-SHA256` | SHA-256 of all received ZIP bytes |
| `X-Report-SHA256` | SHA-256 of the exact response body |
| `X-Report-Created-At` | UTC RFC3339 timestamp when the report was generated |
| `Content-Disposition` | Attachment filename for the caller's report |

Save the body without parsing/reformatting and verify the headers independently.
The report contains input-to-internal mappings; these belong to the uploader,
not the engine. A rejected batch imports nothing and assigns no new internal IDs. Error text is bounded; invalid IDs use a null input ID and an input index. Over-limit item counts cannot produce an unbounded failure inventory.
For accepted content, normalized questions, answer wording, topic names and
images are stored under internal identifiers and account namespaces. The same
input IDs in two different accounts do not collide and are not shared.

Imported content becomes available on subsequent authenticated requests without
an API restart. Refresh the frontend to obtain updated topic metadata; the
built-in uploader refreshes its library automatically. Shared administrator CLI
packs remain available to all users. API imports are visible only to their owner.

## Upload and processing progress

Uploading and processing are different stages. Compute byte progress in the
client (for example, `XMLHttpRequest.upload.onprogress`). Once all bytes have been
sent, show **Processing** until the response arrives, then **Report ready**.
Do not label uploaded bytes as successfully imported questions, or invent a
processing percentage. The built-in Settings uploader implements these stages
and verifies the report hash before offering its download.

The POST is synchronous and does not return an asynchronous job token early.
During a slow POST, another authenticated connection can poll history to see
`uploading`/`processing`; it receives the definitive upload ID in the POST response.
The individual history endpoint can then be used with that ID. There is no
resumable upload, background queue or server-sent event stream in this version.

## History and UTC timestamps

The list returns `uploads`, `next_offset` and `max_upload_bytes`. Follow
`next_offset` until null; `limit` is 1–100 (default 20). Each attempt is **one row**:

```json
{
  "id": "<opaque upload ID>",
  "status": "completed",
  "upload_started_at": "2026-11-06T12:00:00Z",
  "uploaded_at": "2026-11-06T12:00:05Z",
  "report_created_at": "2026-11-06T12:00:07Z",
  "archive_sha256": "<64 lowercase hex characters>",
  "report_sha256": "<64 lowercase hex characters>",
  "size_bytes": 12345
}
```

All timestamps are UTC RFC3339 strings ending in `Z`; fractional seconds may be
present. `upload_started_at` is when the accepted request starts receiving data;
`uploaded_at` is when the entire ZIP has arrived; `report_created_at` is separate.
Fields not reached are null. Interrupted/oversized streaming bodies have no full
archive hash. States are `uploading`, `processing`, `completed`, `rejected`,
`failed` (transport/processing failure), or `interrupted` (server restarted).
Different attempts have different history IDs, even for the same ZIP.

The history stores account ownership, key reference (nullable after deletion),
status, timestamps, byte count and the two checksums. It does not store original
filenames, source notation, ZIPs, correspondence or report copies. Reports are
returned only in the original POST response; there is no later report-download
endpoint. Keep the Settings dialog open until the report is saved. If a client
loses the response, inspect history before retrying. Re-uploading the same stable
input IDs is safe for question identity and returns a new report/history attempt,
with unchanged questions rather than duplicates.

## Errors and operational limits

- 400: incomplete upload; 401: missing/inactive credential; 404: missing or
  another account's resource; 413: ZIP too large; 415: wrong media type.
- 422 with checksum headers: a complete rejection report, not a generic error.
- 429: one import already active in this account, two active imports server-wide,
  or 20 attempts per account in the last hour. Respect `Retry-After`.
- 500: processing failed; consult history before retrying. A reverse proxy can
  also return its own timeout/body-limit errors without report headers.

Allow up to five minutes to send a body and two minutes of processing; the
server/client response deadline is eight minutes. Configure a deployment's proxy
body limits and deadlines consistently. The service is a single-server writer;
run one API process against a given database/import directory. Startup marks
unfinished uploads interrupted and removes their temporary input/report files.
An abrupt stop may have applied content even if the client never received the
report: inspect history, retain the original ZIP and retry stable IDs if needed.

The runtime needs `python3` for the embedded shared importer (included in the
Docker image), and persistent writable `IMPORT_DIR` storage. By default it is
`account-content` beside SQLite. Keep it outside code and frontend assets and
back up it **together with SQLite**: the database transaction selects each
account's active snapshot, imported question records and final history metadata.
Snapshots are verified before activation. Old inactive snapshots may remain for
recovery; do not delete them while a request is using them. Temporary archives
and reports are removed at the end of processing. No origin-specific content
or customer credentials belong in the public engine repository.
