"""Six-deck S17 blackjack; pure rules, no UI, money or native server objects."""
import copy
import secrets

RULES = ("6 DECKS / DEALER STANDS ON ALL 17", "BLACKJACK 3:2 / OTHER WINS 1:1 / TIES PUSH",
         "DOUBLE ANY FIRST TWO CARDS / DOUBLE AFTER SPLIT",
         "SPLIT EQUAL VALUES / MAX 4 HANDS / NO RESPLIT ACES",
         "SPLIT ACES: ONE CARD EACH / SPLIT 21 IS NOT BLACKJACK",
         "INSURANCE 2:1 / LATE SURRENDER HALF YOUR BET",
         "DEALER PEEKS UNDER ACE OR TEN / EVEN COIN BETS")


def rank(card):
    return card % 13 + 1


def value(card):
    return min(rank(card), 10)


def total(cards):
    count = sum(value(c) for c in cards)
    soft = any(rank(c) == 1 for c in cards) and count + 10 <= 21
    return count + (10 if soft else 0), soft


def natural(hand):
    return not hand.get("split", False) and len(hand["cards"]) == 2 and total(hand["cards"])[0] == 21


def shoe():
    cards = list(range(52)) * 6
    secrets.SystemRandom().shuffle(cards)
    return cards


def draw(cards):
    if not cards:
        raise ValueError("Shoe exhausted; round preserved for recovery")
    return cards.pop()


def hand(cards, bet, split=False, aces=False):
    return {"cards": cards, "bet": bet, "split": split, "aces": aces,
            "done": False, "acted": False, "surrendered": False}


def settle(game, cards):
    dealer_bj = len(game["dealer"]) == 2 and total(game["dealer"])[0] == 21
    live = [h for h in game["hands"] if not h["surrendered"] and total(h["cards"])[0] <= 21]
    if not dealer_bj and not game.get("even_money") and any(not natural(h) for h in live):
        while total(game["dealer"])[0] < 17:
            game["dealer"].append(draw(cards))
    dealer = total(game["dealer"])[0]
    for h in game["hands"]:
        points = total(h["cards"])[0]
        if game.get("even_money"):
            result, returned = "EVEN MONEY", h["bet"] * 2
        elif h["surrendered"]:
            result, returned = "SURRENDER", h["bet"] // 2
        elif points > 21:
            result, returned = "BUST", 0
        elif dealer_bj:
            result, returned = ("PUSH", h["bet"]) if natural(h) else ("DEALER BLACKJACK", 0)
        elif natural(h):
            result, returned = "BLACKJACK", h["bet"] * 5 // 2
        elif dealer > 21 or points > dealer:
            result, returned = "WIN", h["bet"] * 2
        elif points == dealer:
            result, returned = "PUSH", h["bet"]
        else:
            result, returned = "LOSE", 0
        h.update(done=True, result=result, returned=returned)
    game["insurance_return"] = game["insurance"] * 3 if dealer_bj else 0
    game["returned"] = sum(h["returned"] for h in game["hands"]) + game["insurance_return"]
    game["net"] = game["returned"] - sum(h["bet"] for h in game["hands"]) - game["insurance"]
    game["phase"] = "settled"


def advance(game, cards):
    for i, h in enumerate(game["hands"]):
        if h["done"]:
            continue
        if len(h["cards"]) == 1:
            h["cards"].append(draw(cards))
        if h["aces"] or total(h["cards"])[0] >= 21:
            h["done"] = True
            continue
        game["active"] = i
        return
    settle(game, cards)


def peek(game, cards):
    if total(game["dealer"])[0] == 21 or natural(game["hands"][0]):
        settle(game, cards)
    else:
        game["phase"] = "player"


def deal(cards, bet):
    if type(bet) is not int or bet < 2 or bet % 2:
        raise ValueError("Use an even whole-coin bet for exact 3:2 and half-bet payouts")
    # Deal in casino order: player, dealer up, player, dealer hole.
    first, up, second, hole = [draw(cards) for _ in range(4)]
    game = {"phase":"player", "original_bet":bet, "hands":[hand([first, second], bet)], "dealer":[up, hole],
            "active":0, "insurance":0, "returned":0, "insurance_return":0, "net":0}
    if rank(up) == 1:
        game["phase"] = "insurance"
    elif value(up) == 10 or natural(game["hands"][0]):
        peek(game, cards)
    return game


def legal(game, balance):
    if not game or game["phase"] == "settled":
        return set()
    if game["phase"] == "insurance":
        result = {"decline"}
        if balance >= game["hands"][0]["bet"] // 2:
            result.add("insurance")
        if natural(game["hands"][0]):
            result.add("even_money")
        return result
    h = game["hands"][game["active"]]
    result = {"hit", "stand"}
    if len(h["cards"]) == 2 and not h["acted"] and balance >= h["bet"]:
        result.add("double")
        if value(h["cards"][0]) == value(h["cards"][1]) and len(game["hands"]) < 4 and not h["aces"]:
            result.add("split")
    if len(h["cards"]) == 2 and not h["acted"] and not h["split"]:
        result.add("surrender")
    return result


def act(original, cards, action, balance):
    if action not in legal(original, balance):
        raise ValueError("That action is not available for this hand or balance")
    game = copy.deepcopy(original)
    cost = 0
    if game["phase"] == "insurance":
        if action == "even_money":
            game["even_money"] = True
            settle(game, cards)
        else:
            if action == "insurance":
                cost = game["hands"][0]["bet"] // 2
                game["insurance"] = cost
            peek(game, cards)
        return game, cost
    h = game["hands"][game["active"]]
    if action == "hit":
        h["acted"] = True
        h["cards"].append(draw(cards))
        h["done"] = total(h["cards"])[0] >= 21
    elif action == "stand":
        h["done"] = True
    elif action == "double":
        cost = h["bet"]
        h["bet"] *= 2
        h["cards"].append(draw(cards))
        h["acted"], h["done"] = True, True
    elif action == "surrender":
        h["surrendered"], h["done"] = True, True
    elif action == "split":
        cost = h["bet"]
        first, second = h["cards"]
        aces = rank(first) == 1
        h.update(hand([first, draw(cards)], cost, True, aces))
        game["hands"].insert(game["active"] + 1, hand([second], cost, True, aces))
        h["done"] = aces or total(h["cards"])[0] == 21
    advance(game, cards)
    return game, cost


def finish(original, cards):
    """Leaving never refunds a dealt round: decline insurance, stand each hand."""
    game = copy.deepcopy(original)
    if game["phase"] == "insurance":
        game, _ = act(game, cards, "decline", 0)
    while game["phase"] == "player":
        game, _ = act(game, cards, "stand", 0)
    return game
