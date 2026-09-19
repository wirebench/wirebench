#!/usr/bin/env node
import { main } from './main.js';

// exitCode rather than exit(): a report still being flushed to disk must finish.
process.exitCode = await main(process.argv.slice(2));
