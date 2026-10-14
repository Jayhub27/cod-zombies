# ZOMBIES — a Call of Duty Zombies fan remake

Two builds of the same game:

| Build | Path | Stack |
| --- | --- | --- |
| **3D (first person)** | [`/3d/`](3d/) | three.js, vendored locally in `3d/vendor/` |
| 2D (top down) | [`/`](index.html) | canvas 2D |

Both share the map layout, navigation, weapon data and the synthesized WebAudio SFX.
No build step. **Fan tribute. Not affiliated with Activision.**

## Run it

```bash
# any static server works
python3 -m http.server 8777 --directory .
# then open http://localhost:8777 (2D) or http://localhost:8777/3d/ (3D)
```

## Controls (3D build)

| Input | Action |
| --- | --- |
| `WASD` | Move · `Shift` sprint (FOV kick) |
| Mouse | Look — click captures the pointer; if capture is blocked (embedded browsers), **drag to look or use the arrow keys** |
| `RMB` | Aim down sights · Left click shoot (first shot accurate, spread blooms) |
| `R` | Reload · `G` grenade · `V` knife |
| `1` `2` `Q` / wheel | Swap weapon |
| `F` (hold) | Buy / interact |
| `Esc` pause · `M` mute · `F2` quality | Pause menu has sensitivity / FOV / screen-shake sliders (saved locally) |

## Feel & AI notes (3D build)

- **Aim:** hitscan with range falloff, ×2 headshot multiplier, recoil kick + horizontal sway,
  bloom spread (recovers fast) — first shot goes where the crosshair is. **RMB aims down sights**
  (zooms FOV, tightens spread, slows movement, centres the weapon).
- **Impact:** hit-stop on kills (shorter on body shots), trauma-based screen shake (trauma²,
  sin-noise — no per-frame jitter), zombie flinch + squash on hit, blood decals, bullet holes.
- **Enemies:** BFS pathfinding + arrive steering (they slow instead of shoving), **surround
  behaviour** (each zombie picks the least crowded approach sector), stuck-detection sidestep,
  board-chewing window entries, sprinters — now built from capsule limbs with jointed elbows
  and knees, sunken eye sockets and a jaw.
- **Audio:** footsteps, low-health heartbeat, distance-scaled growls, and a **procedural room
  reverb** (dark noise impulse) so gunshots echo through the bunker. All synthesized, no assets.

## Realism / rendering (3D build)

- **Post-processing chain:** SSAO (contact shadows), UnrealBloom (flashlight + muzzle + machine
  glow), ACES film output, FXAA, and a final film grade — subtle chromatic aberration, vignette,
  animated grain, filmic black lift.
- **Lighting:** image-based lighting (PMREM room environment) for grounded PBR ambient and
  reflections, shadow-casting flashlight, fog, glowing props and power-ups.
- **Materials:** procedural normal maps + roughness maps for floor, concrete, wood and cloth
  (all generated in canvas at load — still zero external assets).
- **Atmosphere:** volumetric flashlight beam and drifting dust motes; blood pools have a wet
  sheen from the IBL.
- **Perf:** `F2` cycles **high / medium / low**; the game auto-drops a level if frames run slow.

## The loop

- **Survive rounds.** Each round spawns more, tougher, faster zombies (sprinters appear after round 6).
- **Points:** 10 per bullet hit, 50 per kill, 100 per headshot kill, 130 per knife kill, 10 per window board.
- **Buy your way out:** doors (750 / 1000 / 1250 / 1750), wall weapons (M1911, MP40, Trench Gun, M14),
  the Mystery Box (950, includes wonder weapons and a teddy bear), Pack-a-Punch (4000).
- **Perks:** Quick Revive (500, one self-revive + faster regen), Juggernog (2500),
  Double Tap (2000), Speed Cola (3000).
- **Power-ups** drop from dead zombies: Max Ammo, Insta-Kill, Double Points, Nuke, Carpenter.
- **Repair windows** for points; zombies chew through the boards when they climb in — shoot them while they climb.
- Classic rules: you go down when your health runs out; no Quick Revive, no second chance.

## Code map

```
index.html       2D build page + overlays          3d/index.html   3D build page + overlays
style.css        2D menu styling                   3d/style.css    3D menu styling
js/utils.js       math + geometry helpers          3d/game3d.js    three.js engine: FPS controller, world
js/audio.js       synthesized SFX engine           3d/vendor/      vendored three.js module build
js/map.js         bunker layout + BFS navigation
js/weapons.js     weapon stats, PaP math, power-ups, round scaling
js/game.js        2D engine: entities, rounds, economy, rendering
```

Both pages expose `window.__zombiesDebug` with the game state and helpers
(`look`, `teleport`, `spawnZombie`, `grantWeapon`, …) for debugging from the console.
The 3D build also has `__zombiesDebug.perf(true)` to drop shadows/pixel ratio on weak GPUs.

## Notes

- Desktop recommended (keyboard + mouse). The 3D build wants WebGL2 — any GPU from the last decade is fine.
- Headshot hitboxes are real: aim for the head.
- Best round is stored in `localStorage` (separate for each build).
