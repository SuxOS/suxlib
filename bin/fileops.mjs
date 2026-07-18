#!/usr/bin/env node
// suxlib is source-distributed TS (no build/dist step — see package.json's
// "exports" map, which points straight at src/**/*.ts). Running the CLI
// adapter as a real executable therefore needs a TS-aware runtime; this shim
// shells out to `tsx` (a devDependency here, and commonly available via
// `npx` even for consumers who only depend on the package) rather than
// requiring every consumer to pre-compile suxlib themselves.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entryPath = fileURLToPath(new URL('./fileops-entry.ts', import.meta.url))
const result = spawnSync('npx', ['--yes', 'tsx', entryPath, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
