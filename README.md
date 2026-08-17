# mc-heavy

mc-heavy is a from-scratch WebGPU-first voxel engine reimplementing the playable
core of `mc-lite`. Three.js is used only as the render adapter: world truth is
deterministic generation plus a sparse edit overlay, generation and meshing run
in versioned workers, and the render thread only submits bounded GPU uploads.

## Development

Install dependencies once:

```bash
npm install
npx playwright install chromium
```

Run the development server at `http://127.0.0.1:8080`:

```bash
npm run dev
```

Build (type-check plus production bundle):

```bash
npm run build
```

Run lint:

```bash
npm run lint
```

## Tests

Unit and worker integration tests:

```bash
npm run test:unit
```

Functional browser tests (headless Chromium, WebGL2 fallback accepted):

```bash
npm run test:e2e
```

## Performance acceptance

The real acceptance benchmark runs a fixed 300-second path at the default 8-chunk
radius on real Chrome WebGPU. The run starts from the default seed
`0x5eed1234`, walks four equal 75-second legs (east, south, west, north) at
4 blocks/s for 1,200 blocks, and crosses 256-block supercells, biome boundaries,
and deterministic structures.

```bash
npx playwright test tests/performance/playable-core.spec.ts --project=chrome
```

The command takes about five minutes. It writes a fresh JSON report to:

```text
artifacts/perf/playable-core.json
```

Acceptance contract (WebGPU only; a WebGL2 run is functional only and must never
be presented as the WebGPU number):

- `onePercentLowFps >= 90`
- `p99FrameMs <= 11.1`

Do not synthesize timestamps, weaken the workload, or lower the default 8-chunk
radius to pass. If the honest run misses the thresholds, investigate the HUD and
report the real numbers.
