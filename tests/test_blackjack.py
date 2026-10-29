import copy
import ast
import importlib.util
import json
from pathlib import Path
import sys
import random
import tempfile
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import patch

import test_bridge  # Shared headless Endstone stubs, never a running server.
from ns_lb_bridge import blackjack_rules as r
from ns_lb_bridge.blackjack_service import Casino, Journal, InsufficientFunds

ROOT = Path(__file__).resolve().parents[1]
KITPVP_SOURCE = ROOT.parent / "kitpvp/src/endstone_kitpvp"
coins = None
if (KITPVP_SOURCE / "economy.py").is_file():
    coin_package = ModuleType("test_coin_package")
    coin_package.__path__ = [str(KITPVP_SOURCE)]
    sys.modules[coin_package.__name__] = coin_package
    spec = importlib.util.spec_from_file_location("test_coin_package.economy", KITPVP_SOURCE / "economy.py")
    coins = importlib.util.module_from_spec(spec); spec.loader.exec_module(coins)


def c(rank, suit=0): return suit*13+rank-1
def deck(*ranks): return [c(n) for n in reversed(ranks)]


class RulesTests(unittest.TestCase):
    def test_aces_soft_totals_and_face_values(self):
        for ranks, expected in [([1,1],(12,True)),([1,6],(17,True)),([1,6,10],(17,False)),([1,1,9],(21,True)),([10,12],(20,False))]:
            self.assertEqual(r.total([c(x) for x in ranks]),expected)
    def test_six_deck_shoe_has_exactly_six_of_each_card(self):
        cards=r.shoe();self.assertEqual(len(cards),312)
        self.assertTrue(all(cards.count(i)==6 for i in range(52)))
    def test_natural_pays_three_to_two_and_dealer_does_not_draw(self):
        cards=deck(1,9,13,8,2)
        game=r.deal(cards,100)
        self.assertEqual((game["phase"],game["returned"],game["net"]),("settled",250,150))
        self.assertEqual(len(cards),1)
    def test_dealer_peeks_before_player_can_double_split_or_surrender(self):
        game=r.deal(deck(8,10,8,1),100)
        self.assertEqual(game["phase"],"settled");self.assertEqual(game["returned"],0)
        self.assertEqual(r.legal(game,1000),set())
    def test_two_naturals_push(self):
        cards=deck(1,1,10,10)
        game=r.deal(cards,100);self.assertEqual(game["phase"],"insurance")
        game,_=r.act(game,cards,"decline",0)
        self.assertEqual((game["returned"],game["net"]),(100,0))
    def test_insurance_wins_at_two_to_one_only_for_dealer_blackjack(self):
        cards=deck(10,1,9,13)
        game=r.deal(cards,100);game,cost=r.act(game,cards,"insurance",50)
        self.assertEqual(cost,50);self.assertEqual(game["insurance_return"],150)
        self.assertEqual(game["returned"],150);self.assertEqual(game["net"],0)
        cards=deck(10,1,9,6)
        game=r.deal(cards,100);game,cost=r.act(game,cards,"insurance",50)
        game,_=r.act(game,cards,"stand",0)
        self.assertEqual(game["insurance_return"],0);self.assertEqual(game["net"],50)
    def test_even_money_needs_natural_but_no_extra_cash(self):
        for hole in (6,10):
            cards=deck(1,1,10,hole)
            game=r.deal(cards,100);self.assertIn("even_money",r.legal(game,0))
            game,cost=r.act(game,cards,"even_money",0)
            self.assertEqual((cost,game["returned"],game["net"]),(0,200,100))
    def test_dealer_stands_on_soft_seventeen(self):
        cards=deck(10,1,8,6,10)
        game=r.deal(cards,100);game,_=r.act(game,cards,"decline",0);game,_=r.act(game,cards,"stand",0)
        self.assertEqual(game["dealer"],[c(1),c(6)]);self.assertEqual(len(cards),1)
    def test_dealer_hits_sixteen_and_hard_seventeen_stands(self):
        cards=deck(10,10,8,6,1,10)
        game=r.deal(cards,100);game,_=r.act(game,cards,"stand",0)
        self.assertEqual(r.total(game["dealer"]),(17,False));self.assertEqual(len(game["dealer"]),3)
    def test_all_twelve_cards_of_extreme_ace_heavy_dealer_hand_are_supported(self):
        cards=deck(10,1,8,1,1,1,1,1,6,1,1,1,1,1)
        game=r.deal(cards,100);game,_=r.act(game,cards,"decline",0);game,_=r.act(game,cards,"stand",0)
        self.assertEqual(len(game["dealer"]),12);self.assertEqual(r.total(game["dealer"]),(17,False))
    def test_double_exactly_one_card_and_costs_equal_wager(self):
        cards=deck(5,10,6,7,10)
        game=r.deal(cards,100);game,cost=r.act(game,cards,"double",100)
        self.assertEqual(cost,100);self.assertEqual(game["hands"][0]["bet"],200)
        self.assertEqual(len(game["hands"][0]["cards"]),3);self.assertEqual(game["returned"],400)
    def test_double_and_surrender_disallowed_after_hit(self):
        cards=deck(2,10,3,7,2)
        game=r.deal(cards,100);game,_=r.act(game,cards,"hit",1000)
        self.assertNotIn("double",r.legal(game,1000));self.assertNotIn("surrender",r.legal(game,1000))
    def test_late_surrender_returns_half_and_skips_dealer_draw(self):
        cards=deck(10,6,6,10,10)
        game=r.deal(cards,100);game,_=r.act(game,cards,"surrender",0)
        self.assertEqual((game["returned"],game["net"]),(50,-50));self.assertEqual(len(cards),1)
    def test_split_deals_second_hand_only_when_it_becomes_active(self):
        cards=deck(8,10,8,7,2,3)
        game=r.deal(cards,100);game,cost=r.act(game,cards,"split",100)
        self.assertEqual(cost,100);self.assertEqual([len(h["cards"]) for h in game["hands"]],[2,1])
        game,_=r.act(game,cards,"stand",100)
        self.assertEqual(game["active"],1);self.assertEqual(game["hands"][1]["cards"],[c(8),c(3)])
        self.assertIn("double",r.legal(game,100));self.assertNotIn("surrender",r.legal(game,100))
    def test_equal_value_face_cards_may_split_and_not_natural(self):
        cards=deck(10,10,12,7,1,1)
        game=r.deal(cards,100);game,_=r.act(game,cards,"split",100)
        self.assertEqual(game["phase"],"settled")
        self.assertEqual(game["returned"],400);self.assertTrue(all(h["result"]=="WIN" for h in game["hands"]))
    def test_split_aces_one_card_each_no_blackjack_bonus_or_resplit(self):
        cards=deck(1,10,1,7,1,10)
        game=r.deal(cards,100);game,cost=r.act(game,cards,"split",100)
        self.assertEqual(game["phase"],"settled");self.assertEqual(cost,100)
        self.assertEqual([len(h["cards"]) for h in game["hands"]],[2,2])
        self.assertEqual(game["hands"][1]["returned"],200)
    def test_resplit_limited_to_four_hands(self):
        cards=deck(8,10,8,7,8,8,8)
        game=r.deal(cards,100)
        for _ in range(3):game,cost=r.act(game,cards,"split",1000);self.assertEqual(cost,100)
        self.assertEqual(len(game["hands"]),4);self.assertNotIn("split",r.legal(game,1000))
    def test_unaffordable_split_double_insurance_and_invalid_actions(self):
        game=r.deal(deck(8,10,8,7),100)
        for action in ("split","double"):
            with self.assertRaises(ValueError):r.act(game,[],action,99)
        game=r.deal(deck(8,1,8,7),100)
        with self.assertRaises(ValueError):r.act(game,[],"insurance",49)
        for action in ("hit","surrender","bogus"):
            with self.assertRaises(ValueError):r.act(game,[],action,1000)
    def test_player_bust_loses_even_if_dealer_would_bust(self):
        cards=deck(10,6,6,10,10,10)
        game=r.deal(cards,100);game,_=r.act(game,cards,"hit",100)
        self.assertEqual(game["returned"],0);self.assertEqual(len(cards),1)
    def test_equal_totals_push_and_dealer_bust_pays_even_money(self):
        for ranks,returned in [((10,10,8,8),100),((10,6,8,10,10),200)]:
            cards=deck(*ranks);game=r.deal(cards,100);game,_=r.act(game,cards,"stand",0)
            self.assertEqual(game["returned"],returned)
    def test_no_five_card_charlie_and_twenty_one_stops(self):
        cards=deck(2,10,2,7,2,2,2,10,1)
        game=r.deal(cards,100)
        for _ in range(3):game,_=r.act(game,cards,"hit",0)
        self.assertEqual(game["phase"],"player");self.assertEqual(len(game["hands"][0]["cards"]),5)
    def test_finish_stands_all_split_hands_and_does_not_refund(self):
        cards=deck(8,10,8,7,2,3)
        game=r.deal(cards,100);game,_=r.act(game,cards,"split",100)
        game=r.finish(game,cards)
        self.assertEqual(game["returned"],0);self.assertEqual(game["net"],-200)
    def test_odd_bets_cannot_round_blackjack_or_surrender_payouts(self):
        for bet in (1,11,True,1.5):
            with self.assertRaises(ValueError):r.deal([],bet)
    def test_random_legal_rounds_terminate_and_preserve_card_and_chip_accounting(self):
        rng=random.Random(1928)
        for _ in range(1000):
            cards=list(range(52))*6;rng.shuffle(cards);game=r.deal(cards,100)
            spent=100;steps=0
            while game["phase"]!="settled":
                game,cost=r.act(game,cards,rng.choice(sorted(r.legal(game,1000000))),1000000)
                spent+=cost;steps+=1;self.assertLess(steps,100)
            self.assertEqual(spent,sum(h["bet"] for h in game["hands"])+game["insurance"])
            self.assertEqual(game["net"],game["returned"]-spent)
            self.assertEqual(game["returned"],sum(h["returned"] for h in game["hands"])+game["insurance_return"])
            self.assertEqual(len(cards)+len(game["dealer"])+sum(len(h["cards"]) for h in game["hands"]),312)


@unittest.skipIf(coins is None, "Optional KitPvP wallet integration requires a sibling kitpvp source checkout")
class BridgeBlackjackTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="blackjack-bridge-test-",dir=ROOT/"tests");self.addCleanup(self.temp.cleanup)
        self.wallet=Wallet(Path(self.temp.name)/"coins.json")
        self.casino=Casino(Journal(Path(self.temp.name)/"blackjack.json"),self.wallet)
        self.player=test_bridge.Player(key="p")
        self.calls=[];self.logs=[]
        self.bridge=test_bridge.Bridge();self.bridge.casino=self.casino;self.bridge.blackjack_sessions={}
        self.bridge.logger=NS(error=self.logs.append,info=self.logs.append)
        self.console=test_bridge.Console()
        self.bridge.server=NS(command_sender=self.console,get_player=lambda name:self.player if name==self.player.name else None,
                              dispatch_command=lambda sender,command:self.calls.append(command) or True)
    def open(self):
        self.bridge.on_command(self.player,NS(name="blackjack"),[])
        return self.bridge.blackjack_sessions["p"]["token"]
    def action(self,token,action,revision,amount=None,sender=None):
        self.bridge.on_script_message(NS(message_id="ns:bj_action",sender=sender or self.console,
            message=json.dumps({"token":token,"action":action,"revision":revision,"amount":amount})))
    def test_player_command_opens_personal_table_with_actual_balance(self):
        self.open();payload=json.loads(self.calls[-1].split("ns:bj_open ",1)[1])
        self.assertEqual(payload["view"]["balance"],1000)
        self.assertEqual(self.wallet.balance("p"),1000)
    def test_player_origin_spoof_and_wrong_token_move_no_coins(self):
        token=self.open();self.action(token,"deal",0,sender=self.player);self.action("wrong","deal",0)
        self.assertEqual(self.wallet.balance("p"),1000);self.assertIsNone(self.casino.record("p")["round"])
    def test_stale_double_click_cannot_debit_two_bets(self):
        token=self.open();self.action(token,"deal",0)
        after=self.wallet.balance("p");self.action(token,"deal",0)
        self.assertEqual(self.wallet.balance("p"),after)
        self.assertIn("Stale action",self.calls[-1])
    def test_quit_and_close_autostand_and_stale_token_no_longer_works(self):
        record=copy.deepcopy(self.casino.record("p"));record["shoe"]=list(range(52))*3+deck(10,10,8,7)
        self.casino.save_record("p",record)
        token=self.open();self.action(token,"deal",0);self.assertEqual(self.wallet.balance("p"),900)
        self.bridge.close_blackjack("p");self.assertEqual(self.wallet.balance("p"),1100)
        self.action(token,"double",1);self.assertEqual(self.wallet.balance("p"),1100)
    def test_walkaway_and_dimension_change_cannot_keep_betting_remotely(self):
        token=self.open();self.player.location.x=20;self.action(token,"deal",0)
        self.assertNotIn("p",self.bridge.blackjack_sessions);self.assertEqual(self.wallet.balance("p"),1000)
    def test_close_stands_original_hand_if_a_failed_extra_debit_is_rolled_back(self):
        record=copy.deepcopy(self.casino.record("p"));record["shoe"]=list(range(52))*3+deck(5,10,6,7,10)
        self.casino.save_record("p",record);token=self.open();self.action(token,"deal",0)
        with patch.object(coins,"save_balances",side_effect=OSError("disk full")):
            with self.assertRaises(OSError):self.casino.action("p","double")
        self.wallet.balances["p"]=50  # Another shop purchase before recovery.
        self.bridge.close_blackjack("p")
        self.assertEqual(self.casino.record("p")["round"]["phase"],"settled")
        self.assertEqual(self.casino.record("p")["round"]["hands"][0]["bet"],100)
        self.assertNotIn("p",self.bridge.blackjack_sessions)


class Wallet:
    def __init__(self,path):self.path=path;self.balances={"p":1000,"other":250};self.receipts={}
    def balance(self,key):return self.balances.get(key,0)
    def apply(self,key,transaction,delta,required):
        if not coins.apply_coin_transaction(self.path,self.balances,self.receipts,transaction,key,delta,required):
            raise InsufficientFunds("not enough coins")


@unittest.skipIf(coins is None, "Optional KitPvP wallet integration requires a sibling kitpvp source checkout")
class MoneyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="blackjack-test-",dir=ROOT/"tests");self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.wallet=Wallet(self.root/"coins.json")
        self.journal=Journal(self.root/"blackjack.json");self.casino=Casino(self.journal,self.wallet)
    def prepare(self,*ranks):
        record=copy.deepcopy(self.casino.record("p"));record["shoe"]=list(range(52))*3+deck(*ranks)
        self.casino.save_record("p",record)
    def test_public_wallet_receipt_is_atomic_and_idempotent(self):
        self.wallet.apply("p","blackjack:debit",-100,100)
        self.wallet.apply("p","blackjack:debit",-100,100)
        self.assertEqual(self.wallet.balance("p"),900)
        self.assertEqual(coins.load_balances(self.wallet.path),self.wallet.balances)
        self.assertEqual(coins.load_coin_transactions(self.wallet.path),self.wallet.receipts)
        with self.assertRaises(ValueError):self.wallet.apply("p","blackjack:debit",100,0)
    def test_external_coin_flush_preserves_receipts(self):
        self.wallet.apply("p","blackjack:debit",-100,100)
        self.wallet.balances["other"]+=5;coins.save_balances(self.wallet.path,self.wallet.balances)
        self.assertEqual(coins.load_coin_transactions(self.wallet.path),self.wallet.receipts)
        self.assertEqual(coins.load_balances(self.wallet.path)["other"],255)
    def test_public_api_retry_does_not_clear_other_unflushed_shop_changes(self):
        tree=ast.parse((KITPVP_SOURCE/"plugin.py").read_text(encoding="utf-8"))
        method=next(m for cls in tree.body if isinstance(cls,ast.ClassDef) for m in cls.body
                    if isinstance(m,ast.FunctionDef) and m.name=="apply_coin_transaction")
        # Preserve the real class/module distinction: the public class method
        # must not shadow its module-level ledger helper in this test harness.
        method=copy.deepcopy(method);method.name="public_api"
        namespace={"apply_coin_transaction":coins.apply_coin_transaction}
        exec(compile(ast.Module(body=[method],type_ignores=[]),"actual_public_coin_api","exec"),namespace)
        kit=NS(_coins=self.wallet.balances,_coin_transactions=self.wallet.receipts,_coins_dirty=True,
               _coins_path=lambda:self.wallet.path)
        apply=namespace["public_api"]
        self.assertTrue(apply(kit,"blackjack:original","p",-100,100));self.assertFalse(kit._coins_dirty)
        kit._coins["other"]+=5;kit._coins_dirty=True
        self.assertTrue(apply(kit,"blackjack:original","p",-100,100));self.assertTrue(kit._coins_dirty)
    def test_insufficient_funds_never_clamp_or_mint_money(self):
        with self.assertRaises(InsufficientFunds):self.wallet.apply("p","blackjack:x",-1001,1001)
        self.assertEqual(self.wallet.balance("p"),1000);self.assertFalse(self.wallet.path.exists())
    def test_failed_wallet_write_publishes_neither_balance_nor_receipt(self):
        with patch.object(coins.os,"replace",side_effect=OSError("disk full")):
            with self.assertRaises(OSError):self.wallet.apply("p","blackjack:x",-100,100)
        self.assertEqual(self.wallet.balance("p"),1000);self.assertEqual(self.wallet.receipts,{})
    def test_wager_and_payout_use_same_existing_coin_wallet(self):
        self.prepare(10,10,8,7)
        self.casino.action("p","deal");self.assertEqual(self.wallet.balance("p"),900)
        self.casino.action("p","stand");self.assertEqual(self.wallet.balance("p"),1100)
        self.assertEqual(self.wallet.balance("other"),250)
    def test_close_and_repeated_finish_cannot_pay_twice(self):
        self.prepare(10,10,8,7);self.casino.action("p","deal");self.casino.action("p","finish")
        balance=self.wallet.balance("p")
        with self.assertRaises(ValueError):self.casino.action("p","finish")
        self.assertEqual(self.wallet.balance("p"),balance)
    def test_crash_after_wallet_commit_before_journal_finish_is_recovered_once(self):
        self.prepare(10,10,8,7)
        original=self.journal.commit;calls=[0]
        def commit(data):
            calls[0]+=1
            if calls[0]==2:raise OSError("crash after money commit")
            return original(data)
        with patch.object(self.journal,"commit",side_effect=commit):
            with self.assertRaises(OSError):self.casino.action("p","deal")
        self.assertEqual(self.wallet.balance("p"),900)
        restarted=Casino(Journal(self.journal.path),self.wallet)
        restarted.recover("p");restarted.recover("p")
        self.assertEqual(self.wallet.balance("p"),900);self.assertEqual(restarted.record("p")["round"]["phase"],"player")
    def test_crash_after_winning_payout_cannot_pay_it_again_on_restart(self):
        self.prepare(10,10,8,7);self.casino.action("p","deal")
        original=self.journal.commit;calls=[0]
        def commit(data):
            calls[0]+=1
            if calls[0]==2:raise OSError("crash after payout")
            return original(data)
        with patch.object(self.journal,"commit",side_effect=commit):
            with self.assertRaises(OSError):self.casino.action("p","stand")
        self.assertEqual(self.wallet.balance("p"),1100)
        restarted=Casino(Journal(self.journal.path),self.wallet);restarted.recover("p");restarted.recover("p")
        self.assertEqual(self.wallet.balance("p"),1100);self.assertEqual(restarted.record("p")["round"]["phase"],"settled")
    def test_failed_wallet_then_restart_uses_same_prepared_intent(self):
        self.prepare(10,10,8,7)
        with patch.object(coins,"save_balances",side_effect=OSError("disk full")):
            with self.assertRaises(OSError):self.casino.action("p","deal")
        self.assertEqual(self.wallet.balance("p"),1000)
        restarted=Casino(Journal(self.journal.path),self.wallet);restarted.recover("p")
        self.assertEqual(self.wallet.balance("p"),900)
    def test_insufficient_after_prepare_cancels_without_changing_hand_or_shoe(self):
        self.prepare(10,10,8,7);before=copy.deepcopy(self.casino.record("p"))
        with patch.object(self.wallet,"apply",side_effect=InsufficientFunds("spent elsewhere")):
            with self.assertRaises(InsufficientFunds):self.casino.action("p","deal")
        self.assertEqual(self.casino.record("p"),before)
    def test_restart_resumes_same_shoe_hand_and_revision(self):
        self.prepare(5,10,6,7,10);self.casino.action("p","deal")
        restarted=Casino(Journal(self.journal.path),self.wallet)
        self.assertEqual(restarted.view("p"),self.casino.view("p"))
        restarted.action("p","double");self.assertEqual(self.wallet.balance("p"),1200)
    def test_hidden_hole_card_and_shoe_never_sent_to_ui(self):
        self.prepare(5,10,6,7,10);self.casino.action("p","deal")
        view=self.casino.view("p")
        self.assertEqual(view["dealer"],[c(10)+1,53]);self.assertEqual(view["dealerTotal"],"10 + ?")
        self.assertNotIn("shoe",view);self.assertNotIn("pending",view)
    def test_bet_limits_and_active_round_changes_rejected(self):
        for bet in (0,9,11,100001,1.5,True):
            with self.assertRaises(ValueError):self.casino.action("p","bet",bet)
        self.prepare(5,10,6,7);self.casino.action("p","deal")
        for action in ("bet","deal"):
            with self.assertRaises(ValueError):self.casino.action("p",action,200)
    def test_next_bet_can_change_after_a_round_that_bought_insurance(self):
        self.prepare(10,1,9,10);self.casino.action("p","deal");self.casino.action("p","insurance")
        self.assertEqual(self.casino.record("p")["round"]["insurance"],50)
        self.casino.action("p","bet",200)
        self.assertEqual(self.casino.record("p")["bet"],200)
        self.assertEqual(self.casino.record("p")["round"]["original_bet"],100)
    def test_corrupt_journal_fails_closed_without_overwrite(self):
        self.journal.path.write_text("broken")
        with self.assertRaises(ValueError):Journal(self.journal.path)
        self.assertEqual(self.journal.path.read_text(),"broken")
