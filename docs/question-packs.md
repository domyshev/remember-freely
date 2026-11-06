# Question pack format, version 1

A pack folder contains `pack.json` at its root and optionally an `images/` folder. A ZIP contains that same structure, without an enclosing directory. See `examples/starter/pack.json` for a complete minimal example.

## Fields

The root object requires:

| Field | Meaning |
| --- | --- |
| `schema_version` | Integer `1` |
| `id` | Stable pack identifier, such as `basic-math` |
| `title` | Human-readable section title |
| `topics` | Array of topics |
| `questions` | Array of questions |

Topics require `id` and `title`. Optional `parent_id` references another topic in the same pack. Omit it or use `null` for a top-level topic. Missing parents and cycles are rejected. Topic IDs are unique within the pack. A pack appears as its own root section in the application.

Questions require `id`, `prompt`, `answers` and `topic_ids`. Optional `explanation` is plain text. Optional `images` is an ordered list of relative image paths. All text is rendered as text, never executable HTML. Line breaks are preserved in questions and answers.

Every answer requires a stable `id`, `text` and boolean `correct`. A question has 2–8 distinct answers and exactly one correct answer. Answer IDs must be unique within their question. The importer sorts answers by stable ID before assigning display letters; letter assignments are not part of the pack format.

`topic_ids` references one or more distinct **leaf** topics in the same pack. A question assigned to several topics has one identity and shared progress. Parent topics organize navigation; this version starts practice from leaf topics only.

IDs use 1–64 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit. Pack, topic, question and answer IDs are normalized to opaque internal identifiers. The root pack ID and local question ID together determine the internal question identity. Importing a different pack with the same local question IDs creates distinct questions. Keep all input IDs unchanged when publishing an update. The uploader must retain them; the engine cannot reconstruct original IDs from internal identifiers.

## Images

Image paths have the form `images/example.jpg`. Supported extensions are `.jpg`, `.jpeg`, `.png` and `.webp`, in lowercase. Paths cannot contain directories beneath `images/`, traversal segments, backslashes or external URLs. The importer checks file signatures against extensions. This is a format check, not a full image decoding test; preview images before distributing a pack.

Each question supports up to eight images. They appear in the question gallery in the specified order. The installed filenames use `<internal_question_id>_<number>.<extension>`, starting at one, inside an immutable snapshot. Original filenames are returned in the external import report, but are not stored in the engine. The uploader keeps the original ZIP and report for future edits.

Missing images, symbolic links, unknown fields, duplicate JSON keys and unreferenced files are rejected. ZIP entries are read without extracting arbitrary filesystem paths. Encrypted ZIPs are rejected.

## Updates and progress

Importing a ZIP with an existing stable input pack ID updates that pack and retains the other installed packs. Validation completes before the active snapshot pointer changes. Concurrent imports are rejected by a store lock. Previous snapshots are retained; runtime content is checksummed before database import. An unchanged normalized import reuses the same snapshot, even if ZIP compression or comments change. The checksum of each submitted ZIP still identifies its exact bytes.

Supported updates include adding questions, changing prompts and explanations, replacing images, renaming topics and moving questions between leaf topics. These changes preserve internal question IDs. New questions are tracked by the existing training logic; a user with no prior run simply starts a normal run.

The engine currently stores selected answer wording in its history. Therefore the importer rejects changes to existing answer IDs, wording or correctness. It also rejects silent question removal. To change an answer, retain the historical question and add a new question with a new local ID. A future revision-aware history model can relax this restriction. Do not bypass it by editing compiled files or the database.

Restart the API after a successful import. Existing processes retain their in-memory snapshot until restart. The frontend obtains topic metadata from the authenticated API rather than a build-time file. Imported images also require authentication.

## Limits and storage

- 1–1,000 topics and 1–5,000 questions per pack.
- Up to 8 MiB per source or generated JSON/image file.
- Up to 64 MiB per ZIP and per expanded source pack; up to 10,002 ZIP entries.
- A conservative total-size check ensures the installed content fits the runtime's 256 MiB snapshot budget.
- Titles are limited to 200 characters; question, answer and explanation fields to 20,000 characters.

The default store is `data/content`:

```text
content/
  CURRENT
  versions/
    <snapshot-hash>/
      questions.json
      library.json
      checksums.json
      assets/
      storage.json
      packs/
        <internal-pack-id>/
          pack.json       # normalized content, internal IDs only
          images/         # internal filenames only
  imports/
    <record-hash>.json     # archive_sha256 and report_sha256 only
```

`CURRENT` is atomically replaced only after a complete snapshot has been written. Do not hand-edit installed snapshots. Keep authored packs outside the application source tree, or in ignored `question-packs/` or `imports/` folders. Keep the uploader-owned ZIP and import report outside Git. Original-source export is unavailable because original IDs and filenames are not retained. No question content needs to be committed to publish the engine.

JSON packs are the supported interchange format in version 1. CSV/Excel import, an in-browser editor, per-user pack ownership, automatic reload and multiple correct answers are not implemented.


## ZIP imports, reports and checksum records

Folder input is accepted by `validate` while preparing content. Actual imports
require a ZIP file and a new external report path:

```sh
python3 scripts/content.py --store /path/to/content import /path/to/input.zip --report /path/to/reports/import-001.json
```

The importer reads the ZIP once, computes SHA-256 of its exact bytes and safely
reads its entries without filesystem extraction. Two ZIPs containing equivalent
content can have different archive hashes. The archive hash is not a manifest
hash, normalized-content hash or snapshot hash.

The JSON report has report `schema_version: 2` (the input pack schema remains 1),
`archive_sha256`, `outcome` (`accepted` or `rejected`), `atomic: true`,
`inventory_available`, `pack`, `topics`, `questions`, `counts` and `errors`.
Accepted records contain `input_id`, `internal_id` and status `added`, `updated`
or `unchanged`. Questions also include answer-ID/display-letter mappings and
input-image/internal-filename mappings. Status compares against the previous
normalized version of this pack, not a running API or user progress.
Removed topics are absent from the new content; no original IDs for old topics
are retained to reconstruct them. Silent question removal remains forbidden.

An invalid batch is entirely rejected. All input questions and topics that can
be enumerated are `not_imported`, with `internal_id: null` and a batch-failure
reason. No new content is activated and the prior CURRENT pointer is unchanged.
This does not assert that every individual item is invalid: one invalid item
can reject the batch. An unreadable archive/manifest has no invented item list.

The report file must be new, outside the store and distinct from the input ZIP.
Failure to reserve it prevents import. The caller receives its exact-byte SHA-256
in the CLI summary, outside the report itself. The engine records only this pair
as import audit metadata:

```json
{"archive_sha256": "<64 hex characters>", "report_sha256": "<64 hex characters>"}
```

These records live under `content/imports/`, including reportable rejected
attempts. They contain no input filenames, paths, IDs, mappings or report copies.
Repeated identical checksum pairs reuse the same record. Questions, answers,
images and topic names are of course retained as normalized educational content;
only origin notation and correspondence remain with the uploader. Original
source archives and reports are not retained inside content snapshots or SQLite.

Nonexistent/nonregular/oversized inputs can fail before an exact ZIP hash is
available; their report has a null archive hash and no two-hash record. Unusable
report destinations fail before activation and cannot return a report file.
Check the command exit status and summary rather than assuming any file means
success. The report describes snapshot activation; restart is still required.

Legacy source-preserving stores are not silently converted or erased. Imports
into those stores are rejected. Back them up, retain original source ZIPs and
use a fresh content store for this storage format. Existing progress/topic IDs
from such an installation require an explicit migration; never discard them.
See [agent-import.md](agent-import.md) for ZIP construction and report handling.
