"""Bundled assets and safe, idempotent startup installation without a server."""
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "server_bridge" / "ns_lb_bridge"
spec = importlib.util.spec_from_file_location("resource_pack_under_test", PACKAGE / "resource_pack.py")
rp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rp)


def pack_bytes(version=(1, 1, 0), pack_id=rp.PACK_ID, extra=None):
    manifest = json.loads((ROOT / "resource_pack" / "manifest.json").read_text(encoding="utf-8"))
    manifest["header"].update(uuid=pack_id, version=list(version))
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("textures/test.png", b"previous texture")
        if extra:
            # ZipInfo's constructor normalizes backslashes on Windows; assign
            # the raw stored name afterward to exercise malformed archives.
            entry = zipfile.ZipInfo("placeholder")
            entry.filename = extra
            archive.writestr(entry, b"invalid path")
    return stream.getvalue()


class ResourcePackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="resource-pack-test-", dir=ROOT / "tests")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "server.properties").write_text("level-name=TestWorld\ntexturepack-required=false\n", encoding="utf-8")
        self.original_settings = (self.root / "server.properties").read_bytes()
        self.destination = self.root / "resource_packs" / rp.ARCHIVE_NAME
        self.addCleanup(patch.stopall)
        patch.object(rp.resources, "files", return_value=PACKAGE).start()

    def put_existing(self, data):
        self.destination.parent.mkdir(parents=True, exist_ok=True)
        self.destination.write_bytes(data)

    def test_bundle_contains_every_current_resource_with_no_extra_files(self):
        data = rp.bundled_archive()
        self.assertEqual(rp.validate_archive(data), (1, 2, 0))
        source = ROOT / "resource_pack"
        expected = {p.relative_to(source).as_posix(): p.read_bytes() for p in source.rglob("*") if p.is_file()}
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertEqual(set(archive.namelist()), set(expected))
            for name, contents in expected.items():
                self.assertEqual(archive.read(name), contents, name)

    def test_fresh_server_installs_archive_without_world_or_settings_edits(self):
        existing = self.root / "resource_packs" / "another-pack.mcpack"
        existing.parent.mkdir()
        existing.write_bytes(b"unrelated")
        self.assertEqual(rp.install_bundled_resource_pack(self.root), "installed")
        self.assertEqual(self.destination.read_bytes(), rp.bundled_archive())
        self.assertEqual(existing.read_bytes(), b"unrelated")
        self.assertEqual((self.root / "server.properties").read_bytes(), self.original_settings)
        self.assertFalse((self.root / "worlds").exists())

    def test_unchanged_startup_does_not_rewrite_or_backup_archive(self):
        rp.install_bundled_resource_pack(self.root)
        with patch.object(rp, "atomic_write", side_effect=AssertionError("unchanged archive written")):
            self.assertEqual(rp.install_bundled_resource_pack(self.root), "unchanged")
        self.assertFalse(self.destination.with_suffix(".mcpack.bak").exists())

    def test_older_owned_pack_is_backed_up_before_update(self):
        old = pack_bytes(version=(1, 0, 9))
        self.put_existing(old)
        self.assertEqual(rp.install_bundled_resource_pack(self.root), "updated")
        self.assertEqual(self.destination.read_bytes(), rp.bundled_archive())
        self.assertEqual(self.destination.with_suffix(".mcpack.bak").read_bytes(), old)

    def test_newer_owned_pack_is_not_downgraded(self):
        old = pack_bytes(version=(2, 0, 0))
        self.put_existing(old)
        with self.assertRaisesRegex(ValueError, "newer"):
            rp.install_bundled_resource_pack(self.root)
        self.assertEqual(self.destination.read_bytes(), old)

    def test_unrelated_pack_at_target_is_never_overwritten(self):
        old = pack_bytes(pack_id="00000000-0000-0000-0000-000000000000")
        self.put_existing(old)
        with self.assertRaisesRegex(ValueError, "unrelated"):
            rp.install_bundled_resource_pack(self.root)
        self.assertEqual(self.destination.read_bytes(), old)

    def test_corrupted_target_is_preserved(self):
        self.put_existing(b"broken archive")
        with self.assertRaises(zipfile.BadZipFile):
            rp.install_bundled_resource_pack(self.root)
        self.assertEqual(self.destination.read_bytes(), b"broken archive")

    def test_unsafe_archive_paths_are_rejected(self):
        for name in ("../outside", "/outside", "C:/outside", "folder\\outside"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "Unsafe"):
                rp.validate_archive(pack_bytes(extra=name))

    def test_bundle_checksum_mismatch_writes_nothing(self):
        assets = self.root / "fake-package" / "assets"
        assets.mkdir(parents=True)
        (assets / "entity_ui_demo.mcpack").write_bytes(b"broken bundle")
        (assets / "resource_pack.json").write_text(json.dumps({"packId":rp.PACK_ID, "sha256":"0"*64}), encoding="utf-8")
        with patch.object(rp.resources, "files", return_value=assets.parent):
            with self.assertRaisesRegex(ValueError, "checksum"):
                rp.install_bundled_resource_pack(self.root)
        self.assertFalse(self.destination.exists())

    def test_missing_server_root_and_symlink_destinations_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "server.properties"):
            rp.install_bundled_resource_pack(ROOT / "tests")
        with patch.object(Path, "is_symlink", return_value=True):
            with self.assertRaisesRegex(ValueError, "symlink"):
                rp.install_bundled_resource_pack(self.root)
        self.assertFalse(self.destination.exists())

    def test_failed_replace_preserves_original_and_cleans_temporary_files(self):
        old = pack_bytes(version=(1, 0, 9))
        self.put_existing(old)
        original_replace = rp.os.replace
        def fail_target(source, destination):
            if Path(destination) == self.destination:
                raise OSError("disk full")
            return original_replace(source, destination)
        with patch.object(rp.os, "replace", side_effect=fail_target):
            with self.assertRaises(OSError):
                rp.install_bundled_resource_pack(self.root)
        self.assertEqual(self.destination.read_bytes(), old)
        self.assertEqual(self.destination.with_suffix(".mcpack.bak").read_bytes(), old)
        self.assertEqual(list(self.destination.parent.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
