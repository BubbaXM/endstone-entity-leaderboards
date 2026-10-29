"""Install the packaged RP during on_load, before Endstone's pack discovery.

Only our archive is changed. No world lists, server settings or gameplay data
are edited. Endstone 0.11.14 auto-activates .mcpack archives in resource_packs.
"""
import hashlib
from importlib import resources
import io
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
import zipfile

PACK_ID = "c05a94e1-7c75-4cbb-8bcd-c08cf7f2e83e"
ARCHIVE_NAME = "ns_entity_ui_demo.mcpack"


def validate_archive(data):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if not entries or len(entries) > 10000 or sum(e.file_size for e in entries) > 128 * 1024 * 1024:
            raise ValueError("Invalid resource-pack size")
        names = set()
        for entry in entries:
            # ZipInfo normalizes Windows separators in filename; inspect the
            # original stored name as well, so validation is platform-neutral.
            name = entry.orig_filename
            path = PurePosixPath(name)
            if (path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name or
                    name.casefold() in names or entry.flag_bits & 1 or
                    (entry.external_attr >> 16) & 0o170000 == 0o120000):
                raise ValueError("Unsafe or duplicate resource-pack entry")
            names.add(name.casefold())
        if archive.testzip() is not None:
            raise ValueError("Corrupted resource pack")
        manifest = json.loads(archive.read("manifest.json"))
    header = manifest["header"]
    version = header["version"]
    if (header["uuid"] != PACK_ID or not isinstance(version, list) or len(version) != 3 or
            any(type(v) is not int or v < 0 for v in version) or
            not manifest.get("modules") or any(m["type"] != "resources" for m in manifest["modules"])):
        raise ValueError("Refusing an unrelated or invalid resource pack")
    return tuple(version)


def bundled_archive():
    assets = resources.files("ns_lb_bridge").joinpath("assets")
    data = assets.joinpath("entity_ui_demo.mcpack").read_bytes()
    index = json.loads(assets.joinpath("resource_pack.json").read_text(encoding="utf-8"))
    if index["packId"] != PACK_ID or hashlib.sha256(data).hexdigest() != index["sha256"]:
        raise ValueError("Bundled resource-pack checksum mismatch; rebuild/reinstall the plugin")
    if validate_archive(data) != tuple(index["version"]):
        raise ValueError("Bundled resource-pack version mismatch")
    return data


def atomic_write(path, data):
    fd, temporary = tempfile.mkstemp(prefix=".ns-resource-pack-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install_bundled_resource_pack(server_root):
    data = bundled_archive()
    version = validate_archive(data)
    root = Path(server_root).resolve(strict=True)
    if not (root / "server.properties").is_file():
        raise ValueError("Cannot locate server.properties; resource pack not installed")
    directory = root / "resource_packs"
    target = directory / ARCHIVE_NAME
    backup = target.with_suffix(".mcpack.bak")
    if directory.is_symlink() or target.is_symlink() or backup.is_symlink():
        raise ValueError("Refusing resource-pack symlink destination")
    if not target.resolve().is_relative_to(root):
        raise ValueError("Resource-pack destination escapes the server directory")
    original = target.read_bytes() if target.exists() else None
    if original == data:
        return "unchanged"
    if original is not None:
        if validate_archive(original) > version:
            raise ValueError("Installed resource pack is newer; refusing to downgrade it")
    directory.mkdir(parents=True, exist_ok=True)
    if original is not None:
        atomic_write(backup, original)
    atomic_write(target, data)
    return "updated" if original is not None else "installed"
