#!/usr/bin/env node
import { run } from './main.ts';

process.exitCode = await run(process.argv.slice(2));
