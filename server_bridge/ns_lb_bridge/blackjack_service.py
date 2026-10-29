"""Persisted hands + write-ahead, idempotent KitPvP wallet transactions."""
import copy
from collections import Counter
import json
from pathlib import Path
import secrets
import re

from . import blackjack_rules as rules
from .model import Store


class InsufficientFunds(ValueError):
    pass


class KitWallet:
    def __init__(self, server):
        self.server = server

    def provider(self):
        kit = self.server.plugin_manager.get_plugin("kitpvp")
        if kit is None or not hasattr(kit, "apply_coin_transaction"):
            raise RuntimeError("KitPvP's durable coin API is unavailable; no blackjack coins were moved")
        return kit

    def balance(self, key):
        return self.provider().coin_balance(key)

    def apply(self, key, transaction_id, delta, required):
        if not self.provider().apply_coin_transaction(transaction_id, key, delta, required):
            raise InsufficientFunds("Not enough KitPvP coins; your hand was not changed")


def valid_record(record):
    if type(record["bet"]) is not int or not 2 <= record["bet"] <= 100000 or record["bet"] % 2:
        raise ValueError("Invalid saved blackjack bet")
    if type(record["revision"]) is not int or record["revision"] < 0:
        raise ValueError("Invalid saved blackjack revision")
    cards = list(record["shoe"])
    if len(cards) > 312:
        raise ValueError("Invalid saved shoe")
    game = record["round"]
    if game:
        if game["phase"] not in {"insurance", "player", "settled"} or not 1 <= len(game["hands"]) <= 4:
            raise ValueError("Invalid saved blackjack phase")
        cards += game["dealer"]
        if not 2 <= len(game["dealer"]) <= 21:
            raise ValueError("Invalid saved dealer hand")
        for h in game["hands"]:
            cards += h["cards"]
            if not 1 <= len(h["cards"]) <= 21 or type(h["bet"]) is not int or not 2 <= h["bet"] <= 200000 or h["bet"] % 2:
                raise ValueError("Invalid saved player hand")
            if any(type(h.get(k)) is not bool for k in ("split","aces","done","acted","surrendered")):
                raise ValueError("Invalid saved hand flags")
        if type(game["active"]) is not int or not 0 <= game["active"] < len(game["hands"]):
            raise ValueError("Invalid active hand")
        if (any(type(game.get(k)) is not int for k in ("insurance","returned","insurance_return","net")) or
                type(game.get("original_bet")) is not int or not 2<=game["original_bet"]<=100000 or
                game["original_bet"]%2 or game["insurance"] not in (0,game["original_bet"]//2)):
            raise ValueError("Invalid saved payout accounting")
    if any(type(c) is not int or not 0 <= c < 52 for c in cards):
        raise ValueError("Invalid saved card")
    if len(cards)>312 or any(n>6 for n in Counter(cards).values()):
        raise ValueError("Saved cards do not belong to a six-deck shoe")
    if game and game["phase"]=="settled":
        if game.get("even_money") and (len(game["hands"])!=1 or not rules.natural(game["hands"][0])):
            raise ValueError("Invalid saved even-money hand")
        expected=copy.deepcopy(game)
        rules.settle(expected,list(record["shoe"]))
        if (any(game[k]!=expected[k] for k in ("returned","insurance_return","net")) or
                any((h.get("result"),h.get("returned"))!=(e["result"],e["returned"]) for h,e in zip(game["hands"],expected["hands"]))):
            raise ValueError("Saved payout differs from blackjack rules")


class Journal:
    def __init__(self, path):
        self.path = Path(path)
        self.data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {"version":1,"players":{}}
        self.validate(self.data)

    @staticmethod
    def validate(data):
        if data.get("version") != 1 or not isinstance(data.get("players"), dict):
            raise ValueError("Invalid blackjack journal; original file preserved")
        for key, record in data["players"].items():
            if not isinstance(key, str):
                raise ValueError("Invalid saved player")
            valid_record(record)
            pending = record.get("pending")
            if pending:
                valid_record(pending["next"])
                if (not isinstance(pending["id"], str) or not re.fullmatch(r"blackjack:[a-f0-9]{48}",pending["id"]) or
                        type(pending["delta"]) is not int or abs(pending["delta"]) > 2000000 or
                        type(pending["required"]) is not int or not 0 <= pending["required"] <= 200000):
                    raise ValueError("Invalid saved coin transaction")
                old,new=record["round"],pending["next"]["round"]
                old_stake=sum(h["bet"] for h in old["hands"])+old["insurance"] if old and old["phase"]!="settled" else 0
                cost=sum(h["bet"] for h in new["hands"])+new["insurance"]-old_stake
                returned=new["returned"] if new["phase"]=="settled" else 0
                if (cost<0 or pending["required"]!=cost or pending["delta"]!=returned-cost or
                        pending["next"]["revision"]!=record["revision"]+1):
                    raise ValueError("Saved transaction differs from hand accounting")

    def commit(self, data):
        self.validate(data)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.exists():
            Store._atomic(self.path.with_suffix(".json.bak"), self.path.read_bytes())
        Store._atomic(self.path, json.dumps(data, separators=(",", ":")).encode())
        self.data = data


class Casino:
    MIN_BET, MAX_BET = 10, 100000

    def __init__(self, journal, wallet):
        self.journal, self.wallet = journal, wallet

    def record(self, key):
        return self.journal.data["players"].get(key, {"bet":100,"revision":0,"shoe":[],"round":None})

    def save_record(self, key, record):
        data = copy.deepcopy(self.journal.data)
        data["players"][key] = record
        self.journal.commit(data)

    def recover(self, key):
        record = self.record(key)
        pending = record.get("pending")
        if not pending:
            return
        # Wallet commits the balance AND receipt in the same atomic file. If a
        # crash happened after that write, repeating this ID cannot pay twice.
        try:
            self.wallet.apply(key, pending["id"], pending["delta"], pending["required"])
        except InsufficientFunds:
            # Insufficient funds before the debit: old hand/shoe remain intact.
            old = copy.deepcopy(record)
            old.pop("pending")
            self.save_record(key, old)
            raise
        self.save_record(key, pending["next"])

    def transition(self, key, updated, cost=0, returned=0):
        previous = copy.deepcopy(self.record(key))
        updated["revision"] = previous["revision"] + 1
        if not cost and not returned:
            self.save_record(key, updated)
            return
        previous["pending"] = {"id":"blackjack:" + secrets.token_hex(24), "delta":returned-cost,
                               "required":cost, "next":updated}
        self.save_record(key, previous)  # Prepare before moving any coins.
        self.recover(key)

    def action(self, key, action, amount=None):
        self.recover(key)
        record = copy.deepcopy(self.record(key))
        game = record["round"]
        balance = self.wallet.balance(key)
        if action == "bet":
            if game and game["phase"] != "settled":
                raise ValueError("Finish the current round before changing your bet")
            if type(amount) is not int or not self.MIN_BET <= amount <= self.MAX_BET or amount % 2:
                raise ValueError("Bet must be an even whole number from 10 to 100000 coins")
            record["bet"] = amount
            self.transition(key, record)
            return
        if action == "deal":
            if game and game["phase"] != "settled":
                raise ValueError("Your current round is still in play")
            if balance < record["bet"]:
                raise ValueError("Not enough KitPvP coins for this bet")
            # Conservative cut card leaves enough cards for all four split hands
            # without reshuffling or changing probabilities during a live round.
            if len(record["shoe"]) < 128:
                record["shoe"] = rules.shoe()
            game, cost = rules.deal(record["shoe"], record["bet"]), record["bet"]
        else:
            if not game or game["phase"] == "settled":
                raise ValueError("Place a bet and deal first")
            if action == "finish":
                game, cost = rules.finish(game, record["shoe"]), 0
            else:
                game, cost = rules.act(game, record["shoe"], action, balance)
        record["round"] = game
        self.transition(key, record, cost, game["returned"] if game["phase"] == "settled" else 0)

    def view(self, key):
        record, balance = self.record(key), self.wallet.balance(key)
        game = record["round"]
        result = {"revision":record["revision"], "balance":balance, "bet":record["bet"],
                  "phase":"betting", "dealer":[], "dealerTotal":"", "hands":[],
                  "legal":["bet","deal"] if balance >= record["bet"] else ["bet"],
                  "message":"SET YOUR BET, THEN DEAL / KITPVP COINS"}
        if not game:
            return result
        settled = game["phase"] == "settled"
        result.update(phase=game["phase"], active=game["active"],
                      dealer=[c+1 for c in game["dealer"]] if settled else [game["dealer"][0]+1, 53],
                      dealerTotal=str(rules.total(game["dealer"])[0]) if settled else str(rules.total(game["dealer"][:1])[0])+" + ?",
                      hands=[{"cards":[c+1 for c in h["cards"]], "total":rules.total(h["cards"])[0],
                              "soft":rules.total(h["cards"])[1], "bet":h["bet"], "result":h.get("result", "STAND" if h["done"] else "PLAYING")}
                             for h in game["hands"]])
        if settled:
            result["message"] = f"ROUND NET {game['net']:+} / RETURNED {game['returned']} COINS"
        else:
            result["legal"] = sorted(rules.legal(game, balance))
            result["message"] = (f"DEALER ACE / INSURANCE COST {record['bet']//2}" if game["phase"] == "insurance" else
                                 f"PLAY HAND {game['active']+1} OF {len(game['hands'])}")
        return result
