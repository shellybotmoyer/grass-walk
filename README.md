# grass-walk

Vibe-coded Three.js scene: a grassy field you can walk around in, with physics, VRM character support, fireflies, day/night cycle, and fireballs.

## Tech Stack

- **Renderer:** Three.js 0.183 + crashcat physics
- **VRM:** @pixiv/three-vrm (character avatars)
- **Build:** Vite + Bun
- **Language:** TypeScript

## Scripts

```bash
bun install        # install deps
bun run dev        # dev server
bun run build      # production build
bun run preview    # preview build
```

## What's in it

| System | File | Description |
|--------|------|-------------|
| Grass | `src/grass.ts` | Instanced grass blades with wind sway |
| Flora | `src/flora.ts` | Flowers and small plants scattered across the field |
| Trees | `src/trees.ts` | Low-poly trees with trunks and canopy |
| Character | `src/character.ts` | VRM character with WASD/mouse input |
| Fireflies | `src/particles.ts` | Glowing particle swarm at night |
| Fireballs | `src/fireballs.ts` | Launchable fireballs with physics |
| Day/Night | `src/daynight.ts` | Ambient + directional light cycling |
| Sky | `src/sky.ts` | Procedural sky with sun/moon positioning |
| Input | `src/input.ts` | Keyboard (WASD) + mouse look |
| Camera | `src/thirdPersonCamera.ts` | Smooth third-person follow |
| Terrain | `src/terrain.ts` | Heightmap mesh + static physics body |
