"""Pure layout packing and atomic Endstone registry, independent of native APIs."""
import copy
import json
import math
import os
from pathlib import Path
import re
import tempfile

LAYOUT = json.loads(Path(__file__).with_name("layout.json").read_text(encoding="utf-8"))
TYPES = tuple(LAYOUT["schemas"])
MAX_ID = 9007199254740991
DIMENSIONS = {"minecraft:overworld", "minecraft:nether", "minecraft:the_end"}
OFFLINE_NAME_PLACEHOLDER = "commands.scoreboard.players.offlineplayername"


def unresolved_player_name(name):
    # Script API migration can expose a translation key instead of an offline
    # player's name. Do not guess their identity or discard named offline users.
    return re.sub(r"§.", "", name).strip().casefold() == OFFLINE_NAME_PLACEHOLDER


def board_id(value):
    value = str(value)
    if not re.fullmatch(r"[0-9]+", value) or not 1 <= int(value) <= MAX_ID:
        raise ValueError("Provide a positive leaderboard ID. Usage: /lb remove <id>")
    return str(int(value))


def validate_board(board):
    if board_id(board["id"]) != board["id"]:
        raise ValueError("Noncanonical board ID")
    objective, amount = board["objective"], board["amount"]
    if not isinstance(objective, str) or not 1 <= len(objective) <= 128 or any(c in objective for c in "\r\n\0"):
        raise ValueError("Provide an existing scoreboard objective ID.")
    if type(amount) is not int or not 1 <= amount <= 15 or board["dimension"] not in DIMENSIONS:
        raise ValueError("Invalid leaderboard amount/dimension")
    values = [board["pose"]["center"][c] for c in "xyz"] + [board["pose"]["rotation"][c] for c in "xy"]
    if any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 30000000 for v in values):
        raise ValueError("Invalid leaderboard pose")


def validate_registry(data):
    if not isinstance(data, dict) or data.get("version") != 2 or data.get("backend") != "packets":
        raise ValueError("Invalid packet registry; original data preserved")
    boards, next_id = data["boards"], data["nextId"]
    if not isinstance(boards, list) or type(next_id) is not int or not 1 <= next_id <= MAX_ID:
        raise ValueError("Invalid registry")
    for board in boards:
        validate_board(board)
    if len({b["id"] for b in boards}) != len(boards) or any(int(b["id"]) >= next_id for b in boards):
        raise ValueError("Invalid registry IDs")
    for objective, entries in data["scores"].items():
        if not isinstance(objective, str) or not isinstance(entries, dict):
            raise ValueError("Invalid score cache")
        for key, entry in entries.items():
            if not isinstance(key, str) or not isinstance(entry["name"], str) or type(entry["score"]) is not int:
                raise ValueError("Invalid cached player score")
    return data


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.exists = self.path.exists()
        self.data = (validate_registry(json.loads(self.path.read_text(encoding="utf-8"))) if self.exists else
                     {"version": 2, "backend": "packets", "nextId": 1, "boards": [], "scores": {}})
        if self.exists:
            # One-time repair of already imported caches, before ranking begins.
            # Commit preserves the previous file in leaderboards.json.bak.
            cleaned = copy.deepcopy(self.data)
            for entries in cleaned["scores"].values():
                for key in list(entries):
                    if unresolved_player_name(entries[key]["name"]):
                        del entries[key]
            if cleaned != self.data:
                self.commit(cleaned)

    def commit(self, data):
        validate_registry(data)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        serialized = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        # Backup the last successful snapshot before replacing it. fsync makes
        # migration acknowledgement depend on a durable write, not memory state.
        if self.path.exists():
            self._atomic(self.path.with_suffix(".json.bak"), self.path.read_bytes())
        self._atomic(self.path, serialized)
        self.data, self.exists = data, True

    @staticmethod
    def _atomic(path, data):
        fd, temporary = tempfile.mkstemp(prefix=".leaderboards-", dir=path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def import_legacy(self, payload):
        if self.exists:
            return  # Never resurrect old dynamic-property boards after removal.
        legacy = payload["registry"]
        if legacy.get("version") != 1:
            raise ValueError("Invalid legacy registry")
        data = {"version": 2, "backend": "packets", "nextId": legacy["nextId"],
                "boards": copy.deepcopy(legacy["boards"]), "scores": {}}
        objectives = {b["objective"] for b in data["boards"]}
        for objective, entries in payload.get("scores", {}).items():
            if objective not in objectives:
                continue
            data["scores"][objective] = {"legacy:" + str(e["id"]): {"name": e["name"], "score": e["score"]}
                                        for e in entries if not unresolved_player_name(e["name"])}
        self.commit(data)
        self._atomic(self.path.with_name("leaderboards.legacy-import.json"), self.path.read_bytes())


def wrap_text(value, width, rows):
    # Same word wrapping and UTF-16 cell indexing as core.js (not mirrored).
    value = re.sub(r"[\U00010000-\U0010ffff]", "  ", str(value).upper())
    lines = [""]
    for original in re.split(r"\s+", value):
        word = original
        if lines[-1] and len(lines[-1]) + len(word) + 1 > width:
            lines.append("")
        while len(word) > width:
            if lines[-1]:
                lines.append("")
            lines[-1] = word[:width]
            word = word[width:]
            lines.append("")
        lines[-1] += (" " if lines[-1] else "") + word
    return "".join((lines[i] if i < len(lines) else "")[:width].ljust(width) for i in range(rows))


def packed_layers(fields, amount):
    cells, alphabet, ui = LAYOUT["cells"], LAYOUT["alphabet"], LAYOUT["ui"]
    end = next((i for i, c in enumerate(cells) if c["field"] == f"rank{amount}"), len(cells))
    count = math.ceil(end / ui["cellsPerLayer"])
    cache, result = {}, []
    for layer in range(count):
        glyphs = []
        for cell in cells[layer * ui["cellsPerLayer"]:(layer + 1) * ui["cellsPerLayer"]]:
            name = cell["field"]
            if name not in cache:
                cache[name] = wrap_text(fields.get(name, ""), cell["width"], cell["rows"])
            char = cache[name][cell["index"]]
            glyphs.append(max(0, alphabet.find(char)))
        props = {"ns:page": LAYOUT["page"], "ns:layer": layer, "ns:scale": round(ui["scale"] * 1000)}
        for pack in range(ui["textPacks"]):
            props[f"ns:t{pack}"] = sum((glyphs[i] if i < len(glyphs) else 0) * 64 ** (i % 4)
                                      for i in range(pack * 4, pack * 4 + 4))
        result.append(props)
    return result


def top_players(entries, amount):
    # Bounded insertion, O(players * 15), no sorted copy of the entire cache.
    top = []
    for key, entry in entries.items():
        if unresolved_player_name(entry["name"]):
            continue
        candidate = {"id": key, **entry}
        order = lambda e: (-e["score"], e["name"], e["id"])
        index = next((i for i, e in enumerate(top) if order(candidate) < order(e)), len(top))
        if index < amount:
            top.insert(index, candidate)
            del top[amount:]
    return top


def fields(board, display_name, entries):
    clean = lambda s: re.sub(r"§.", "", s)
    result = {"title": "LEADERBOARD / " + clean(display_name if display_name is not None else board["objective"]),
              "objective": "SCOREBOARD: " + board["objective"], "headerRank": "#", "headerName": "PLAYER",
              "headerScore": "SCORE", "status": (f"TOP {board['amount']} / {len(entries)} PLAYERS / LIVE SCORES" if entries else "NO PLAYER SCORES YET")}
    if display_name is None:
        result["status"] = "SCOREBOARD MISSING - WAITING FOR OBJECTIVE"
    for i in range(15):
        entry = entries[i] if i < len(entries) else None
        result.update({f"rank{i}": f"{i + 1}." if entry else "", f"player{i}": clean(entry["name"]) if entry else "",
                       f"score{i}": str(entry["score"]) if entry else ""})
    return result
