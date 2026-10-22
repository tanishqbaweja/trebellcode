#!/usr/bin/env node
// A `claude` CLI that answers Trebell's harness check as an installed, signed-in Claude Code 2.1 does (`claude --version`, `claude auth
// status`), and exits with an error on any other launch (the Agent SDK's query), so nothing reaches a model.
const args=process.argv.slice(2);
if(args[0]==="--version"){process.stdout.write("2.1.0 (Claude Code)\n");process.exit(0)}
if(args[0]==="auth"&&args[1]==="status"){process.stdout.write(JSON.stringify({loggedIn:true,authMethod:"fixture"})+"\n");process.exit(0)}
process.stderr.write("fake claude: no session is served here\n");process.exit(1);
