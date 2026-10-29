"""Packet vectors, persistence, caching and viewer lifecycles without native actors."""
import copy
import enum
import importlib
import json
from pathlib import Path
import random
import struct
import sys
import tempfile
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import patch

endstone, plugin_module, event_module, command_module = [ModuleType(n) for n in ("endstone", "endstone.plugin", "endstone.event", "endstone.command")]
class DimensionType(enum.Enum):
    OVERWORLD = 0
    NETHER = 1
class Sender:
    def __init__(self):
        self.messages, self.errors = [], []
    def has_permission(self, _): return True
    def send_message(self, message): self.messages.append(message)
    def send_error_message(self, message): self.errors.append(message)
class Console(Sender):
    pass
class Player(Sender):
    def __init__(self, key="uuid-1", name="Bubba XM", allowed=True):
        super().__init__()
        self.allowed, self.unique_id, self.name, self.is_dead = allowed, key, name, False
        self.location = NS(x=0, y=0, z=0, yaw=0, pitch=0)
        self.dimension = NS(type=DimensionType.OVERWORLD, get_block_at=lambda *_: NS(type="minecraft:air"))
        self.packets, self.titles = [], []
    def has_permission(self, _): return self.allowed
    def send_packet(self, packet_id, payload): self.packets.append((packet_id, payload))
    def send_title(self, *args): self.titles.append(args)
endstone.Player, plugin_module.Plugin, command_module.ConsoleCommandSender = Player, object, Console
event_module.event_handler = lambda fn: fn
for name in ("ScriptMessageEvent", "PlayerJoinEvent", "PlayerQuitEvent", "PlayerRespawnEvent", "PlayerDimensionChangeEvent"):
    setattr(event_module, name, type(name, (), {}))
for name, module in (("endstone", endstone), ("endstone.plugin", plugin_module), ("endstone.event", event_module), ("endstone.command", command_module)):
    sys.modules[name] = module
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server_bridge"))
Bridge = importlib.import_module("ns_lb_bridge").LeaderboardBridgePlugin
from ns_lb_bridge import packets
from ns_lb_bridge.backend import Backend, dimension_id, pose
from ns_lb_bridge.model import Store, LAYOUT, TYPES, fields, packed_layers, top_players, wrap_text


class Reader:
    """Independent decoder, with exhaustion checks to catch omitted wire fields."""
    def __init__(self, data): self.data, self.offset = data, 0
    def take(self, count):
        data = self.data[self.offset:self.offset + count]
        if len(data) != count: raise AssertionError("Truncated packet")
        self.offset += count
        return data
    def byte(self): return self.take(1)[0]
    def uint(self):
        result, shift = 0, 0
        while True:
            b = self.byte(); result |= (b & 127) << shift
            if not b & 128: return result
            shift += 7
            if shift > 63: raise AssertionError("Invalid varint")
    def sint(self):
        value = self.uint()
        return (value >> 1) ^ -(value & 1)
    def string(self): return self.take(self.uint()).decode("utf-8")
    def done(self): assert self.offset == len(self.data), (self.offset, len(self.data))
    def props(self):
        result = {}
        for _ in range(self.uint()):
            index = self.uint(); result[index] = self.sint()
        assert self.uint() == 0  # floats
        return result
    def nbt_value(self, kind):
        if kind == 3: return self.sint()
        if kind == 8: return self.string()
        if kind == 9:
            element = self.byte(); count = self.sint()
            assert count >= 0
            return [self.nbt_value(element) for _ in range(count)]
        if kind == 10:
            result = {}
            while True:
                child = self.byte()
                if child == 0: return result
                name = self.string(); result[name] = self.nbt_value(child)
        raise AssertionError(f"Unexpected NBT tag {kind}")


def decode_actor(payload, protocol=2193):
    r = Reader(payload)
    unique, runtime, kind = r.sint(), r.uint(), r.string()
    floats = struct.unpack("<10f", r.take(40))
    assert r.uint() == 0  # attributes
    assert r.uint() == 1 and r.uint() == 0  # one metadata entry, actor flags
    assert r.byte() == 7  # variant index: Int64
    # Since protocol 2168 the payload must restate its type after the index.
    assert r.byte() == 7, "Missing or mismatched metadata payload type"
    flags, props = r.sint(), r.props()
    assert r.uint() == 0  # links
    if protocol == 2225:
        assert r.byte() == 0  # no PassengerOfBlockArguments
    r.done()
    return unique, runtime, kind, floats, flags, props


class PacketTests(unittest.TestCase):
    def test_varint_golden_and_limits(self):
        for value, expected in ((0,"00"),(127,"7f"),(128,"8001"),(300,"ac02")):
            self.assertEqual(packets.uint(value).hex(), expected)
        for value, expected in ((-1,"01"),(0,"00"),(1,"02"),(-2147483648,"ffffffff0f"),(16777215,"feffff0f")):
            self.assertEqual(packets.sint(value).hex(), expected)
        for value in (-1, 1 << 64):
            with self.assertRaises(ValueError): packets.uint(value)
        with self.assertRaises(ValueError): packets.sint(1 << 31)
    def test_add_actor_exact_complete_schema(self):
        data = packets.add_actor(-1, 2, "ns:x", (1,2,3), 90, [(0,6),(1,16777215)])
        self.assertTrue(data.startswith(bytes.fromhex("0102046e733a78")))
        unique,runtime,kind,values,flags,props = decode_actor(data)
        self.assertEqual((unique,runtime,kind),(-1,2,"ns:x"))
        self.assertEqual(values,(1,2,3,0,0,0,0,90,90,90));self.assertEqual(props,{0:6,1:16777215})
        self.assertTrue(flags & (1<<16));self.assertFalse(flags & ((1<<5)|(1<<48)|(1<<49)))
    def test_add_actor_2193_golden_restates_metadata_type(self):
        # Fixed wire vector, not generated with our varint/metadata helpers.
        # EndstoneMC/bedrock-protocol tests/test_013_add_actor.cpp documents
        # the variant-index + payload-type pair required since protocol 2168.
        expected = bytes.fromhex("0102046e733a78") + bytes(40) + bytes.fromhex(
            "00"          # attributes: empty
            "01 00"       # metadata: one entry, actor flags (id 0)
            "07 07"       # Int64 variant index AND restated payload type
            "80 80 18"    # flags 196608, zigzag-encoded
            "00 00 00"    # int properties, float properties, links: empty
        )
        actual = packets.add_actor(-1, 2, "ns:x", (0,0,0), 0, [])
        self.assertEqual(actual, expected)
        self.assertEqual(decode_actor(expected)[-2:], (196608, {}))
    def test_decoder_rejects_legacy_missing_metadata_type_byte(self):
        # Old encoder emitted only one 07, so 80 (the flag value) was read
        # as the payload type by current clients. It must never pass again.
        broken = bytes.fromhex("0102046e733a78") + bytes(40) + bytes.fromhex(
            "00 01 00 07 80 80 18 00 00 00"
        )
        with self.assertRaisesRegex(AssertionError, "metadata payload type"):
            decode_actor(broken)
    def test_metadata_delta_golden(self):
        data = packets.set_actor_data(2, [(3,-1),(4,16777215)])
        self.assertEqual(data.hex(),"020002030104feffff0f0000")
        r=Reader(data);self.assertEqual(r.uint(),2);self.assertEqual(r.uint(),0);self.assertEqual(r.props(),{3:-1,4:16777215});self.assertEqual(r.uint(),0);r.done()
    def test_removal_uses_signed_unique_id_not_runtime(self):
        self.assertEqual(packets.remove_actor(-1),b"\x01")
        r=Reader(packets.remove_actor(-(1<<52)));self.assertEqual(r.sint(),-(1<<52));r.done()
    def test_property_schema_network_nbt_order_and_ranges(self):
        for kind, definitions in LAYOUT["schemas"].items():
            r=Reader(packets.schema(kind,definitions));self.assertEqual(r.byte(),10);self.assertEqual(r.string(),"")
            root=r.nbt_value(10);r.done();self.assertEqual(root["type"],kind)
            self.assertEqual([p["name"] for p in root["properties"]],list(definitions))
            for value,definition in zip(root["properties"],definitions.values()):
                self.assertEqual((value["type"],value["min"],value["max"]),(0,*definition["range"]))
    def test_all_generated_property_values_exact_in_float32(self):
        props=packed_layers(fields({"objective":"kills","amount":15},"Kills",[{"name":"BUBBA XM","score":999999999}]),15)
        self.assertEqual(len(props),7)
        for layer in props:
            for value in layer.values(): self.assertEqual(struct.unpack("<f",struct.pack("<f",value))[0],value)
    def test_wrapping_matches_js_cases(self):
        self.assertEqual(wrap_text("hello world",8,2),"HELLO   WORLD   ")
        self.assertEqual(wrap_text("123456789",4,3),"123456789   ")
    def test_bounded_ranking_matches_full_sort(self):
        random.seed(45)
        entries={str(i):{"name":f"Player {random.randrange(200)}","score":random.randrange(-100,100)} for i in range(10000)}
        expected=sorted(({"id":k,**v} for k,v in entries.items()),key=lambda e:(-e["score"],e["name"],e["id"]))[:15]
        self.assertEqual(top_players(entries,15),expected)
    def test_ranking_skips_placeholder_before_applying_row_limit(self):
        entries = {
            "unknown": {"name": "commands.scoreboard.players.offlinePlayerName", "score": 999999999},
            "uuid-1": {"name": "Bubba XM", "score": 10},
            "legacy:2": {"name": "Offline Player", "score": 9},
        }
        ranked = top_players(entries, 1)
        self.assertEqual([e["name"] for e in ranked], ["Bubba XM"])
        rendered = fields({"objective": "money", "amount": 1}, "Money", ranked)
        self.assertEqual(rendered["status"], "TOP 1 / 1 PLAYERS / LIVE SCORES")
        self.assertEqual(rendered["player0"], "Bubba XM")
        self.assertEqual(len(entries), 3)  # Ranking never edits caller's cache.


class Fixture(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="packet-test-",dir=Path(__file__).parent);self.addCleanup(self.temp.cleanup)
        self.store=Store(Path(self.temp.name)/"leaderboards.json")
        self.player=Player();self.values={self.player.unique_id:10}
        self.objective=NS(display_name="Kills",get_score=lambda p:NS(is_score_set=p.unique_id in self.values,value=self.values.get(p.unique_id,0)))
        self.objectives={"kills":self.objective}
        self.server=NS(protocol_version=2193,online_players=[self.player],scoreboard=NS(get_objective=self.objectives.get))
        self.backend=Backend(self.server,self.store);self.backend.ready=True
    def create(self,amount=5): return self.backend.create(self.player,"kills",amount)
    def show(self): self.backend.tick();self.backend.tick()


class BackendTests(Fixture):
    def test_2225_spawn_includes_passenger_optional_for_every_layer(self):
        self.server.protocol_version = 2225
        self.backend = Backend(self.server, self.store)
        self.backend.ready = True
        self.create(15)
        self.show()
        actors = [decode_actor(p, 2225) for k, p in self.player.packets if k == 13]
        self.assertEqual(len(actors), 8)
        self.assertTrue(all(a[0] < 0 and a[1] > 0 for a in actors))

    def test_protocol_gate_before_any_packets(self):
        self.server.protocol_version=2168
        with self.assertRaisesRegex(ValueError,"Unsupported"): Backend(self.server,self.store)
        self.assertEqual(self.player.packets,[])
    def test_no_boards_no_score_reads_packets_or_entities(self):
        for _ in range(10): self.backend.tick()
        self.assertEqual(self.backend.metrics,{"packets":0,"bytes":0,"scoreReads":0,"payloadBuilds":0})
    def test_spawn_schema_before_actors_complete_initial_props(self):
        board=self.create(15);self.show()
        self.assertEqual([p[0] for p in self.player.packets[:2]],[165,165])
        actors=[decode_actor(p) for k,p in self.player.packets if k==13]
        self.assertEqual(len(actors),8);self.assertEqual(len(actors[0][-1]),len(LAYOUT["schemas"][TYPES[0]]))
        self.assertTrue(all(len(a[-1])==32 for a in actors[1:]));self.assertEqual(actors[0][2],TYPES[0])
        for actual,c in zip(actors[0][3][:3],"xyz"):
            self.assertAlmostEqual(actual,board["pose"]["center"][c],places=5)
    def test_unchanged_board_sends_nothing_and_packs_once(self):
        self.create();self.show();before=self.backend.metrics.copy()
        with patch("ns_lb_bridge.backend.top_players",side_effect=AssertionError("Unchanged standings reranked")),patch.object(self.backend,"indexed",side_effect=AssertionError("Unchanged properties diffed")):
            for _ in range(5): self.backend.tick()
        self.assertEqual(self.backend.metrics["packets"],before["packets"])
        self.assertEqual(self.backend.metrics["payloadBuilds"],1)
    def test_changed_score_sends_only_glyph_property_deltas(self):
        self.create();self.show();self.player.packets.clear();self.values[self.player.unique_id]=11;self.backend.tick()
        self.assertTrue(self.player.packets)
        for kind,payload in self.player.packets:
            self.assertEqual(kind,39);r=Reader(payload);r.uint();self.assertEqual(r.uint(),0);props=r.props()
            self.assertTrue(props);self.assertLess(len(props),27);self.assertTrue(all(i>=5 for i in props));r.uint();r.done()
    def test_objective_reads_and_text_shared_across_identical_boards(self):
        self.create();self.create();self.show()
        self.assertEqual(self.backend.metrics["scoreReads"],2);self.assertEqual(self.backend.metrics["payloadBuilds"],1)
    def test_range_hysteresis_remove_and_reenter(self):
        self.create();self.show();actors=len(self.backend.actors["1"]);self.player.packets.clear()
        self.player.location.x=50;self.backend.tick();self.assertEqual(self.player.packets,[])
        self.player.location.x=60;self.backend.tick();self.assertEqual([k for k,p in self.player.packets],[14]*actors)
        self.player.packets.clear();self.player.location.x=0;self.backend.tick();self.assertEqual([k for k,p in self.player.packets],[13]*actors)
    def test_other_dimension_never_gets_board_and_reset_resends_schema(self):
        self.create();self.player.dimension.type=DimensionType.NETHER;self.show();self.assertEqual(self.player.packets,[])
        self.player.dimension.type=DimensionType.OVERWORLD
        for _ in range(3): self.backend.tick()
        self.assertTrue(any(k==13 for k,p in self.player.packets))
        self.backend.reset(self.player);self.player.packets.clear();self.show();self.assertEqual(self.player.packets[0][0],165)
    def test_death_quit_and_rejoin_cleanup(self):
        self.create();self.show();self.player.is_dead=True;self.player.packets.clear();self.backend.tick()
        self.assertTrue(all(k==14 for k,p in self.player.packets));self.assertEqual(self.backend.viewers,{})
        self.player.is_dead=False;self.show();self.server.online_players=[];self.backend.tick();self.assertEqual(self.backend.viewers,{})
        self.server.online_players=[self.player];self.player.packets.clear();self.show();self.assertTrue(any(k==13 for k,p in self.player.packets))
    def test_offline_cache_survives_restart_and_removes_unset_online_score(self):
        self.create();self.show();self.backend.flush();self.server.online_players=[];self.backend.tick()
        self.assertEqual(self.store.data["scores"]["kills"][self.player.unique_id]["score"],10)
        restored=Store(self.store.path);self.assertEqual(restored.data["scores"],self.store.data["scores"])
        self.values.clear();self.server.online_players=[self.player];self.backend.tick();self.assertEqual(self.store.data["scores"]["kills"],{})
    def test_deleted_objective_clears_offline_cache_and_rows(self):
        self.create();self.show();self.objectives.clear();self.backend.tick();self.assertEqual(self.store.data["scores"]["kills"],{})
        self.assertTrue(any(k==39 for k,p in self.player.packets))
    def test_remove_persists_first_and_does_not_touch_scores_or_other_board(self):
        self.create();second=self.create();self.show();actors=len(self.backend.actors["1"]);self.player.packets.clear()
        self.backend.remove("0001");self.backend.tick()
        self.assertEqual([b["id"] for b in self.store.data["boards"]],[second["id"]]);self.assertEqual(self.values[self.player.unique_id],10)
        self.assertEqual([k for k,p in self.player.packets],[14]*actors)
        self.assertEqual([b["id"] for b in Store(self.store.path).data["boards"]],[second["id"]])
    def test_last_board_removal_frees_caches_and_recreate_does_not_revive_offline_scores(self):
        self.create();self.show();self.server.online_players=[]
        self.backend.remove("1");self.backend.tick();self.backend.tick()
        self.assertEqual(self.backend.actors,{});self.assertEqual(self.backend.payloads,{})
        self.backend.create(self.player,"kills",5);self.backend.tick()
        self.assertEqual(self.backend.snapshots["kills"][1],[])
    def test_failed_create_or_remove_save_preserves_registry_and_viewers(self):
        self.create();self.show();before=copy.deepcopy(self.store.data);visible=copy.deepcopy(self.backend.viewers)
        with patch.object(self.store,"commit",side_effect=OSError("disk full")):
            with self.assertRaises(OSError): self.backend.create(self.player,"kills",5)
            with self.assertRaises(OSError): self.backend.remove("1")
        self.assertEqual(self.store.data,before);self.assertEqual(self.backend.viewers,visible)
    def test_invalid_create_and_remove_leave_no_actors(self):
        for amount in (0,16,1.5,True):
            with self.assertRaises(ValueError): self.backend.create(self.player,"kills",amount)
        for objective in ("missing","","x\nstop","a"*129):
            with self.assertRaises(ValueError): self.backend.create(self.player,objective,5)
        for value in ("0","-1","+1","١","9007199254740992","1"):
            with self.assertRaises(ValueError): self.backend.remove(value)
        self.assertFalse(self.store.exists);self.assertEqual(self.player.packets,[])
    def test_pose_direction_and_ground_lift(self):
        for yaw in (0,90,-90,180):
            self.player.location.yaw=yaw;result=pose(self.player)
            self.assertAlmostEqual(result["center"]["x"],-math_sin(yaw)*2.5)
            self.assertAlmostEqual(result["center"]["z"],math_cos(yaw)*2.5)
            self.assertAlmostEqual(result["rotation"]["y"],(yaw+180)%360-180)
        before=pose(self.player)["center"]["y"];self.player.dimension.get_block_at=lambda *_:NS(type="minecraft:grass_block")
        self.assertEqual(pose(self.player)["center"]["y"],before+1)
    def test_partial_spawn_cleanup_and_next_poll_recovery(self):
        self.create();original=self.player.send_packet;failed=[False]
        def fail_once(kind,payload):
            if kind==13 and not failed[0]: failed[0]=True;raise ValueError("send failed")
            original(kind,payload)
        self.player.send_packet=fail_once
        self.backend.tick()
        with self.assertRaises(ValueError): self.backend.tick()
        self.assertEqual(self.backend.viewers[self.player.unique_id]["boards"],{})
        self.backend.tick();self.assertTrue(any(k==13 for k,p in self.player.packets))


def math_sin(degrees):
    import math
    return math.sin(math.radians(degrees))
def math_cos(degrees):
    import math
    return math.cos(math.radians(degrees))


class BridgeTests(Fixture):
    def setUp(self):
        super().setUp();self.bridge=Bridge();self.bridge.backend=self.backend
        self.bridge.nonce="a"*32;self.bridge.chunks={};self.bridge.chunk_count=0;self.bridge.attempts=0
        self.calls=[];self.console=Console();self.logs=[]
        self.bridge.server=self.server;self.server.command_sender=self.console
        self.server.dispatch_command=lambda sender,command:self.calls.append((sender,command)) or True
        self.bridge.logger=NS(info=self.logs.append,error=self.logs.append)
    def run_command(self,args,sender=None,name="lb"):
        return self.bridge.on_command(sender or self.player,NS(name=name),args)
    def message(self,kind,sender=None,**values):
        self.bridge.on_script_message(NS(message_id="ns:lb_packet_import",message=json.dumps({"nonce":self.bridge.nonce,"kind":kind,**values}),sender=sender or self.console))
    def test_on_load_installs_resource_pack_before_any_game_operations(self):
        with patch("ns_lb_bridge.plugin.install_bundled_resource_pack", return_value="installed") as install:
            self.bridge.on_load()
        install.assert_called_once()
        self.assertEqual(self.bridge.resource_pack_error, "")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.player.packets, [])
        self.assertIn("Bundled resource pack installed", self.logs[-1])
    def test_resource_pack_install_failure_disables_packets_and_preserves_store(self):
        before = copy.deepcopy(self.store.data)
        with patch("ns_lb_bridge.plugin.install_bundled_resource_pack", side_effect=OSError("disk full")):
            self.bridge.on_load()
        self.bridge.on_enable()
        self.assertIsNone(self.bridge.backend)
        self.assertEqual(self.store.data, before)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.player.packets, [])
    def test_commands_create_remove_directly_no_script_events(self):
        self.assertTrue(self.run_command(["create","kills","5"]));self.assertEqual(len(self.store.data["boards"]),1)
        self.assertIn("#1 created",self.player.messages[-1]);self.assertTrue(self.player.titles[-1][0].startswith("nsui:"))
        self.assertTrue(self.run_command(["remove","0001"]));self.assertEqual(self.store.data["boards"],[]);self.assertEqual(self.calls,[])
    def test_commands_permissions_validation_and_console_status(self):
        denied=Player(allowed=False);self.run_command(["create","kills","5"],denied);self.assertTrue(denied.errors)
        self.run_command(["create","kills","5"],self.console);self.assertTrue(self.console.errors)
        for value in ("0","16","1.5","+1","١"):
            self.run_command(["create","kills",value])
        for args in ([],["remove"],["create","kills","5","extra"]):self.run_command(args)
        self.assertEqual(self.store.data["boards"],[])
        self.run_command(["status"],self.console);self.assertIn("ready",self.console.messages[-1])
        self.assertFalse(self.run_command([],name="other"))
    def test_listener_annotations_are_classes_not_forward_strings(self):
        for name in ("on_script_message","on_join","on_quit","on_respawn","on_dimension_change"):
            self.assertIsInstance(getattr(Bridge,name).__annotations__["event"],type)
    def test_migration_saves_then_ack_and_requires_complete_before_rendering(self):
        self.backend.ready=False
        payload=json.dumps({"registry":{"version":1,"nextId":1,"boards":[]},"scores":{}})
        self.message("begin",chunks=1);self.message("chunk",index=0,data=payload);self.message("end")
        self.assertTrue(self.store.exists);self.assertFalse(self.backend.ready)
        self.assertIn("ns:lb_packet_ack",self.calls[-1][1]);self.message("complete");self.assertTrue(self.backend.ready)
        self.assertTrue(self.store.path.with_name("leaderboards.legacy-import.json").exists())
    def test_incomplete_spoofed_and_failed_migration_dont_ack(self):
        self.backend.ready=False;self.message("begin",chunks=2);self.message("chunk",index=0,data="{}");self.message("end")
        self.assertFalse(self.store.exists);self.assertEqual(self.calls,[])
        self.message("begin",sender=self.player,chunks=1);self.assertEqual(self.bridge.chunk_count,2)
        payload=json.dumps({"registry":{"version":1,"nextId":1,"boards":[]},"scores":{}})
        self.message("begin",chunks=1);self.message("chunk",index=0,data=payload)
        with patch.object(self.store,"commit",side_effect=OSError("full")):self.message("end")
        self.assertFalse(self.store.exists);self.assertEqual(self.calls,[])
    def test_active_world_without_registry_fails_closed(self):
        self.backend.ready=False;self.message("active");self.assertFalse(self.backend.ready);self.assertEqual(self.calls,[])
        self.assertIn("missing",self.logs[-1])
    def test_existing_native_registry_not_overwritten_by_legacy_snapshot(self):
        self.create();before=copy.deepcopy(self.store.data)
        self.store.import_legacy({"registry":{"version":1,"nextId":1,"boards":[]}})
        self.assertEqual(self.store.data,before)
    def test_migrated_offline_cache_merges_identity_once_on_join(self):
        board={"id":"1","objective":"kills","amount":5,"dimension":"minecraft:overworld","pose":pose(self.player)}
        self.store.import_legacy({"registry":{"version":1,"nextId":2,"boards":[board]},"scores":{"kills":[{"id":"old-id","name":self.player.name,"score":123},{"id":"offline","name":"Offline","score":999}]}})
        self.backend.tick();cache=self.store.data["scores"]["kills"]
        self.assertNotIn("legacy:old-id",cache);self.assertEqual(cache[self.player.unique_id]["score"],10);self.assertEqual(cache["legacy:offline"]["score"],999)
    def test_migration_skips_unresolved_offline_names_not_named_offline_players(self):
        board = {"id":"1", "objective":"kills", "amount":5, "dimension":"minecraft:overworld", "pose":pose(self.player)}
        self.store.import_legacy({"registry":{"version":1,"nextId":2,"boards":[board]}, "scores":{"kills":[
            {"id":"unknown", "name":"commands.scoreboard.players.offlinePlayerName", "score":999999999},
            {"id":"formatted", "name":"§aCOMMANDS.SCOREBOARD.PLAYERS.OFFLINEPLAYERNAME ", "score":999999999},
            {"id":"named", "name":"Offline 💜", "score":123},
        ]}})
        self.assertEqual(self.store.data["scores"]["kills"], {"legacy:named":{"name":"Offline 💜", "score":123}})
        self.assertEqual(Store(self.store.path).data, self.store.data)
    def test_existing_placeholder_cache_repaired_once_and_backup_preserves_original(self):
        self.create()
        data = copy.deepcopy(self.store.data)
        data["scores"] = {"kills": {
            "legacy:1":{"name":"commands.scoreboard.players.offlinePlayerName", "score":999999999},
            self.player.unique_id:{"name":self.player.name, "score":10},
            "legacy:offline":{"name":"Offline Player", "score":123},
        }, "other": {"legacy:2":{"name":"commands.scoreboard.players.offlinePlayerName", "score":5}}}
        self.store.commit(data)
        original = self.store.path.read_bytes()
        repaired = Store(self.store.path)
        expected = copy.deepcopy(data)
        del expected["scores"]["kills"]["legacy:1"]
        del expected["scores"]["other"]["legacy:2"]
        self.assertEqual(repaired.data, expected)
        self.assertEqual(repaired.path.with_suffix(".json.bak").read_bytes(), original)
        with patch.object(Store, "commit", side_effect=AssertionError("Clean cache saved again")):
            self.assertEqual(Store(self.store.path).data, expected)
        self.server.online_players = []
        backend = Backend(self.server, repaired)
        self.assertEqual([e["name"] for e in backend.sample([])["kills"][1]], ["Offline Player", self.player.name])
    def test_placeholder_cleanup_failed_save_preserves_original_cache(self):
        data = copy.deepcopy(self.store.data)
        data["scores"] = {"kills":{"legacy:1":{"name":"commands.scoreboard.players.offlinePlayerName", "score":5}}}
        self.store.commit(data)
        original = self.store.path.read_bytes()
        with patch.object(Store, "_atomic", side_effect=OSError("disk full")):
            with self.assertRaises(OSError): Store(self.store.path)
        self.assertEqual(self.store.path.read_bytes(), original)
    def test_last_good_backup_and_corrupt_registry_preserved(self):
        self.create();before=self.store.path.read_bytes();self.create()
        self.assertEqual(self.store.path.with_suffix(".json.bak").read_bytes(),before)
        self.store.path.write_text("corrupt",encoding="utf-8")
        with self.assertRaises(ValueError):Store(self.store.path)
        self.assertEqual(self.store.path.read_text(),"corrupt")


if __name__=="__main__": unittest.main()
