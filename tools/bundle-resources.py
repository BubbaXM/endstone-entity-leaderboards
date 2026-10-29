"""Reproducibly bundle the current RP inside the Python plugin (stdlib only)."""
import hashlib
import io
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def build_bundle():
    source = ROOT / "resource_pack"
    manifest = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    files = sorted(p for p in source.rglob("*") if p.is_file())
    stream = io.BytesIO()
    total = 0
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            if path.is_symlink():
                raise ValueError(f"Refusing to bundle symlink: {path}")
            data = path.read_bytes()
            total += len(data)
            entry = zipfile.ZipInfo(path.relative_to(source).as_posix(), (1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data, compresslevel=9)
    data = stream.getvalue()
    target = ROOT / "server_bridge" / "ns_lb_bridge" / "assets"
    target.mkdir(parents=True, exist_ok=True)
    (target / "entity_ui_demo.mcpack").write_bytes(data)
    (target / "resource_pack.json").write_text(json.dumps({
        "packId": manifest["header"]["uuid"], "version": manifest["header"]["version"],
        "sha256": hashlib.sha256(data).hexdigest(), "files": len(files), "uncompressedBytes": total,
    }, indent=2) + "\n", encoding="utf-8")
    print(f"Bundled resource pack: {len(files)} files, {len(data):,} bytes -> {target}")


if __name__ == "__main__":
    build_bundle()
