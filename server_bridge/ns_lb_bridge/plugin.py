"""Endstone-owned packet leaderboards; Script API is only a startup migration."""
import json
import secrets
import time
from pathlib import Path
from endstone import Player
from endstone.plugin import Plugin
from endstone.command import ConsoleCommandSender
from endstone.event import (event_handler, ScriptMessageEvent, PlayerJoinEvent,
                            PlayerQuitEvent, PlayerRespawnEvent, PlayerDimensionChangeEvent)
from .backend import Backend
from .model import Store, board_id
from .resource_pack import install_bundled_resource_pack
from .blackjack_service import Casino, Journal, KitWallet, InsufficientFunds


class LeaderboardBridgePlugin(Plugin):
    api_version = "0.11"
    soft_depend = ["kitpvp"]
    prefix = "Leaderboard"
    commands = {"lb": {"description": "Create/remove packet-rendered scoreboard leaderboards.",
                       "usages": ["/lb <action: str> <scoreboard: str> <amount: int>", "/lb <action: str> <id: int>", "/lb <action: str>"],
                       "permissions": ["leaderboard.create"]},
                "blackjack":{"description":"Open or close your 3D blackjack table using KitPvP coins.",
                             "usages":["/blackjack"],"permissions":["blackjack.play"]}}
    permissions = {"leaderboard.create": {"description": "Manage scoreboard leaderboards.", "default": "op"},
                   "blackjack.play":{"description":"Play blackjack using KitPvP coins.","default":True}}

    def on_load(self):
        # File-only work: on_load precedes BDS/Endstone pack discovery. Keep
        # game APIs and startup handoff in the post-world on_enable callback.
        self.resource_pack_error = ""
        try:
            result = install_bundled_resource_pack(Path.cwd())
            self.logger.info(f"Bundled resource pack {result}: resource_packs/ns_entity_ui_demo.mcpack")
        except Exception as error:
            self.resource_pack_error = str(error)
            self.logger.error(f"Resource-pack installation failed: {error}")

    def on_enable(self):
        self.backend, self.task = None, None
        self.nonce, self.chunks, self.chunk_count = secrets.token_hex(16), {}, 0
        self.attempts, self.last_error = 0, ""
        if getattr(self, "resource_pack_error", ""):
            self.logger.error("Packet leaderboards disabled until the bundled resource pack can be installed.")
            return
        self.casino, self.blackjack_sessions = None, {}
        try:
            self.casino = Casino(Journal(self.data_folder / "blackjack.json"), KitWallet(self.server))
        except Exception as error:
            self.logger.error(f"Blackjack disabled; existing journal preserved: {error}")
        try:
            self.backend = Backend(self.server, Store(self.data_folder / "leaderboards.json"))
            self.register_events(self)
            self.task = self.server.scheduler.run_task(self, self.tick, delay=20, period=20)
            self.logger.info("Packet backend starting. /lb create <scoreboard> <1-15>, /lb remove <id>, /lb status.")
        except Exception as error:
            self.logger.error(str(error))

    def on_disable(self):
        for key in list(getattr(self,"blackjack_sessions",{})):
            try:self.close_blackjack(key)
            except Exception as error:self.logger.error(f"Blackjack settlement pending recovery: {error}")
        if self.task:
            self.task.cancel()
        if self.backend:
            try:
                self.backend.close()
            except Exception as error:
                self.logger.error(f"Shutdown cleanup/save failed: {error}")

    def dispatch(self, event_id):
        message = json.dumps({"nonce": self.nonce}, separators=(",", ":"))
        if not self.server.dispatch_command(self.server.command_sender, f"scriptevent {event_id} {message}"):
            raise ValueError("Could not dispatch the startup migration handoff")

    def tick(self):
        if self.backend is None:
            return
        try:
            self.tick_blackjack()
            if not self.backend.ready:
                if self.attempts >= 60:
                    return
                if self.attempts % 5 == 0:
                    self.dispatch("ns:lb_packet_export")
                self.attempts += 1
                if self.attempts == 60:
                    self.logger.error("Migration not acknowledged after 60 seconds; no fake actors sent. Check BP log/registry. /lb retry retries safely.")
                return
            self.backend.tick()
            self.last_error = ""
        except Exception as error:
            if str(error) != self.last_error:
                self.logger.error(f"Packet update deferred: {error}")
                self.last_error = str(error)

    @event_handler
    def on_script_message(self, event: ScriptMessageEvent):
        if event.message_id in {"ns:bj_action","ns:bj_close_request"}:
            self.on_blackjack_message(event)
            return
        if event.message_id != "ns:lb_packet_import" or self.backend is None or not isinstance(event.sender, ConsoleCommandSender):
            return
        try:
            message = json.loads(event.message)
            if message.get("nonce") != self.nonce:
                return
            kind = message.get("kind")
            if kind == "begin":
                count = message["chunks"]
                if type(count) is not int or not 1 <= count <= 8192:
                    raise ValueError("Invalid migration chunk count")
                self.chunks, self.chunk_count = {}, count
            elif kind == "chunk":
                index, data = message["index"], message["data"]
                if type(index) is not int or not 0 <= index < self.chunk_count or not isinstance(data, str) or len(data) > 400:
                    raise ValueError("Invalid migration chunk")
                if index in self.chunks:
                    raise ValueError("Duplicate migration chunk")
                self.chunks[index] = data
            elif kind == "end":
                if not self.chunk_count or len(self.chunks) != self.chunk_count:
                    raise ValueError("Incomplete migration; old actors preserved")
                payload = json.loads("".join(self.chunks[i] for i in range(self.chunk_count)))
                self.backend.store.import_legacy(payload)
                self.chunks, self.chunk_count = {}, 0
                self.dispatch("ns:lb_packet_ack")
            elif kind == "active":
                if not self.backend.store.exists:
                    raise ValueError("World already migrated but Endstone registry missing. Restore leaderboards.json.bak; refusing stale world-data reimport.")
                self.dispatch("ns:lb_packet_ack")
            elif kind == "complete":
                if not self.backend.store.exists:
                    raise ValueError("Migration completion arrived before a saved registry")
                if not self.backend.ready:
                    self.backend.ready = True
                    self.logger.info(f"Endstone-only rendering active: {len(self.backend.store.data['boards'])} boards. Offline scores use last cached values.")
        except Exception as error:
            self.logger.error(f"Migration refused: {error}")

    @event_handler
    def on_join(self, event: PlayerJoinEvent):
        if self.backend:
            self.backend.forget(event.player)

    @event_handler
    def on_quit(self, event: PlayerQuitEvent):
        try:self.close_blackjack(str(event.player.unique_id))
        except Exception as error:self.logger.error(f"Blackjack quit settlement pending: {error}")
        if self.backend:
            try:
                if self.backend.ready:
                    self.backend.sample([event.player])
                    self.backend.flush()
            except Exception as error:
                self.logger.error(f"Could not cache departing player's scores: {error}")
            self.backend.forget(event.player)

    @event_handler
    def on_respawn(self, event: PlayerRespawnEvent):
        try:self.close_blackjack(str(event.player.unique_id))
        except Exception as error:self.logger.error(f"Blackjack respawn settlement pending: {error}")
        if self.backend:
            self.backend.reset(event.player)

    @event_handler
    def on_dimension_change(self, event: PlayerDimensionChangeEvent):
        try:self.close_blackjack(str(event.player.unique_id))
        except Exception as error:self.logger.error(f"Blackjack dimension settlement pending: {error}")
        if self.backend:
            self.backend.reset(event.player)

    def on_command(self, sender, command, args):
        if command.name.lower()=="blackjack":
            try:
                if not isinstance(sender,Player) or not sender.has_permission("blackjack.play"):
                    raise ValueError("Run /blackjack in-game with blackjack.play permission")
                if args:raise ValueError("Usage: /blackjack")
                if getattr(self,"casino",None) is None:raise ValueError("Blackjack is unavailable; check the server log")
                key=str(sender.unique_id)
                if key in self.blackjack_sessions:self.close_blackjack(key)
                else:
                    self.casino.recover(key)
                    view=self.casino.view(key)
                    token=secrets.token_hex(16)
                    self.blackjack_sessions[key]={"token":token,"name":sender.name,"at":time.monotonic(),"signature":"",
                                                  "dimension":sender.dimension.type.value,
                                                  "position":tuple(getattr(sender.location,c) for c in "xyz")}
                    self.send_blackjack(key,"ns:bj_open",view)
            except Exception as error:sender.send_error_message(str(error))
            return True
        if command.name.lower() != "lb":
            return False
        if not sender.has_permission("leaderboard.create"):
            sender.send_error_message("You do not have permission to manage leaderboards.")
            return True
        action = args[0].lower() if args else ""
        try:
            backend = getattr(self, "backend", None)
            if backend is None:
                raise ValueError("Packet backend disabled; check the server log/protocol version.")
            if action == "status" and len(args) == 1:
                sender.send_message(f"Packet backend: {'ready' if backend.ready else 'waiting for migration'}; boards={len(backend.store.data['boards'])}; " +
                                    "; ".join(f"{k}={v}" for k, v in backend.metrics.items()))
            elif action == "retry" and len(args) == 1:
                if not backend.ready:
                    self.attempts = 0
                    self.chunks, self.chunk_count = {}, 0
                sender.send_message("Startup handoff retry enabled." if not backend.ready else "Packet backend is already ready.")
            elif not isinstance(sender, Player):
                raise ValueError("Run /lb in-game to create or remove a leaderboard.")
            elif action == "create" and len(args) == 3:
                if not args[2].isascii() or not args[2].isdecimal():
                    raise ValueError("Amount must be a whole number from 1 to 15.")
                board = backend.create(sender, args[1], int(args[2]))
                self.notify(sender, f"Leaderboard #{board['id']} created - top {board['amount']}")
            elif action == "remove" and len(args) == 2:
                board = backend.remove(board_id(args[1]))
                self.notify(sender, f"Leaderboard #{board['id']} removed")
            else:
                raise ValueError("Usage: /lb create <scoreboard> <amount: 1-15>, /lb remove <id>, /lb status")
        except Exception as error:
            sender.send_error_message(str(error))
        return True

    def send_blackjack(self,key,event_id,view=None,error=""):
        session=self.blackjack_sessions[key]
        payload={"player":session["name"],"token":session["token"]}
        if view is not None:payload["view"]=view
        if error:payload["error"]=error
        message=json.dumps(payload,separators=(",",":"))
        if not self.server.dispatch_command(self.server.command_sender,f"scriptevent {event_id} {message}"):
            raise ValueError("Could not update blackjack UI; round state is saved. Reopen /blackjack")
        session["signature"]=json.dumps(view,sort_keys=True) if view is not None else ""

    def close_blackjack(self,key):
        sessions=getattr(self,"blackjack_sessions",{})
        if key not in sessions:return
        try:
            try:self.casino.recover(key)
            except InsufficientFunds:pass  # Failed extra debit rolled back; stand the original hand.
            game=self.casino.record(key)["round"]
            if game and game["phase"]!="settled":self.casino.action(key,"finish")
            self.send_blackjack(key,"ns:bj_close")
        finally:sessions.pop(key,None)

    def on_blackjack_message(self,event):
        if not isinstance(event.sender,ConsoleCommandSender) or not getattr(self,"casino",None):return
        if len(event.message)>4096:return
        key=None
        try:
            request=json.loads(event.message)
            key=next((k for k,s in self.blackjack_sessions.items() if s["token"]==request.get("token")),None)
            if key is None:return
            if event.message_id=="ns:bj_close_request":self.close_blackjack(key);return
            session=self.blackjack_sessions[key]
            player=self.server.get_player(session["name"])
            if not player or str(player.unique_id)!=key:return
            if (player.is_dead or not player.has_permission("blackjack.play") or
                    player.dimension.type.value!=session["dimension"] or
                    sum((getattr(player.location,c)-p)**2 for c,p in zip("xyz",session["position"]))>64):
                self.close_blackjack(key);return
            self.casino.recover(key)
            if type(request.get("revision")) is not int or request["revision"]!=self.casino.record(key)["revision"]:
                raise ValueError("Stale action ignored; table refreshed")
            self.casino.action(key,request.get("action"),request.get("amount"))
            session["at"]=time.monotonic()
            self.send_blackjack(key,"ns:bj_view",self.casino.view(key))
        except Exception as error:
            if key in getattr(self,"blackjack_sessions",{}):
                try:self.send_blackjack(key,"ns:bj_view",self.casino.view(key),str(error))
                except Exception:self.logger.error(f"Blackjack recovery required: {error}")

    def tick_blackjack(self):
        for key,session in list(getattr(self,"blackjack_sessions",{}).items()):
            player=self.server.get_player(session["name"])
            if (player is None or player.is_dead or player.dimension.type.value!=session["dimension"] or
                    time.monotonic()-session["at"]>180 or
                    sum((getattr(player.location,c)-p)**2 for c,p in zip("xyz",session["position"]))>64):
                self.close_blackjack(key);continue
            self.casino.recover(key)
            view=self.casino.view(key)
            if json.dumps(view,sort_keys=True)!=session["signature"]:self.send_blackjack(key,"ns:bj_view",view)

    @staticmethod
    def notify(player, message):
        player.send_message(message)
        player.send_title("nsui:" + message, "", 0, 70, 10)
