// Real entry point run by `bin/fileops.mjs` via tsx. Kept separate from
// src/adapters/cli.ts so importing that module (e.g. from tests) never
// triggers argv parsing as a side effect of module load.
import { main } from '../src/adapters/cli.js'

main()
