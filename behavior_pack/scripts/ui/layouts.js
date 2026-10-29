// Pure data shared verbatim by the Bedrock runtime and the Node asset builder.
export const UI = Object.freeze({ width: 800, height: 480, pxPerBlock: 160,
  texelScale: 2, distance: 2.5, maxDistance: 6, textPacks: 27,
  cellsPerLayer: 108, maskBits: 24, maxElements: 48, scale: 1,
  toastPrefix: "nsui:", item: "ns:interface_remote" });
export const REMOTES = Object.freeze({
  [UI.item]: Object.freeze({ transparent: false }),
  "ns:transparent_remote": Object.freeze({ transparent: true })
});
export const ALPHABET = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;!?+-*/=()[]<>_%#@&'\"\\|~";
export const THEME = Object.freeze({
  panel: "#120c21", header: "#241735", footer: "#0d0818",
  frame: "#aa83dc", frameInner: "#513666", card: "#20142f", cardBorder: "#785496",
  button: "#342047", buttonOn: "#4b2d68", buttonActive: "#60407c", buttonDisabled: "#21172c",
  buttonBorder: "#b68bde", onBorder: "#dbc0ff", disabledBorder: "#61496f",
  hover: "#eedbff", tooltip: "#150c24", tooltipBorder: "#bd94ee",
  text: "#f7f0ff", muted: "#b6a5cc", accent: "#d5b0ff", field: "#c9a8ff",
  remoteBody: "#20122f", remoteFrame: "#bc8df0", remoteScreen: "#53346f",
  remoteKey: "#dec3ff", remoteKeyAlt: "#9663c7", cursorDark: "#10091b",
  borderPixels: 2
});
export const COLORS = [THEME.text, THEME.muted, THEME.accent, "#99e4bb", THEME.field, "#ff91b2", "#ffffff", "#b69cff"];
export const ICONS = ["none", "remote", "oak_log", "sapling", "apple", "diamond", "wheat", "stick", "stone", "chest", "gear", "heart", "clock", "check", "arrow", "warning"];
const button = (id, label, x, y, w, tip, kind = "button") => ({ id, kind, label, rect: [x, y, w, 20], tip });
const field = (id, x, y, length, color = 0, rows = 1) => ({ id, x, y, length, color, rows });
const back = () => button("back", "< BACK", 12, 12, 52, "Return to the previous page");
const base = (id, title, elements, fields = [], cards = [], labels = []) => ({ id, title,
  elements, fields, cards, labels });
export const PAGES = [
  base("dashboard", "ENTITY UI DEMO", [
    button("controls", "CONTROLS >", 20, 111, 132, "Toggles, steppers and fields"),
    button("inventory", "ITEM SLOTS >", 168, 111, 132, "View real inventory slots"),
    button("rename", "RENAME", 20, 139, 84, "Enter text using gaze keys"),
    button("toast", "TOAST", 118, 139, 84, "Send a top-right HUD toast"),
    button("close", "CLOSE", 216, 139, 84, "Close this panel")
  ], [field("name", 30, 66, 22, 4), field("summary", 30, 85, 42, 1)],
  [[20, 48, 280, 52]], [[20, 12, "STANDALONE / 3D INTERFACE", 2], [20, 36, "LOOK AT A CONTROL. USE THE REMOTE.", 1]]),
  base("controls", "CONTROLS", [back(),
    button("enabled", "ENABLED", 20, 61, 86, "Toggle the demo setting", "toggle"),
    button("alerts", "ALERTS", 114, 61, 86, "Toggle HUD alerts", "toggle"),
    button("advanced", "ADVANCED", 208, 61, 92, "Disabled until Enabled is on"),
    button("minus", "-", 20, 98, 28, "Decrease amount", "stepper"),
    button("amount", "EDIT AMOUNT", 110, 98, 110, "Set an exact amount", "field"),
    button("plus", "+", 228, 98, 28, "Increase amount", "stepper"),
    button("name", "EDIT NAME", 20, 135, 110, "Open the gaze keyboard", "field"),
    button("reset", "RESET", 216, 135, 84, "Reset after confirmation")
  ], [field("amount", 56, 104, 8, 2), field("name", 138, 142, 12, 4)],
  [[12, 48, 296, 115]], [[82, 19, "CONTROLS", 2], [20, 39, "LIVE SETTINGS / SAVED PER PLAYER", 1]]),
  base("inventory", "ITEM SLOTS", [back(), ...Array.from({ length: 12 }, (_, i) => ({
    id: `slot${i}`, kind: "slot", rect: [22 + (i % 6) * 48, 61 + Math.floor(i / 6) * 44, 36, 36],
    iconSlot: i, tip: "Inspect this real inventory slot" }))],
  [field("description", 20, 146, 46, 1), ...Array.from({ length: 12 }, (_, i) => field(`count${i}`, 24 + (i % 6) * 48, 86 + Math.floor(i / 6) * 44, 5, 0))],
  [], [[82, 19, "YOUR INVENTORY", 2], [20, 40, "READ-ONLY LIVE SLOTS 1-12", 1]]),
  base("confirm", "CONFIRM", [
    button("yes", "CONFIRM", 40, 132, 108, "Confirm this action"),
    button("no", "CANCEL", 172, 132, 108, "Cancel and return")
  ], [field("message", 28, 68, 44, 0, 3)], [[16, 48, 288, 114]], [[20, 17, "CONFIRM ACTION", 2]]),
  base("keyboard", "GAZE KEYBOARD", [
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("").map((key, i) => button(`key:${key}`, key, 16 + (i % 12) * 24, 78 + Math.floor(i / 12) * 23, 22, `Type ${key}`)),
    button("space", "SPACE", 16, 148, 72, "Insert a space"),
    button("erase", "ERASE", 96, 148, 64, "Delete the last character"),
    button("done", "DONE", 168, 148, 64, "Save this text"),
    button("cancel", "CANCEL", 240, 148, 64, "Discard these changes")
  ], [field("prompt", 20, 36, 46, 1), field("input", 24, 59, 44, 4)],
  [[16, 51, 288, 18]], [[20, 14, "GAZE KEYBOARD", 2]]),
  base("amount", "EXACT AMOUNT", [
    ..."1234567890".split("").map((key, i) => button(`digit:${key}`, key, 32 + (i % 5) * 52, 82 + Math.floor(i / 5) * 26, 48, `Enter ${key}`)),
    button("erase", "ERASE", 32, 140, 80, "Delete the last digit"),
    button("done", "SAVE", 120, 140, 80, "Save the exact amount"),
    button("cancel", "CANCEL", 208, 140, 80, "Discard these changes")
  ], [field("prompt", 24, 39, 44, 1), field("input", 32, 63, 40, 2)],
  [[24, 55, 272, 20]], [[20, 14, "EXACT AMOUNT", 2]]),
  { ...base("leaderboard", "LEADERBOARD", [], [
    {...field("title",28,20,40,2),scale:2}, field("objective",28,47,64,1),
    {...field("headerRank",28,68,3,1),scale:2},
    {...field("headerName",108,68,6,1),scale:2},
    {...field("headerScore",640,68,5,1),scale:2},field("status",28,450,64,1),
    ...Array.from({length:15},(_,i)=>[
      {...field(`rank${i}`,28,94+i*22,3,i<3?2:1),scale:2},
      {...field(`player${i}`,108,94+i*22,24,0),scale:2},
      {...field(`score${i}`,640,94+i*22,11,4),scale:2}
    ]).flat()
  ]), passive:true },
  {...base("blackjack","BLACKJACK",[
    ...Array.from({length:4},(_,i)=>({...button(`hand${i}`,`HAND ${i+1}`,24+i*188,178,176,"Inspect this split hand"),rect:[24+i*188,178,176,28]})),
    ...[["hit","HIT",24,356,110],["stand","STAND",142,356,110],["double","DOUBLE DOWN",260,356,128],
      ["split","SPLIT",396,356,110],["surrender","SURRENDER",514,356,120],["close","CLOSE",642,356,134],
      ["minus","-",24,406,32],["bet","EDIT BET",64,406,136],["plus","+",208,406,32],["deal","DEAL",248,406,120],
      ["insurance","INSURANCE",376,406,126],["decline","NO INSURANCE",510,406,136],["even_money","EVEN MONEY",654,406,122],
      ["rules","RULES",676,12,100],["cards_prev","<",696,234,34],["cards_next",">",738,234,34]]
      .map(([id,label,x,y,w])=>({...button(id,label,x,y,w,id==="close"?"Leave: remaining hands automatically stand":label),rect:[x,y,w,28]}))
  ],[
    field("balance",410,22,42,3),field("dealerTotal",494,64,44,2),field("message",24,153,120,4),
    field("bet",250,442,46,2),field("handTitle",24,238,105,0),
    ...Array.from({length:4},(_,i)=>field(`summary${i}`,30+i*188,215,29,1))
  ],[[16,50,768,118],[16,174,768,164]],[[24,15,"BLACKJACK / KITPVP COINS",2],[24,56,"DEALER",1]]),
    playingCards:[...Array.from({length:12},(_,i)=>({slot:i,rect:[24+i*61,76,48,68]})),
      ...Array.from({length:12},(_,i)=>({slot:i+12,rect:[24+i*61,267,48,68]}))]},
  base("blackjack_rules","BLACKJACK RULES",[back()],
    Array.from({length:7},(_,i)=>field(`rule${i}`,24,80+i*43,84,0)),
    [[16,56,768,352]],[[96,19,"BLACKJACK / TABLE RULES",2]])
];
export const PAGE_IDS = Object.fromEntries(PAGES.map((page, index) => [page.id, index]));
// Tooltip cells are ordinary dynamic cells with a movable parent bone.
export function textCells(page) {
  const fields = page.passive ? page.fields : [...page.fields, field("hint", 16, UI.height - 14, 48, 1),
    { ...field("tipTitle", 6, 5, 28, 0), tooltip: true },
    { ...field("tipDetail", 6, 16, 28, 1, 2), tooltip: true }];
  return fields.flatMap(f => Array.from({ length: f.length * f.rows }, (_, index) => ({
    field: f.id, index, x: f.x + (index % f.length) * 6 * (f.scale??1),
    y: f.y + Math.floor(index / f.length) * 9 * (f.scale??1), scale:f.scale??1, color: f.color, tooltip: !!f.tooltip,
    width: f.length, rows: f.rows })));
}
export const MAX_LAYERS = Math.max(...PAGES.map(p => Math.ceil(textCells(p).length / UI.cellsPerLayer)));
