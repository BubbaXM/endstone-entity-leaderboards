"""Validate RECORD/assets and smoke-test a clean pip installation of the wheel."""
import base64
import csv
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def verify(wheel):
    with zipfile.ZipFile(wheel) as archive:
        names = archive.namelist()
        assert len(names) == len(set(names)), "Duplicate wheel entries"
        assert all(not PurePosixPath(n).is_absolute() and ".." not in PurePosixPath(n).parts and
                   "\\" not in n and ":" not in n for n in names), "Unsafe wheel path"
        record = next(n for n in names if n.endswith(".dist-info/RECORD"))
        rows = list(csv.reader(io.StringIO(archive.read(record).decode("utf-8"))))
        assert {r[0] for r in rows} == set(names), "Incomplete RECORD"
        for name, digest, size in rows:
            if name == record:
                continue
            data = archive.read(name)
            expected = "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
            assert digest == expected and int(size) == len(data), name
        package = "ns_lb_bridge/"
        data = archive.read(package + "assets/entity_ui_demo.mcpack")
        index = json.loads(archive.read(package + "assets/resource_pack.json"))
        assert hashlib.sha256(data).hexdigest() == index["sha256"]
        assert data == (ROOT / "server_bridge" / package / "assets/entity_ui_demo.mcpack").read_bytes()
        assert archive.read(package + "layout.json") == (ROOT / "server_bridge" / package / "layout.json").read_bytes()
        metadata = archive.read(record.replace("RECORD", "METADATA")).decode()
        assert "Name: endstone-leaderboard-bridge\n" in metadata and "Version: 1.2.1\n" in metadata
        assert "Requires-Dist:" not in metadata, "Unexpected runtime dependency"
        assert "leaderboard_bridge = ns_lb_bridge:LeaderboardBridgePlugin" in archive.read(record.replace("RECORD", "entry_points.txt")).decode()
    with tempfile.TemporaryDirectory(prefix="wheel-smoke-", dir=ROOT / "tests") as temporary:
        directory = Path(temporary)
        installed, server = directory / "installed", directory / "server"
        server.mkdir()
        (server / "server.properties").write_text("level-name=TestWorld\n", encoding="utf-8")
        subprocess.run([sys.executable, "-m", "pip", "install", "--no-deps", "--no-compile", "--quiet",
                        "--disable-pip-version-check", "--target", str(installed), str(wheel.resolve())], check=True)
        # A separate interpreter ensures the source package/mocked tests cannot
        # hide a missing package-data entry in the delivered wheel.
        probe = """import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import ns_lb_bridge
from ns_lb_bridge.resource_pack import install_bundled_resource_pack
assert Path(ns_lb_bridge.__file__).is_relative_to(Path(sys.argv[1]))
assert install_bundled_resource_pack(sys.argv[2]) == 'installed'
assert install_bundled_resource_pack(sys.argv[2]) == 'unchanged'
print('Clean WHL install: bundled RP installed and second startup made no changes')
"""
        subprocess.run([sys.executable, "-B", "-c", probe, str(installed), str(server)], check=True, cwd=server)
        assert (server / "resource_packs/ns_entity_ui_demo.mcpack").read_bytes() == data
        assert not (server / "worlds").exists()
    print(f"Verified wheel RECORD, metadata, bundled RP and clean installation: {wheel}")


if __name__ == "__main__":
    verify(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist/endstone_leaderboard_bridge-1.2.1-py3-none-any.whl")
