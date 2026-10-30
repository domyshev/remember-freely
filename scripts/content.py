#!/usr/bin/env python3
"""Validate, install and export question packs using only the standard library."""

import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
import zipfile

MAX_TOTAL = 64 * 1024 * 1024
MAX_FILE = 8 * 1024 * 1024
ID = re.compile(r'^[a-z0-9][a-z0-9._-]{0,63}$')


def fail(message):
    raise ValueError(message)


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def decode(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                fail(f'Duplicate JSON key: {key}')
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)


def fields(value, required, optional=()):
    if not isinstance(value, dict) or set(value) - set(required) - set(optional) or set(required) - set(value):
        fail(f'Expected fields {required}; optional fields {optional}')


def text(value, label, maximum=20000):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or '\x00' in value:
        fail(f'Invalid {label}')
    return value


def identifier(value):
    if not isinstance(value, str) or not ID.fullmatch(value):
        fail(f'Invalid ID: {value!r}; use lowercase letters, digits, dots, hyphens or underscores')
    return value


def safe_name(name):
    path = PurePosixPath(name)
    if not name or '\\' in name or '\x00' in name or path.is_absolute() or '..' in path.parts or str(path) != name:
        fail(f'Unsafe archive path: {name!r}')
    return name


def read_files(source):
    source = Path(source)
    files = {}
    total = 0
    if source.is_symlink():
        fail('Symbolic links are not accepted')
    if source.is_dir():
        for path in sorted(source.rglob('*')):
            if path.is_symlink():
                fail(f'Symbolic links are not accepted: {path.name}')
            if path.is_dir():
                continue
            if not path.is_file() or path.stat().st_size > MAX_FILE:
                fail(f'Invalid or oversized file: {path.name}')
            total += path.stat().st_size
            if total > MAX_TOTAL:
                fail('Pack exceeds 64 MiB')
            files[safe_name(path.relative_to(source).as_posix())] = path.read_bytes()
    else:
        if source.stat().st_size > MAX_TOTAL:
            fail('Archive exceeds 64 MiB')
        with zipfile.ZipFile(source) as archive:
            if len(archive.infolist()) > 10002:
                fail('Too many archive entries')
            for item in archive.infolist():
                safe_name(item.filename.rstrip('/'))
                mode = item.external_attr >> 16
                if stat.S_ISLNK(mode) or item.flag_bits & 1:
                    fail('Symbolic links and encrypted entries are not accepted')
                if item.is_dir():
                    continue
                if item.filename in files or item.file_size > MAX_FILE:
                    fail('Duplicate or oversized archive entry')
                total += item.file_size
                if total > MAX_TOTAL:
                    fail('Expanded pack exceeds 64 MiB')
                files[item.filename] = archive.read(item)
    if len(files) > 10002:
        fail('Too many files in pack')
    if 'pack.json' not in files:
        fail('pack.json must be at the root of the folder or ZIP')
    validate(files)
    return files


def validate(files):
    pack = decode(files['pack.json'])
    fields(pack, ['schema_version', 'id', 'title', 'topics', 'questions'])
    if type(pack['schema_version']) is not int or pack['schema_version'] != 1:
        fail('Unsupported schema_version; expected 1')
    identifier(pack['id'])
    text(pack['title'], 'pack title', 200)
    if not isinstance(pack['topics'], list) or not 1 <= len(pack['topics']) <= 1000:
        fail('Expected 1–1000 topics')
    if not isinstance(pack['questions'], list) or not 1 <= len(pack['questions']) <= 5000:
        fail('Expected 1–5000 questions')
    topics = {}
    for topic in pack['topics']:
        fields(topic, ['id', 'title'], ['parent_id'])
        identifier(topic['id'])
        text(topic['title'], 'topic title', 200)
        if topic['id'] in topics:
            fail(f'Duplicate topic: {topic["id"]}')
        topics[topic['id']] = topic
    parents = set()
    for topic in topics.values():
        visited = {topic['id']}
        parent = topic.get('parent_id')
        while parent is not None:
            if not isinstance(parent, str) or parent not in topics or parent in visited:
                fail(f'Missing parent or cycle at topic: {topic["id"]}')
            parents.add(parent)
            visited.add(parent)
            parent = topics[parent].get('parent_id')
    seen = set()
    referenced = {'pack.json'}
    for question in pack['questions']:
        fields(question, ['id', 'prompt', 'answers', 'topic_ids'], ['explanation', 'images'])
        identifier(question['id'])
        if question['id'] in seen:
            fail(f'Duplicate question: {question["id"]}')
        seen.add(question['id'])
        text(question['prompt'], 'question prompt')
        if 'explanation' in question and question['explanation'] != '':
            text(question['explanation'], 'explanation')
        tags = question['topic_ids']
        if not isinstance(tags, list) or not tags or any(not isinstance(tag, str) or tag not in topics or tag in parents for tag in tags) or len(set(tags)) != len(tags):
            fail(f'Question {question["id"]} must reference unique leaf topics')
        answers = question['answers']
        if not isinstance(answers, list) or not 2 <= len(answers) <= 8:
            fail('Each question needs 2–8 answers')
        answer_ids, answer_texts = set(), set()
        correct = 0
        for answer in answers:
            fields(answer, ['id', 'text', 'correct'])
            identifier(answer['id'])
            wording = ' '.join(text(answer['text'], 'answer text').split()).casefold()
            if answer['id'] in answer_ids or wording in answer_texts or type(answer['correct']) is not bool:
                fail('Duplicate answer or invalid correct flag')
            answer_ids.add(answer['id'])
            answer_texts.add(wording)
            correct += answer['correct']
        if correct != 1:
            fail(f'Question {question["id"]} must have exactly one correct answer')
        images = question.get('images', [])
        if not isinstance(images, list) or len(images) > 8:
            fail('Expected up to 8 images per question')
        for image in images:
            if not isinstance(image, str):
                fail('Image paths must be strings')
            safe_name(image)
            if not re.fullmatch(r'images/[a-zA-Z0-9_.-]+\.(jpg|jpeg|png|webp)', image):
                fail(f'Invalid image path: {image}')
            if image not in files:
                fail(f'Missing image: {image}')
            data = files[image]
            suffix = PurePosixPath(image).suffix
            valid = (suffix in ('.jpg', '.jpeg') and data.startswith(b'\xff\xd8\xff')) or (suffix == '.png' and data.startswith(b'\x89PNG\r\n\x1a\n')) or (suffix == '.webp' and data[:4] == b'RIFF' and data[8:12] == b'WEBP')
            if not valid:
                fail(f'Image signature does not match its extension: {image}')
            referenced.add(image)
    if set(files) != referenced:
        fail('Unreferenced files in pack: ' + ', '.join(sorted(set(files) - referenced)))
    return pack


def current(store):
    marker = store / 'CURRENT'
    if not marker.exists():
        return None
    version = marker.read_text().strip()
    if not re.fullmatch(r'[a-f0-9]{64}', version):
        fail('Invalid CURRENT snapshot pointer')
    return store / 'versions' / version


def installed(store):
    snapshot = current(store)
    if snapshot is None:
        return {}
    return {path.name: read_files(path) for path in sorted((snapshot / 'packs').iterdir())}


def canonical(pack_id, question_id):
    return digest((pack_id + ':' + question_id).encode())[:24]


def guard_update(old_files, new_files):
    old = validate(old_files)
    new = validate(new_files)
    old_questions = {q['id']: q for q in old['questions']}
    new_questions = {q['id']: q for q in new['questions']}
    if set(old_questions) - set(new_questions):
        fail('Updates cannot silently remove questions; retain them or use a new pack ID')
    for qid in old_questions.keys() & new_questions.keys():
        # Answer history stores selected wording. Keep answer IDs and wording stable.
        answers = lambda q: sorted((a['id'], a['text'], a['correct']) for a in q['answers'])
        if answers(old_questions[qid]) != answers(new_questions[qid]):
            fail(f'Answers changed for {qid}; keep the historical question and create a new question ID')


def compile_packs(packs, version):
    bank, nodes, entries, assets = [], [], [], {}
    seen_ids = set()
    for pack_id, files in sorted(packs.items()):
        pack = validate(files)
        root = pack_id
        nodes.append({'id': root, 'label': pack['title'], 'parent_id': None})
        for topic in pack['topics']:
            nodes.append({'id': pack_id + ':' + topic['id'], 'label': topic['title'], 'parent_id': pack_id + ':' + topic['parent_id'] if topic.get('parent_id') else root})
        for q in pack['questions']:
            cid = canonical(pack_id, q['id'])
            if cid in seen_ids:
                fail('Canonical question ID collision')
            seen_ids.add(cid)
            image_urls = []
            for number, source in enumerate(q.get('images', []), 1):
                name = f'{cid}_{number}{PurePosixPath(source).suffix}'
                assets[name] = files[source]
                image_urls.append(f'/content-assets/{version}/{name}')
            bank.append({'id': cid, 'question': q['prompt'], 'help': {'en': q.get('explanation', ''), 'es': '', 'ru': ''}, 'image': image_urls[0] if image_urls else '', 'images': image_urls, 'answers': [{'letter': chr(65 + index), 'text': answer['text'], 'correct': answer['correct']} for index, answer in enumerate(sorted(q['answers'], key=lambda a: a['id']))]})
            entries.append({'canonical_id': cid, 'question': q['prompt'], 'question_title': q['prompt'], 'verified': True, 'topic_ids': [pack_id + ':' + topic for topic in q['topic_ids']]})
    return {'questions.json': json_bytes(sorted(bank, key=lambda q: q['id'])), 'library.json': json_bytes({'nodes': nodes, 'questions': entries})}, assets


@contextmanager
def locked(store):
    store.mkdir(parents=True, exist_ok=True)
    lock = store / '.import-lock'
    try:
        lock.mkdir()
    except FileExistsError:
        fail('Another import is running; if it crashed, remove .import-lock after checking no importer is active')
    try:
        yield
    finally:
        lock.rmdir()


def install(source, store):
    incoming = read_files(source)
    pack = validate(incoming)
    with locked(store):
        packs = installed(store)
        if pack['id'] in packs:
            guard_update(packs[pack['id']], incoming)
        packs[pack['id']] = incoming
        identity = {pid: {name: digest(data) for name, data in sorted(files.items())} for pid, files in sorted(packs.items())}
        version = digest(json_bytes({'format_version': 1, 'packs': identity}))
        outputs, assets = compile_packs(packs, version)
        if any(len(data) > MAX_FILE for data in outputs.values()):
            fail('Compiled library exceeds the 8 MiB per-file limit')
        if 2 * sum(len(data) for files in packs.values() for data in files.values()) + sum(len(data) for data in outputs.values()) > 250 * 1024 * 1024:
            fail('Installed content would exceed the runtime memory limit')
        versions = store / 'versions'
        versions.mkdir(exist_ok=True)
        destination = versions / version
        with tempfile.TemporaryDirectory(prefix='.pending-', dir=versions) as temporary:
            pending = Path(temporary)
            for pid, files in packs.items():
                for name, data in files.items():
                    path = pending / 'packs' / pid / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(data)
            for name, data in outputs.items():
                (pending / name).write_bytes(data)
            (pending / 'assets').mkdir()
            for name, data in assets.items():
                (pending / 'assets' / name).write_bytes(data)
            checksums = {path.relative_to(pending).as_posix(): digest(path.read_bytes()) for path in sorted(pending.rglob('*')) if path.is_file()}
            (pending / 'checksums.json').write_bytes(json_bytes(checksums))
            if not destination.exists():
                os.rename(pending, destination)
                pending.mkdir()
            else:
                for name, expected in checksums.items():
                    if digest((destination / name).read_bytes()) != expected:
                        fail('Existing snapshot is damaged; refusing to activate it')
        marker = store / 'CURRENT.tmp'
        marker.write_text(version + '\n')
        os.replace(marker, store / 'CURRENT')
    return {'pack': pack['id'], 'packs_installed': len(packs), 'questions_in_pack': len(pack['questions']), 'snapshot': version, 'restart_required': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--store', type=Path, default=Path('data/content'))
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('validate', 'import'):
        command = commands.add_parser(name)
        command.add_argument('source', type=Path)
    commands.add_parser('list')
    export = commands.add_parser('export')
    export.add_argument('pack_id')
    export.add_argument('destination', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'validate':
            pack = validate(read_files(args.source))
            result = {'pack': pack['id'], 'topics': len(pack['topics']), 'questions': len(pack['questions']), 'valid': True}
        elif args.command == 'import':
            result = install(args.source, args.store)
        elif args.command == 'list':
            result = [{'id': pid, 'title': validate(files)['title'], 'questions': len(validate(files)['questions'])} for pid, files in installed(args.store).items()]
        else:
            packs = installed(args.store)
            if args.pack_id not in packs:
                fail('Unknown pack ID')
            with args.destination.open('xb') as output:
                with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
                    for name, data in packs[args.pack_id].items():
                        archive.writestr(name, data)
            result = {'exported': str(args.destination)}
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, zipfile.BadZipFile, KeyError, TypeError) as error:
        print(f'Content error: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
