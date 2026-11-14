#!/usr/bin/env node
// A stand-in for `rbxsync init`: creates its marker file and appends to .gitignore, never overwriting anything.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [folder, name] = process.argv.slice(2);
if (!existsSync(join(folder, 'fakesync.json'))) writeFileSync(join(folder, 'fakesync.json'), JSON.stringify({ name }));
mkdirSync(join(folder, 'src'), { recursive: true });
appendFileSync(join(folder, '.gitignore'), '\n# fake sync\n');
