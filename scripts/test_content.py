import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest import mock

import content


ROOT = Path(__file__).resolve().parents[1]


class ContentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.pack = json.loads((ROOT / 'examples/starter/pack.json').read_text())
        self.store = self.root / 'store'
        self.sequence = 0
        self.write()

    def write(self):
        (self.source / 'pack.json').write_text(json.dumps(self.pack))

    def install(self):
        self.write()
        self.sequence += 1
        archive = self.root / 'pack.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            for path in sorted(self.source.rglob('*')):
                if path.is_file():
                    output.write(path, path.relative_to(self.source).as_posix())
        return content.install(archive, self.store, self.root / f'report-{self.sequence}.json')

    def test_install_and_update_preserve_ids_and_old_snapshots(self):
        first = self.install()
        before = (content.current(self.store) / 'questions.json').read_bytes()
        self.pack['questions'][0]['prompt'] = 'Two plus two equals what?'
        second = self.install()
        self.assertNotEqual(first['snapshot'], second['snapshot'])
        old = json.loads(before)
        new = json.loads((content.current(self.store) / 'questions.json').read_bytes())
        self.assertEqual([q['id'] for q in old], [q['id'] for q in new])
        self.assertEqual((self.store / 'versions' / first['snapshot'] / 'questions.json').read_bytes(), before)

    def test_invalid_update_does_not_activate_or_change_snapshot(self):
        self.install()
        pointer = (self.store / 'CURRENT').read_bytes()
        self.pack['questions'][0]['answers'][0]['correct'] = False
        with self.assertRaises(ValueError):
            self.install()
        self.assertEqual((self.store / 'CURRENT').read_bytes(), pointer)
        self.assertFalse((self.store / '.import-lock').exists())

    def test_changed_answer_key_or_wording_is_rejected(self):
        self.install()
        self.pack['questions'][0]['answers'][0]['text'] = 'four'
        with self.assertRaisesRegex(ValueError, 'Answers changed'):
            self.install()

    def test_silent_question_removal_is_rejected(self):
        self.install()
        self.pack['questions'].pop()
        with self.assertRaisesRegex(ValueError, 'remove questions'):
            self.install()

    def test_packs_are_namespaced_and_existing_pack_is_retained(self):
        self.install()
        self.pack['id'] = 'another'
        self.install()
        bank = json.loads((content.current(self.store) / 'questions.json').read_bytes())
        self.assertEqual(len(bank), 6)
        self.assertEqual(len({q['id'] for q in bank}), 6)
        self.assertEqual(set(content.installed(self.store)), {content.canonical('pack', 'starter'), content.canonical('pack', 'another')})

    def test_shared_question_has_one_identity(self):
        self.pack['questions'][0]['topic_ids'].append('nature')
        self.install()
        library = json.loads((content.current(self.store) / 'library.json').read_bytes())
        self.assertEqual(len(library['questions']), 3)
        self.assertEqual(len(library['questions'][0]['topic_ids']), 2)

    def test_cycle_missing_parent_and_nonleaf_membership_are_rejected(self):
        original = copy.deepcopy(self.pack)
        for change in ('cycle', 'missing', 'nonleaf'):
            self.pack = copy.deepcopy(original)
            if change == 'cycle':
                self.pack['topics'][0]['parent_id'] = 'addition'
            elif change == 'missing':
                self.pack['topics'][0]['parent_id'] = 'absent'
            else:
                self.pack['questions'][0]['topic_ids'] = ['numbers']
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.install()

    def test_missing_and_invalid_images_are_rejected_before_install(self):
        self.pack['questions'][0]['images'] = ['images/example.jpg']
        with self.assertRaisesRegex(ValueError, 'Missing image'):
            self.install()
        (self.source / 'images').mkdir()
        (self.source / 'images/example.jpg').write_bytes(b'not an image')
        with self.assertRaisesRegex(ValueError, 'signature'):
            self.install()
        self.assertFalse((self.store / 'CURRENT').exists())

    def test_images_are_namespaced_without_original_filenames(self):
        self.pack['questions'][0]['images'] = ['images/example.jpg']
        (self.source / 'images').mkdir()
        (self.source / 'images/example.jpg').write_bytes(b'\xff\xd8\xffexample')
        result = self.install()
        bank = json.loads((content.current(self.store) / 'questions.json').read_bytes())
        question = next(q for q in bank if q['image'])
        self.assertIn(result['snapshot'], question['image'])
        self.assertEqual(question['images'], [question['image']])
        self.assertEqual(next(value for name, value in content.installed(self.store)[content.canonical('pack', 'starter')].items() if name.endswith('.jpg')), b'\xff\xd8\xffexample')

    def test_zip_and_directory_have_identical_contents(self):
        archive = self.root / 'pack.zip'
        with zipfile.ZipFile(archive, 'w') as output:
            output.write(self.source / 'pack.json', 'pack.json')
        self.assertEqual(content.read_files(archive), content.read_files(self.source))

    def test_zip_path_traversal_and_duplicate_entries_are_rejected(self):
        for entries in (['../escape'], ['pack.json', 'pack.json']):
            archive = self.root / 'unsafe.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                for name in entries:
                    output.writestr(name, '{}')
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                content.read_files(archive)
        self.assertFalse((self.root / 'escape').exists())

    def test_symlink_and_unknown_fields_are_rejected(self):
        link = self.source / 'link'
        link.symlink_to(self.source / 'pack.json')
        with self.assertRaisesRegex(ValueError, 'Symbolic'):
            content.read_files(self.source)
        link.unlink()
        self.pack['unexpected'] = 'not part of the schema'
        with self.assertRaisesRegex(ValueError, 'Expected fields'):
            self.install()

    def test_same_content_import_is_idempotent(self):
        first = self.install()
        second = self.install()
        self.assertEqual(first['snapshot'], second['snapshot'])
        self.assertEqual(len(list((self.store / 'versions').iterdir())), 1)

    def test_receipt_uses_input_ids_and_detects_changes_without_persisting_report(self):
        first = self.install()
        receipt = first['report']
        self.assertEqual(receipt['counts']['questions']['added'], 3)
        question = next(q for q in receipt['questions'] if q['input_id'] == 'two-plus-two')
        self.assertEqual(question['internal_id'], content.canonical('starter', 'two-plus-two'))
        self.assertEqual(question['answers'][0]['input_id'], 'five')
        self.assertEqual(question['answers'][0]['display_letter'], 'A')
        self.assertFalse(any('receipt' in path.name for path in self.store.rglob('*')))
        second = self.install()
        self.assertEqual(second['report']['counts']['questions']['unchanged'], 3)
        self.assertEqual(first['archive_sha256'], second['archive_sha256'])
        self.pack['questions'][0]['prompt'] = 'Updated prompt'
        self.pack['topics'][0]['title'] = 'Renamed topic'
        updated = self.install()['report']
        self.assertEqual(updated['counts']['questions']['updated'], 1)
        self.assertEqual(updated['counts']['questions']['unchanged'], 2)
        self.assertEqual(updated['counts']['topics']['updated'], 1)
        self.assertNotEqual(receipt['archive_sha256'], updated['archive_sha256'])

    def test_receipt_detects_image_replacement_and_updated_topic_inventory(self):
        self.pack['questions'][0]['images'] = ['images/example.jpg']
        (self.source / 'images').mkdir()
        image = self.source / 'images/example.jpg'
        image.write_bytes(b'\xff\xd8\xfffirst')
        first = self.install()['report']
        image.write_bytes(b'\xff\xd8\xffsecond')
        self.pack['topics'].append({'id': 'unused', 'title': 'Unused'})
        changed = self.install()['report']
        self.assertEqual(changed['counts']['questions']['updated'], 1)
        self.assertNotEqual(first['archive_sha256'], changed['archive_sha256'])
        question = next(q for q in changed['questions'] if q['input_id'] == 'two-plus-two')
        self.assertEqual(question['images'][0]['input_path'], 'images/example.jpg')
        self.assertTrue(question['images'][0]['internal_filename'].endswith('_1.jpg'))
        self.pack['topics'].pop()
        removed = self.install()['report']
        self.assertEqual(len(removed['topics']), len(self.pack['topics']))

    def test_exact_zip_and_report_bytes_match_persisted_checksums(self):
        result = self.install()
        self.assertEqual(result['archive_sha256'], hashlib.sha256((self.root / 'pack.zip').read_bytes()).hexdigest())
        self.assertEqual(result['report_sha256'], hashlib.sha256(Path(result['report_path']).read_bytes()).hexdigest())
        records = [json.loads(path.read_text()) for path in (self.store / 'imports').iterdir()]
        self.assertEqual(records, [{'archive_sha256': result['archive_sha256'], 'report_sha256': result['report_sha256']}])
        # Archive wrapper changes are distinct inputs even when normalized content is identical.
        with zipfile.ZipFile(self.root / 'pack.zip', 'a') as archive:
            archive.comment = b'different ZIP bytes'
        other = content.install(self.root / 'pack.zip', self.store, self.root / 'other-report.json')
        self.assertNotEqual(result['archive_sha256'], other['archive_sha256'])
        self.assertEqual(result['snapshot'], other['snapshot'])
        self.assertEqual(other['report']['counts']['questions']['unchanged'], 3)

    def test_store_contains_no_original_identifiers_or_report(self):
        self.pack['id'] = 'private-pack-reference'
        self.pack['topics'][0]['id'] = 'private-topic-reference'
        self.pack['topics'][1]['parent_id'] = 'private-topic-reference'
        self.pack['questions'][0]['id'] = 'private-question-reference'
        self.pack['questions'][0]['answers'][0]['id'] = 'private-answer-reference'
        result = self.install()
        for path in self.store.rglob('*'):
            if path.is_file():
                data = path.read_bytes()
                for word in (b'private-pack-reference', b'private-topic-reference', b'private-question-reference', b'private-answer-reference'):
                    self.assertNotIn(word, data)
                    self.assertNotIn(word.decode(), str(path))
        self.assertIn('private-question-reference', Path(result['report_path']).read_text())

    def test_rejected_batch_reports_all_items_and_preserves_content(self):
        self.install()
        pointer = (self.store / 'CURRENT').read_bytes()
        self.pack['questions'][0]['answers'][0]['correct'] = False
        with self.assertRaises(content.ImportFailure) as raised:
            self.install()
        result = raised.exception.result
        self.assertFalse(result['accepted'])
        self.assertEqual((self.store / 'CURRENT').read_bytes(), pointer)
        report = result['report']
        self.assertEqual(len(report['questions']), 3)
        self.assertEqual(len(report['topics']), 3)
        self.assertTrue(all(row['internal_id'] is None and row['status'] == 'not_imported' for row in report['questions']))
        self.assertEqual(result['report_sha256'], hashlib.sha256(Path(result['report_path']).read_bytes()).hexdigest())
        self.assertEqual(len(list((self.store / 'imports').iterdir())), 2)

    def test_invalid_zip_has_checksum_and_report_without_fabricated_inventory(self):
        archive = self.root / 'bad.zip'
        archive.write_bytes(b'not a zip')
        with self.assertRaises(content.ImportFailure) as raised:
            content.install(archive, self.store, self.root / 'bad-report.json')
        result = raised.exception.result
        self.assertEqual(result['archive_sha256'], hashlib.sha256(archive.read_bytes()).hexdigest())
        self.assertFalse(result['report']['inventory_available'])
        self.assertEqual(result['report']['questions'], [])
        self.assertFalse((self.store / 'CURRENT').exists())

    def test_report_must_be_new_and_outside_store(self):
        self.install()
        pointer = (self.store / 'CURRENT').read_bytes()
        for path in (self.root / 'report-1.json', self.store / 'report.json', self.root / 'pack.zip'):
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                content.install(self.root / 'pack.zip', self.store, path)
        self.assertEqual((self.store / 'CURRENT').read_bytes(), pointer)

    def test_activation_failure_does_not_leave_a_success_receipt(self):
        original = content.os.replace
        def replace(source, destination):
            if Path(destination).name == 'CURRENT':
                raise OSError('simulated activation failure')
            return original(source, destination)
        with mock.patch.object(content.os, 'replace', side_effect=replace), self.assertRaises(content.ImportFailure) as raised:
            self.install()
        self.assertFalse((self.store / 'CURRENT').exists())
        self.assertFalse(raised.exception.result['accepted'])
        self.assertEqual(len(list((self.store / 'imports').iterdir())), 1)

    def test_import_rejects_folder_while_validation_accepts_it(self):
        self.assertEqual(content.validate(content.read_files(self.source))['id'], 'starter')
        with self.assertRaises(content.ImportFailure) as raised:
            content.install(self.source, self.store, self.root / 'folder-report.json')
        self.assertFalse(raised.exception.result['accepted'])
        self.assertFalse((self.store / 'CURRENT').exists())

    def test_lock_cleanup_failure_keeps_activated_import_accepted(self):
        original = content.Path.rmdir
        def rmdir(path):
            if path.name == '.import-lock':
                raise OSError('simulated lock cleanup failure')
            return original(path)
        with mock.patch.object(content.Path, 'rmdir', rmdir):
            result = self.install()
        self.assertTrue(result['accepted'])
        self.assertEqual(result['report']['outcome'], 'accepted')
        self.assertEqual((self.store / 'CURRENT').read_text().strip(), result['snapshot'])
        self.assertIn('warning', result)

    def test_account_namespaces_preserve_updates_and_isolate_internal_ids(self):
        self.install()
        archive = self.root / 'pack.zip'
        alice = content.install(archive, self.root / 'alice-store', self.root / 'alice-report.json', 'alice')
        bob = content.install(archive, self.root / 'bob-store', self.root / 'bob-report.json', 'bob')
        self.assertNotEqual(alice['report']['pack']['internal_id'], bob['report']['pack']['internal_id'])
        self.assertTrue(set(q['internal_id'] for q in alice['report']['questions']).isdisjoint(q['internal_id'] for q in bob['report']['questions']))
        repeat = content.install(archive, self.root / 'alice-store', self.root / 'alice-repeat.json', 'alice')
        self.assertEqual(alice['snapshot'], repeat['snapshot'])
        self.assertEqual(repeat['report']['counts']['questions']['unchanged'], 3)

    def test_normalized_image_expansion_cannot_create_an_oversized_pack(self):
        self.pack['questions'][0]['images'] = ['images/shared.jpg']
        self.pack['questions'][1]['images'] = ['images/shared.jpg']
        (self.source / 'images').mkdir()
        (self.source / 'images/shared.jpg').write_bytes(b'\xff\xd8\xffexample')
        self.write()
        files = content.read_files(self.source)
        expanded = content.normalize(files)
        limit = sum(map(len, expanded.values())) - 1
        # Original files fit; expanding a shared image and normalizing IDs does not.
        self.assertLess(sum(map(len, files.values())), limit)
        with mock.patch.object(content, 'MAX_TOTAL', limit), self.assertRaises(content.ImportFailure):
            self.install()
        self.assertFalse((self.store / 'CURRENT').exists())

    def test_user_topic_root_cannot_collide_with_pack_root(self):
        self.pack['topics'].append({'id': 'root', 'title': 'Collision'})
        self.install()
        library = json.loads((content.current(self.store) / 'library.json').read_bytes())
        self.assertEqual(len(library['nodes']), len({node['id'] for node in library['nodes']}))


if __name__ == '__main__':
    unittest.main()
