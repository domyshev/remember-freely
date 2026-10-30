import copy
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

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
        self.write()

    def write(self):
        (self.source / 'pack.json').write_text(json.dumps(self.pack))

    def install(self):
        self.write()
        return content.install(self.source, self.store)

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
        self.assertEqual(set(content.installed(self.store)), {'starter', 'another'})

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

    def test_images_are_namespaced_and_exportable(self):
        self.pack['questions'][0]['images'] = ['images/example.jpg']
        (self.source / 'images').mkdir()
        (self.source / 'images/example.jpg').write_bytes(b'\xff\xd8\xffexample')
        result = self.install()
        bank = json.loads((content.current(self.store) / 'questions.json').read_bytes())
        question = next(q for q in bank if q['image'])
        self.assertIn(result['snapshot'], question['image'])
        self.assertEqual(question['images'], [question['image']])
        self.assertEqual(content.installed(self.store)['starter']['images/example.jpg'], b'\xff\xd8\xffexample')

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

    def test_user_topic_root_cannot_collide_with_pack_root(self):
        self.pack['topics'].append({'id': 'root', 'title': 'Collision'})
        self.install()
        library = json.loads((content.current(self.store) / 'library.json').read_bytes())
        self.assertEqual(len(library['nodes']), len({node['id'] for node in library['nodes']}))


if __name__ == '__main__':
    unittest.main()
