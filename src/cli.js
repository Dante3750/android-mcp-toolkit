#!/usr/bin/env node
// Entry point for `npx android-mcp-toolkit`: no args starts the MCP server over stdio.
import { readFileSync } from 'node:fs';

const [cmd, ...rest] = process.argv.slice(2);
const version = () => JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const HELP = `android-mcp-toolkit ${version()}
MCP server giving AI agents compact access to Gradle, logcat and adb.

Usage:
  npx -y github:Dante3750/android-mcp-toolkit            start the MCP server (stdio)
  ... init [--write] [--client=claude|cursor|vscode|windsurf] [--global] [--force]
                                                          print (or merge) MCP config for your editor
  ... doctor                                              check node, adb, devices, gradlew, java
  ... --version | --help
`;

if (cmd === '--version' || cmd === '-v' || cmd === 'version') console.log(version());
else if (cmd === '--help' || cmd === '-h' || cmd === 'help') console.log(HELP);
else if (cmd === 'init') process.exitCode = (await import('./init.js')).runInit(rest);
else if (cmd === 'doctor') process.exitCode = await (await import('./doctor.js')).runDoctor();
else if (cmd) { console.error(`Unknown command "${cmd}".\n\n${HELP}`); process.exitCode = 2; }
else await (await import('./server.js')).startServer();
