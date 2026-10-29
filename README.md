# Endstone Entity Leaderboards

Source for the `/lb` entity leaderboard plugin, including its shared Entity UI
Demo behavior/resource packs, builders, previews and optional blackjack demo.
KitPvP is only needed for the blackjack coin wallet; leaderboards do not require it.

Standalone Minecraft Bedrock **BP + RP**, with an **Endstone packet leaderboard backend**. The separate interactive demo uses stable `@minecraft/server` **2.0.0**, not `@minecraft/server-ui`. Packet leaderboards support **protocols 2193 and 2225** (Bedrock 26.50–26.52 and 26.60); other protocols fail closed. No experimental toggles, forms, chest screens or chat menus.

Plugin **1.2.1** selects its spawn codec from the server protocol and writes the
optional block-passenger field required by [26.60 AddActor](https://mojang.github.io/bedrock-protocol-docs/1.26.60/packets/add-actor-packet/).
Directly update with `node tools/install.mjs ../bedrock_server --bridge-only`,
then restart. Resource pack/BP versions remain **1.2.0**; no texture rebuild is
needed. Saved leaderboards and offline score caches are retained. Automated
checks decode every 2225 leaderboard layer; in-game rendering is still a smoke test.

## Personal blackjack (1.2.0)

Run `/blackjack` to open your own midnight-purple 3D table. No remote is required: look at a button and interact with the panel or one of its text layers. Run the command again or click Close to leave. This is the existing entity-based UI, not a form, chest screen or chat menu. Endstone owns the rules, cryptographic shuffle, hidden dealer card and all coin transactions; the Script API renders the UI and forwards authenticated actions only.

It uses the **same KitPvP coins as `/balance`, `/coins` and the shop**, not the separate `money` scoreboard. Bets are even whole numbers from **10 to 100000**, default 100; this preserves exact half-bet insurance/surrender and 3:2 payouts without silently rounding. Set a bet with +/- or the gaze keypad, then Deal. Illegal or unaffordable actions are disabled and checked again by Endstone. Totals, soft hands, individual split wagers and round net/returned coins are shown. Select each completed split hand to inspect it; arrows page unusually long player hands. All 52 suit/rank faces and a distinct dealer card back are included.

The explicit American-hole-card rules are: six decks; dealer stands on soft 17; dealer peeks under ace/ten; natural blackjack pays 3:2, other wins 1:1 and ties return the stake; doubling on any first two cards including after splits; equal-value pairs may split up to four hands; split aces receive one card each with no resplitting/hitting/doubling; a split 21 is not a natural; full half-bet insurance pays 2:1; natural hands may take even money against an ace; late surrender is available only on the unplayed original hand after the dealer check. There is no five-card Charlie or European no-hole-card rule. Casinos use different variants, so these are displayed under Rules rather than claiming every variation at once. [MGM's blackjack terminology and rules](https://www.mgmresorts.com/en/gamesense/guide-to-blackjack.html)

Each player has a persisted six-deck shoe, reshuffled between rounds when fewer than 128 cards remain. Cards never reshuffle inside a round. Closing, walking away, death, dimension changes, quitting or three minutes of inactivity declines unresolved insurance and **stands all remaining hands**; it does not refund a dealt bet. A clean shutdown settles open games. After an abrupt restart, unfinished hands/shoes resume when `/blackjack` is reopened.

`plugins/leaderboard_bridge/blackjack.json` and its `.bak` preserve game state. A write-ahead intent is saved before a debit/credit. KitPvP atomically writes the entire current wallet and an idempotency receipt into its own `coins.json`; replaying the same transaction after a crash cannot apply it twice. The reserved `__coin_transactions__` metadata is ignored by normal balance loading and retained by routine saves. Receipts are retained for recovery/audit, not silently pruned. A bad journal or unavailable upgraded KitPvP API fails closed. No assistant tests bet with or change actual server balances.

Token-bound server-origin messages, permission/range/dimension checks, server revisions and UI click locking reject spoofed or repeated actions. The hole card and undealt shoe are never included in UI snapshots. Only open players are checked once per second; unchanged views are not resent and there is no casino work when nobody is using a table. Financial writes deliberately prioritize durability over batching wagers.

Both BP and RP must be updated to **1.2.0** for the new pages/card properties. The updated plugin includes the RP in its WHL and still auto-installs it. The KitPvP economy source also needs the new public durable transaction API; this workspace's server imports that source directly. Restart the server and accept the updated pack. Headless rules, money-recovery and UI tests plus CPU previews are not proof of in-game rendering; the final smoke test remains `/balance` → `/blackjack` → a small wager → `/balance`, then splitting/doubling/insurance/close/reconnect.

## Leaderboards

With the existing behavior pack enabled and the included Endstone plugin installed, run this in-game as an operator (permission `leaderboard.create`). Plugin 1.1.0 bundles and automatically installs the resource pack during startup:

```mcfunction
/lb create kills 15
```

Syntax: `/lb create <scoreboard> <amount>`. Use an **existing objective ID**, not its display name. Amount must be a whole number **1-15**; invalid requests create nothing. Highest scores rank first, with names breaking ties. Only real player scores are listed. Offline players keep their **last cached values**; offline changes are not visible until they rejoin. Initial migration imports saved offline scores once. Fake scoreboard entries and entity scores are excluded.

To remove a created display, use the numeric ID shown in its creation notification:

```mcfunction
/lb remove 1
```

Syntax: `/lb remove <id>`, with the same operator/default `leaderboard.create` management permission as creation. Only that leaderboard's client-only actors and saved definition are removed; its scoreboard objective, player scores and other displays stay untouched. Removal persists across restarts. Unknown or invalid IDs remove nothing. `/lb status` (also from console) reports startup readiness and cumulative packet/byte/score-read/text-build counters. `/lb retry` safely retries an unacknowledged startup migration; it does not recreate removed boards.

The leaderboard is a transparent display with a continuous midnight-purple border, title, rank/name/score columns and status. It is placed in front of the creator, faces them, and stays at that world location. **No remote opens or closes it.** Saved definitions survive death, logout and restart. Endstone sends fake actors to same-dimension players within 48 blocks and removes them past 56 blocks (hysteresis); entering range restores the display. Reconnect, respawn, dimension change, removal and plugin disable clean up viewer state. Scores refresh once per second, independent of chunk loading. Removing an objective clears cached scores/rows; recreation starts fresh. An empty objective shows `NO PLAYER SCORES YET`.

The exact unnamespaced `/lb` command is provided by `server_bridge/ns_lb_bridge`. Direct source installation remains available; the optional WHL also contains the resource pack. Endstone owns commands, ranking, offline caching, persistence, viewer tracking and all leaderboard rendering packets. It never changes scoreboard values. There are no real leaderboard actors to simulate, no server actor searches and no ticking areas. Clients still require the RP and still render glyph quads; this reduces server work, not necessarily client draw cost. Runtime uses only Python's standard library plus Endstone.

### Startup migration and recovery (1.1.0)

On the first restart, a nonce-checked, server-origin **one-time** handoff exports the old world registry and player scores. Endstone validates and atomically saves `plugins/leaderboard_bridge/leaderboards.json` before acknowledging. Only then does the addon mark the world as migrated, stop its legacy leaderboard polling task and remove loaded old leaderboard actors. Late-loaded old actors are removed by `entityLoad`; interactive demo entities are untouched. IDs, objectives, amounts, positions and rotations are retained. The original world registry remains as a rollback snapshot, but is never reimported once a native registry exists.

After migration there is **no Script API leaderboard score relay or update loop**. Startup only acknowledges the migration marker and does a single old-actor cleanup pass. Endstone waits for confirmation before sending fake actors. Missing acknowledgement times out after 60 seconds, sending no fake actors; inspect logs and use `/lb retry` after correcting the problem. Malformed storage or unsupported protocol disables creation rather than overwriting data.

The initial import is backed up as `leaderboards.legacy-import.json`; later saves retain `leaderboards.json.bak` (previous successful snapshot). Online score-cache changes flush every five seconds and on quit/shutdown; abrupt crashes may lose up to five seconds of cached offline scores, not acknowledged command changes. If a migrated world loses its Endstone registry, restore its backup with the server stopped. Do not clear the migration marker to recover a missing file: the old world snapshot can contain boards you have since removed. The BP must remain enabled for custom actor registration and migration compatibility; the existing interactive demo remains Script API-based.

## Existing interactive demo

Enable both packs and accept the resource pack. Give yourself the remote once:

```mcfunction
/give @s ns:interface_remote
```

For the **separate transparent GUI**, give yourself its own remote:

```mcfunction
/give @s ns:transparent_remote
```

The Transparent Interface Remote opens the same demo pages on an 800x480 canvas without the large background, header/footer fills or cards. A continuous purple outer frame, buttons, slots, static/dynamic text, cursor, hover outlines and item tooltips remain visible. The original remote keeps the solid midnight-purple panel. The two variants share demo settings and controls; switching remotes closes the old session, and using the new remote opens its variant. These original demo pages are separate from permanent command-created leaderboards.

Hold the remote and **use/right-click** to open. A hollow circular cursor tracks your gaze every tick on the panel, including empty/background areas. Look at a control and use again, or **interact directly with the panel entity**, to select it. Panel and text-layer interactions only operate the owner's session, respect disabled controls, and share click debouncing with the remote. Use while looking off the panel to close. Walking more than six blocks away, changing dimension, dying, leaving, or switching away from the remote also closes it.

The remote appears in Creative equipment. On touch, use its **Open / Click / Close** interact button. Normal movement/camera controls remain available; there is no camera lock.

## Pages

- Dashboard: navigation, rename, HUD toast, close.
- Controls: two toggles, a disabled/active example, +/- stepper, exact-amount editor, and confirmed reset. Settings persist per player.
- Item slots: the first 12 slots of the player's actual inventory, refreshed five times per second. Gaze tooltips show item names, identifiers and counts. **Read-only**; no hidden chest/container or inventory screen is used. Unknown item textures have a warning icon; every slot still shows the actual identifier/count.
- Confirmation: returns `true`/`false` through a callback.
- Gaze keyboard: uppercase A-Z, digits, space, erase, save/cancel; maximum 44 characters.
- Exact amount: keypad for integers 1-999999; range-checked save/cancel.
- Leaderboard: passive, transparent scoreboard display with up to 15 player rows; created by `/lb`, not demo navigation.

Pages/editors return `undefined` when cancelled or when their session closes. Confirm's Cancel returns `false`.

## Build and verify

Node **24+** and Python **3.10+** (for command bridge tests):

```powershell
# Run from the repository root.
npm install --ignore-scripts
npm run check
```

There are **no build/runtime image dependencies**. The builder's original rasterizer, PNG encoder, 5x7 pixel font and 16x16 icon painters live in `tools/raster.mjs` and are used by `tools/build-ui.mjs`. Dev dependencies are only the official stable API declarations and TypeScript for checks. You can run `npm run build` and `npm test` without downloading dependencies; `typecheck` needs the dev dependencies.

`npm run build` writes all geometry, entity definitions, animations, render controllers, glyph/icon/page textures, `build-report.json`, and CPU proof images in `previews/`. Generated files are included in the packs; edit their source layout/builder instead of editing generated JSON.

`npm run check` runs the build, JavaScript and Python command bridge tests, JSON/reference/PNG validation, and stable API type checking. Tests cover glyph precision, hit testing, masks, property diffing, PNG CRCs, navigation, editor callbacks, tooltips, occlusion, cleanup, ground lift, corrected four-direction panel yaw, circle cursor tracking, and native entity-interaction routing/ownership/debouncing, leaderboard ranking, persistence, missing-layer repair, amount limits and command permissions. Geometry regression tests read the generated model files to check visible button positions, glyph reading order, icon alignment and cursor/tooltip animation signs, and raycast rendered button centres back to the same button IDs at nine headings. **CPU previews/mocked tests are not proof of Minecraft client rendering.** Check the client content log and the in-game smoke checklist below.

The optional blackjack wallet integration tests use a separate sibling checkout
at `../kitpvp/src/endstone_kitpvp`. Without it, those tests are explicitly skipped;
leaderboard, resource-pack, UI and blackjack rules tests still run. That separate
plugin's source and live wallet data are not included in this repository.

## Bundled resource pack / WHL (plugin 1.2.1)

Build the portable plugin from the addon root:

```powershell
npm run build:wheel
npm run verify:wheel
```

The result is `dist/endstone_leaderboard_bridge-1.2.1-py3-none-any.whl`. It contains the plugin, shared layout contract, the **entire current resource pack** as `ns_lb_bridge/assets/entity_ui_demo.mcpack`, and its SHA-256 index. The current RP compresses to about 216 KiB including blackjack cards/pages. `tools/bundle-resources.py` uses deterministic ZIP timestamps and Python's standard library; wheel building uses isolated Hatchling build dependencies. No new runtime dependencies are needed. Blackjack on another server also requires the updated KitPvP economy API and BP 1.2.0.

On another Endstone **0.11.14** server, place the WHL in `plugins/` with the server stopped, then start it. Do not leave an older WHL of the same plugin beside it or install a second independent copy. Existing installations created by this repository should use the direct updater below; it archives superseded metadata outside Python's search path so only one entry point remains.

`on_load()` validates the bundled checksum/manifest and atomically installs `resource_packs/ns_entity_ui_demo.mcpack` **before pack discovery**, without changing world pack lists or `server.properties`. Endstone automatically activates archive packs and deduplicates packs already active under the same UUID/version. The existing extracted RP may remain installed; the plugin never removes or overwrites that folder. The normal client download/acceptance step still applies. The behavior pack is **not** bundled in the WHL and must remain enabled for custom actor registration and the startup migration acknowledgement; it is already installed on this project's server.

Identical archives are left untouched. Updates to this plugin's own archive retain `ns_entity_ui_demo.mcpack.bak`. An unrelated/corrupt archive occupying that exact filename, a symlink destination or a newer installed pack causes a clear error instead of an overwrite/downgrade. If installation fails, leaderboard packets remain disabled. There are no download/extraction operations during ticks. Pack changes require a full server restart; `/reload` is not sufficient to refresh clients' negotiated pack stack.

Wheel verification checks every RECORD hash/size, entry-point metadata and bundled bytes, installs into a clean temporary directory, then tests first-install and unchanged-startup behavior from the **installed wheel**. This does not replace an in-game join/render test.

### Direct source installation

With your server stopped:

```powershell
npm run install:server
```

Or `node tools/install.mjs C:/path/to/bedrock_server`.

Installs source packs directly into `behavior_packs/ns_entity_ui_demo_bp` and `resource_packs/ns_entity_ui_demo_rp`, adds their UUIDs to the currently configured world's pack lists, and installs the `/lb` bridge package plus bundled assets/metadata directly under `plugins/.local`. Existing unrelated packs/plugins are preserved. Changed world pack lists receive timestamped backups; superseded plugin metadata is retained under `plugins/leaderboard_bridge/install-backups/`. This direct installer does not build a WHL, reload a plugin, terminate/restart the server or edit gameplay world data. `texturepack-required` is not changed; clients must accept the RP for panels/toasts to render.

For a Python/plugin-only update with the existing BP/world pack lists left untouched:

```powershell
node tools/install.mjs ../bedrock_server --bridge-only
```

The plugin writes its bundled `.mcpack` at the next normal server start.

To disable: stop the server and remove only these UUID entries from that world's pack lists:

- BP: `b8721bce-5294-4c95-8d78-6294d67c9612`
- RP: `c05a94e1-7c75-4cbb-8bcd-c08cf7f2e83e`

## Implementation

`behavior_pack/scripts/ui/layouts.js` is shared pure layout data. It defines an 800x480 pixel panel (5x3 blocks), 160 pixels/block, 2x baked texel scale, and seven pages (six interactive demos plus the passive leaderboard). The canvas is 2.5x wider and taller than the original 320x192 panel, providing 6.25x the area for additional content. Existing text, buttons and slots retain their pixel/world size. The header, footer, selection hitboxes, ground sampling and gaze bounds cover the enlarged panel. The builder sizes the texture atlas from the canvas and keeps the sprite shelf below the page. Maximum 48 interactive controls/page, split into two 24-bit masks per state. Cards, labels, buttons, toggles, steppers, fields and item slots are represented by data, not controller-specific rendering code.

`ns:interface_panel` spawns 2.5 blocks along the head gaze, facing the owner on a vertical plane. The entity's render yaw includes a 180-degree facing correction. With this heading, local model +X points to the viewer's left: `tools/model-space.mjs` converts UI X to `(width/2 - x) * unitsPerPixel`, places positive-width cube origins at each rectangle's right edge, and converts horizontal animation offsets to negative model X. Buttons, icons, glyph quads, cursor, hover and both tooltip parents use the same conversion. The logical gaze basis, text packing and legible south-face UVs are unchanged; strings/individual glyphs are not mirrored. Its bottom edge is sampled; if it intersects a solid block, the panel rises one block. It has no gravity/collision, a 0.01 physical collision box, damage cancellation, no loot and is summonable. Panel and text entities also have panel-sized `custom_hit_test` selection hitboxes and a non-consuming `interact` component: the physical box no longer limits direct button interactions. Their broad native selection boxes do not replace exact plane/rectangle checks. It has **22 client-synced int properties**, including `ns:transparent`. Geometry/texture selection is `Array.geo[v.pg]` / `Array.tex[v.pg]`. Four button states are baked separately; a hidden mask removes the control entirely rather than leaving a baked button behind.

Both GUI variants reuse the same geometry and atlas. The transparent variant hides the `page` background bone using `ns:transparent`; labels have their own alpha-tested sprite quads so they remain visible without opaque rectangles. No duplicate panel textures or extra text properties are required. CPU previews for that variant are `previews/transparent_*.png`.

All dynamic text is drawn by transparent-background `ns:text_layer` entities stacked slightly in front of the panel. They have **32 client-synced int properties**: page/layer/scale/tooltip coordinates/tooltip visibility plus 27 text packs (**108 cells**). Only as many layers as the page needs are spawned (2-3 in this demo). Every cell is its own geometry quad, with a selective render controller; four 6-bit glyph IDs are packed per int. Maximum value is 16777215, exactly representable in Molang floats. The 64-character atlas has eight colour sheets. Unsupported characters become spaces; lowercase is mapped to uppercase.

Text and icon UV animation explicitly uses vanilla **`player_animated`**. Page backgrounds use `entity_alphatest` without UV animation. Do not change the dynamic renderers to `entity_alphatest`; it ignores their UV animation.

Each tick, a ray starts at `getHeadLocation()` plus 0.1 Y and intersects the panel plane. Conversion uses `k = pxPerBlock / scale`; hidden controls cannot be hovered/clicked. Terrain occlusion rejects through-wall input, and item use performs a fresh hit test instead of trusting a stale hover.

Hover/cursor/tooltip rectangles are driven by packed coordinate properties and generated bone animations. Scalable borders use top-left parent pivots and corner-specific counter-scaling (including the bottom-right anchor). Middle slices translate to the fixed inset and stretch only the space between corners: two-pixel edges stay joined at every control/tooltip size, instead of developing gaps under parent scaling. Hover pixels are fully opaque, have no timed fade, and sit at a separate depth from the buttons. The shared `THEME` palette in `layouts.js` supplies midnight-purple pages, controls, glyph colours, remote and toast textures. State masks, fields, icons and status hints come from page controllers. Only changed properties are sent. Item tooltips follow hovered slots, stay inside the panel, and use normal glyph cells with an animated tooltip parent.

`InterfaceSession` owns the page stack and `{enter, view, action, tooltip}` controllers. `view(ctx)` returns `{fields, states, icons, hint}`. Add new pages in `layouts.js`, matching controllers in `controllers.js`, and run the builder. UI pages are world-visible entities, not private client overlays; only their owner can operate that session. Do not treat these demo controls as an authorization layer.

Interactive demo orphans in loaded chunks are removed on `worldLoad` and every 10 seconds thereafter. These demo entities also have a 30-second timer refreshed every five seconds by their owner. This handles unloaded chunks that cannot be enumerated at startup without loading the entire world.

Leaderboards use client-only `ns:leaderboard_panel` / `ns:leaderboard_text` actors. The builder exports `server_bridge/ns_lb_bridge/layout.json` from the same layout/property definitions used by the RP/BP. Endstone sends ordered property schemas through SyncActorProperty, complete initial properties through AddActor, and changed properties through SetActorData. RemoveActor uses signed unique IDs, not runtime IDs. IDs are allocated in a high, randomized range to avoid ordinary server entity IDs; the public API offers no globally reserved fake-ID allocator. No Actor wrappers are cached. The leaderboard page keeps its existing doubled glyph sizes and up to seven 32-property text layers for 15 rows; smaller boards use fewer layers. The border remains a separate renderer and four solid strips.

HUD notifications call `setTitle("nsui:" + text, timings)`. `resource_pack/ui/hud_screen.json` patches only `root_panel`'s title factory: ordinary titles use the vanilla control; strings containing `nsui:` render a top-right nineslice toast, with the prefix removed through view bindings on `#hud_title_text_string`. Since toasts use Minecraft's title channel, they replace a currently active title. Other packs that replace the same title factory may conflict.

## Offline-name cleanup

The bridge filters the unresolved offline-player name `commands.scoreboard.players.offlinePlayerName` from migration and rankings. On startup it repairs existing caches once, retaining the original file in `leaderboards.json.bak`. Named offline players, their cached scores, board placements and the actual scoreboard are unchanged. Unnamed players appear normally once they join and Endstone can observe their real name and current score. This cleanup adds no per-tick cache scan or Script API relay.

## Packet join fix (protocol 2193)

The Endstone fake-actor spawn encoder now writes both the metadata variant index and the restated payload type required since protocol 2168. The missing second type byte made current clients reject leaderboard spawn packets and is the likely cause of the reported `Block` disconnect. Fixed-byte packet regression tests enforce the current format and reject the old malformed format. Install the corrected bridge directly and restart the server; saved leaderboard definitions and scores are unchanged. No resource-pack update is needed for this Python-only correction. Automated checks do not replace an in-game reconnect test.

## Rendering fix (1.0.10)

Minecraft's client content log showed `controller.render.ns.page_6 | part_visibility | Required child not found`, followed by `Invalid render controller: controller.render.ns.lb_frame`. The passive page emitted `part_visibility: []`, causing Bedrock to reject the entire shared panel-renderer file even though its border model was valid. Version 1.0.10 omits that optional property for passive geometry, isolates the border renderer in `ns_leaderboard.render_controllers.json`, and rejects empty visibility arrays in automated tests/validation. No additional entities, per-tick work or textures are added. Restart and reconnect with resource pack version 1.0.10; existing leaderboards do not need recreation. In-game visibility still needs verification after clients load the corrected pack.

## Performance (1.0.8 onwards)

The old renderer submitted the entire text-layer geometry for each glyph, then ran 108 visibility tests to hide everything except that glyph. Each glyph now has its own single-quad geometry. Blank glyphs skip their render controller completely. Glyph IDs are decoded from each packed property once per render frame and reused; colour sheets use static geometry UVs instead of long per-page Molang branches. Normal text, reading direction, glyph resolution and the 15-player limit are unchanged.

Leaderboard entities reference only leaderboard geometry. They have no looping layout/tooltip animation, and the frame is four shallow, fully faced strips using a 16x16 solid texture (1 KiB). Version 1.0.8 restores the root bone and a positive-depth border instead of the single-sided zero-depth strips introduced in 1.0.7; it still uses just one renderer and no extra entities. Page atlas blank space is trimmed without resampling, and the unused full-size passive-page texture is replaced by a 4x4 swatch: decoded base-level page textures drop from 112 MiB to approximately 42.3 MiB (62% less). This is texture allocation arithmetic, not a measured FPS gain; mipmaps/other assets are additional.

As of 1.1.0, server updates run once per second without real leaderboard entities or audits. Online score reads are shared per objective; offline values come from the native cache. Rankings retain at most 15 entries and are rebuilt only when scores/names/objective labels change. Same-objective/size boards share packed text. Unchanged visible scores send no packets and trigger no glyph packing. With zero configured boards there are no leaderboard score reads, actor searches or rendering packets. Viewer range changes trigger spawn/removal packets rather than world-entity mutations. Automated tests check this behavior; they do not constitute a measured TPS/FPS benchmark.

Regression tests check single-quad renderer bindings, blank-glyph gating, atlas offsets for all glyphs/colour sheets, decoded texture size, bounded ranking against a full sort of 10,000 scores, no idle entity scans or text rebuilds, shared payloads and missing-layer repair. They do not measure Minecraft client FPS or server TPS. After updating, compare FPS while viewing the same leaderboard and watch for content-log errors.

## In-game smoke checklist

1. Restart with both packs; check server/client content logs for JSON, Molang or script errors.
2. Use the remote while looking forward. Confirm page text faces you and the circular cursor/hover matches the crosshair (test several facing directions and blank panel areas). Interact directly with the entity to select controls, including controls away from the panel centre.
3. Test Controls: toggles, disabled Advanced button, +/- amount, keypad save/cancel, rename, and confirmed reset.
4. Hover several occupied/empty inventory slots. Change inventory with ordinary gameplay and verify live counts/tooltips. Nothing should open a native screen or transfer items.
5. Click Toast; then `/title @s title Ordinary title` to verify vanilla titles remain normal.
6. Test off-panel use, item switch, walk-away, death, dimension switch and reconnect cleanup. Restart with an open panel to check orphan removal.
7. Test two players independently; verify actions affect only the owner's saved settings.
8. With an existing scored player objective, run `/lb create <objective> 15` as an operator. Verify transparent background, continuous border, correct names/scores and descending ranks. Change a score and check the display updates within a second. Try amounts 0 and 16 and an unknown objective: no display should spawn.
9. Check `/lb status` says ready after migration. Walk beyond 56 blocks: the client display should disappear, then return within 48. Change dimension, respawn and reconnect; verify one copy and no ghosts. Restart and verify saved placement. Remove/recreate its objective and confirm stale offline scores do not return. Compare `/lb status` counters before/after an unchanged board: packet/text-build counters should stay fixed.
10. Create two boards for the same objective. Run `/lb remove <first ID>` and verify only that board disappears, including its text; scores and the other board remain. Restart and confirm it does not reappear. Remove an unloaded board and return to its chunk to check late-loaded cleanup. Invalid IDs and non-operator requests must remove nothing.

## References

- [Stable Script API / custom components](https://learn.microsoft.com/en-us/minecraft/creator/documents/scripting/custom-components?view=minecraft-bedrock-stable)
- [Entity properties and the 32-property limit](https://learn.microsoft.com/en-us/minecraft/creator/documents/introductiontoentityproperties?view=minecraft-bedrock-stable)
- [Render controllers / UV animation](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/visualreference/render_controller.v1.8.0?view=minecraft-bedrock-stable)
- [Mojang's vanilla HUD factory and title controls](https://github.com/Mojang/bedrock-samples/blob/main/resource_pack/ui/hud_screen.json)
- [Mojang protocol 2193 AddActor wire layout](https://mojang.github.io/bedrock-protocol-docs/1.26.50/packets/add-actor-packet/)
- [Mojang SetActorData wire layout](https://mojang.github.io/bedrock-protocol-docs/1.26.50/packets/set-actor-data-packet/)
- [Endstone protocol definitions](https://github.com/EndstoneMC/bedrock-protocol)
