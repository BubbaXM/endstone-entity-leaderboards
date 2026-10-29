"""Main-thread fake-actor renderer. No world entities, actor scans or ticking areas."""
import copy
import math
import secrets

from . import packets
from .model import LAYOUT, TYPES, board_id, fields, packed_layers, top_players, validate_board


def dimension_id(dimension):
    kind = dimension.type.value
    return {0: "minecraft:overworld", 1: "minecraft:nether", 2: "minecraft:the_end"}.get(kind, "unsupported")


def pose(player):
    location, ui = player.location, LAYOUT["ui"]
    yaw, pitch = math.radians(location.yaw), math.radians(location.pitch)
    view = {"x": -math.sin(yaw) * math.cos(pitch), "y": -math.sin(pitch), "z": math.cos(yaw) * math.cos(pitch)}
    normal = {"x": math.sin(yaw), "y": 0, "z": -math.cos(yaw)}
    right = {"x": normal["z"], "y": 0, "z": -normal["x"]}
    center = {c: getattr(location, c) + view[c] * ui["distance"] for c in "xyz"}
    center["y"] += 1.62 + .1
    for i in range(9):
        offset = (i / 8 - .5) * ui["width"] / ui["pxPerBlock"] * ui["scale"]
        x, y, z = center["x"] + right["x"] * offset, center["y"] - ui["height"] * ui["scale"] / (2 * ui["pxPerBlock"]), center["z"] + right["z"] * offset
        block = player.dimension.get_block_at(math.floor(x), math.floor(y), math.floor(z))
        if block.type not in {"minecraft:air", "minecraft:cave_air", "minecraft:void_air", "minecraft:water", "minecraft:flowing_water", "minecraft:lava", "minecraft:flowing_lava"}:
            center["y"] += 1
            break
    # Same 180-degree correction and model-X convention as spawnPose in the addon.
    render_yaw = math.degrees(math.atan2(-normal["x"], normal["z"])) + 180
    return {"center": center, "normal": normal, "right": right, "rotation": {"x": 0, "y": (render_yaw + 180) % 360 - 180}}


class Backend:
    SHOW_DISTANCE, HIDE_DISTANCE = 48, 56

    def __init__(self, server, store):
        if server.protocol_version not in packets.SUPPORTED_PROTOCOLS:
            raise ValueError(f"Unsupported Bedrock protocol {server.protocol_version}; packet rendering disabled (supported: 2193, 2225)")
        self.protocol = server.protocol_version
        self.server, self.store = server, store
        self.ready = False
        self.viewers, self.actors, self.payloads = {}, {}, {}
        self.snapshots, self.legacy_names = {}, {}
        self.identifier = (1 << 52) + secrets.randbits(40)
        self.polls, self.dirty = 0, False
        self.metrics = {"packets": 0, "bytes": 0, "scoreReads": 0, "payloadBuilds": 0}
        self.schema_packets = [(packets.SYNC_ACTOR_PROPERTY, packets.schema(kind, definitions))
                               for kind, definitions in LAYOUT["schemas"].items()]

    def send(self, player, packet_id, payload):
        player.send_packet(packet_id, payload)
        self.metrics["packets"] += 1
        self.metrics["bytes"] += len(payload)

    def sample(self, players):
        objectives = {b["objective"] for b in self.store.data["boards"]}
        result = {}
        for objective_id in objectives:
            objective = self.server.scoreboard.get_objective(objective_id)
            cache = self.store.data["scores"].setdefault(objective_id, {})
            changed = False
            if objective_id not in self.legacy_names:
                names = {}
                for key, entry in cache.items():
                    if key.startswith("legacy:"):
                        names.setdefault(entry["name"], []).append(key)
                self.legacy_names[objective_id] = names
            if objective is None:
                # Observed deletion invalidates cached scores, so recreation
                # cannot revive offline values from a different objective.
                if cache:
                    cache.clear()
                    self.dirty = True
                    changed = True
                self.legacy_names[objective_id].clear()
            else:
                for player in players:
                    key = str(player.unique_id)
                    score = objective.get_score(player)
                    self.metrics["scoreReads"] += 1
                    # Imported Script API IDs are not UUIDs. Merge their names
                    # only once when that real player is next observed online.
                    for old in self.legacy_names[objective_id].pop(player.name, []):
                        cache.pop(old, None)
                        self.dirty = True
                        changed = True
                    if score.is_score_set:
                        entry = {"name": player.name, "score": score.value}
                        if cache.get(key) != entry:
                            cache[key] = entry
                            self.dirty = True
                            changed = True
                    else:
                        if key in cache:
                            del cache[key]
                            self.dirty = True
                            changed = True
            display = objective.display_name if objective else None
            previous = self.snapshots.get(objective_id)
            if changed or previous is None or previous[0] != display:
                previous = (display, top_players(cache, 15))
                self.snapshots[objective_id] = previous
            result[objective_id] = previous
        self.snapshots = {k: v for k, v in self.snapshots.items() if k in objectives}
        self.legacy_names = {k: v for k, v in self.legacy_names.items() if k in objectives}
        return result

    def flush(self):
        if self.dirty:
            self.store.commit(copy.deepcopy(self.store.data))
            self.dirty = False

    def create(self, player, objective, amount):
        if not self.ready:
            raise ValueError("Packet leaderboards are waiting for the startup handoff; check the server log.")
        # Validate before touching block APIs, allocating IDs or saving.
        board = {"id": str(self.store.data["nextId"]), "objective": objective, "amount": amount,
                 "dimension": dimension_id(player.dimension), "pose": {"center": {c: 0 for c in "xyz"}, "rotation": {"x": 0, "y": 0}}}
        validate_board(board)
        if not self.server.scoreboard.get_objective(objective):
            raise ValueError(f"Scoreboard '{objective}' does not exist. Use its objective ID.")
        board["pose"] = pose(player)
        data = copy.deepcopy(self.store.data)
        data["boards"].append(board)
        data["nextId"] += 1
        self.store.commit(data)
        self.dirty = False
        return board

    def remove(self, value):
        if not self.ready:
            raise ValueError("Packet leaderboards are not ready; check the server log.")
        key = board_id(value)
        board = next((b for b in self.store.data["boards"] if b["id"] == key), None)
        if board is None:
            raise ValueError(f"Leaderboard #{key} does not exist.")
        data = copy.deepcopy(self.store.data)
        data["boards"] = [b for b in data["boards"] if b["id"] != key]
        if not any(b["objective"] == board["objective"] for b in data["boards"]):
            data["scores"].pop(board["objective"], None)
        self.store.commit(data)  # Failure leaves viewer state/actors untouched.
        self.dirty = False
        if not any(b["objective"] == board["objective"] for b in data["boards"]):
            self.snapshots.pop(board["objective"], None)
            self.legacy_names.pop(board["objective"], None)
        return board  # The next poll removes it from every connected viewer.

    def actors_for(self, board, properties):
        if board["id"] not in self.actors:
            actors = []
            yaw = board["pose"]["rotation"]["y"]
            angle = math.radians(yaw)
            for i, props in enumerate(properties):
                self.identifier += 1
                kind = TYPES[0 if i == 0 else 1]
                offset = 0 if i == 0 else .003 + (i - 1) * .0005
                center = board["pose"]["center"]
                actors.append({"unique": -self.identifier, "runtime": self.identifier, "kind": kind,
                               "position": (center["x"] + math.sin(angle) * offset, center["y"], center["z"] - math.cos(angle) * offset), "yaw": yaw})
            self.actors[board["id"]] = actors
        return self.actors[board["id"]]

    @staticmethod
    def indexed(kind, props):
        definitions = LAYOUT["schemas"][kind]
        return [(i, props.get(name, d["default"])) for i, (name, d) in enumerate(definitions.items())]

    def hide(self, player, key, viewer):
        record = viewer["boards"].get(key)
        if record:
            for actor in record["actors"]:
                self.send(player, packets.REMOVE_ACTOR, packets.remove_actor(actor["unique"]))
            del viewer["boards"][key]

    def reset(self, player):
        viewer = self.viewers.get(str(player.unique_id))
        if viewer:
            for key in list(viewer["boards"]):
                self.hide(player, key, viewer)
            self.viewers.pop(str(player.unique_id), None)

    def forget(self, player):
        self.viewers.pop(str(player.unique_id), None)

    def tick(self):
        if not self.ready:
            return
        boards = {b["id"]: b for b in self.store.data["boards"]}
        if not boards and not any(v["boards"] for v in self.viewers.values()):
            self.viewers.clear()
            self.actors.clear()
            self.payloads.clear()
            self.snapshots.clear()
            self.legacy_names.clear()
            self.flush()
            return
        players = list(self.server.online_players)  # No retained native Player/Actor wrappers.
        online = {str(p.unique_id) for p in players}
        for key in list(self.viewers):
            if key not in online:
                del self.viewers[key]
        self.polls += 1
        snapshots = self.sample(players) if boards else {}
        shared, board_props = {}, {}
        for key, board in boards.items():
            display, entries = snapshots[board["objective"]]
            entries = entries[:board["amount"]]
            signature = (display, tuple((e["id"], e["name"], e["score"]) for e in entries))
            payload_key = (board["objective"], board["amount"])
            if payload_key not in shared:
                previous = self.payloads.get(payload_key)
                if previous is None or previous[0] != signature:
                    values = packed_layers(fields(board, display, entries), board["amount"])
                    previous = (signature, [{"ns:page": LAYOUT["page"], "ns:scale": 1000, "ns:transparent": 1}, *values])
                    self.payloads[payload_key] = previous
                    self.metrics["payloadBuilds"] += 1
                shared[payload_key] = previous[1]
            board_props[key] = shared[payload_key]
        for player in players:
            if player.is_dead:
                self.reset(player)
                continue
            key = str(player.unique_id)
            dimension = dimension_id(player.dimension)
            viewer = self.viewers.setdefault(key, {"dimension": dimension, "boards": {}, "schemas": False, "age": 0})
            if viewer["dimension"] != dimension:
                self.reset(player)
                continue
            viewer["age"] += 1
            if viewer["age"] < 2:  # Let join/dimension resource/schema handshake finish.
                continue
            for old in list(viewer["boards"]):
                if old not in boards:
                    self.hide(player, old, viewer)
            location = player.location
            for board_id_, board in boards.items():
                visible = board_id_ in viewer["boards"]
                center = board["pose"]["center"]
                distance = sum((getattr(location, c) - center[c]) ** 2 for c in "xyz")
                limit = self.HIDE_DISTANCE if visible else self.SHOW_DISTANCE
                if board["dimension"] != dimension or distance > limit ** 2:
                    if visible:
                        self.hide(player, board_id_, viewer)
                    continue
                props = board_props[board_id_]
                actors = self.actors_for(board, props)
                if not viewer["schemas"]:
                    for packet_id, payload in self.schema_packets:
                        self.send(player, packet_id, payload)
                    viewer["schemas"] = True
                if not visible:
                    # Record first, so a partial send is cleaned up on failure/retry.
                    viewer["boards"][board_id_] = {"actors": actors, "props": []}
                    try:
                        for actor, values in zip(actors, props):
                            self.send(player, packets.ADD_ACTOR, packets.add_actor(actor["unique"], actor["runtime"], actor["kind"], actor["position"], actor["yaw"], self.indexed(actor["kind"], values), self.protocol))
                    except Exception:
                        self.hide(player, board_id_, viewer)
                        raise
                elif viewer["boards"][board_id_]["props"] is not props:
                    for actor, previous, values in zip(actors, viewer["boards"][board_id_]["props"], props):
                        changed = [(i, value) for (i, value), (_, old) in zip(self.indexed(actor["kind"], values), self.indexed(actor["kind"], previous)) if value != old]
                        if changed:
                            self.send(player, packets.SET_ACTOR_DATA, packets.set_actor_data(actor["runtime"], changed))
                viewer["boards"][board_id_]["props"] = props
        for key in list(self.actors):
            if key not in boards:
                del self.actors[key]
        self.payloads = {k: v for k, v in self.payloads.items() if k in shared}
        if self.polls % 5 == 0:
            self.flush()

    def close(self):
        try:
            for player in list(self.server.online_players):
                self.reset(player)
        finally:
            self.flush()
