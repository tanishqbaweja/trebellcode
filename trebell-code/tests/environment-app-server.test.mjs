import test from "node:test";
import assert from "node:assert/strict";
import { remoteCodexArgs, remoteCodexProfileSetup, sshRemotePorts } from "../src/environment-app-server.mjs";
import { remoteToolPathPrelude } from "../src/environment-manager.mjs";

test("remote harness PATH bootstrap covers Linuxbrew and common Node version managers",()=>{
  const script=remoteToolPathPrelude();
  assert.match(script,/\/home\/linuxbrew\/\.linuxbrew\/bin/);
  assert.match(script,/VOLTA_HOME/);
  assert.match(script,/\.asdf\/shims/);
  assert.match(script,/\.local\/share\/mise\/shims/);
  assert.match(script,/\.nodenv\/shims/);
  assert.match(script,/\.nvm\/versions\/node/);
  assert.match(script,/export PATH/);
});

test("remote Codex app-server receives Trebell provider overrides before the subcommand",()=>{
  const args=remoteCodexArgs({
    provider:"vyceai",
    baseUrl:"http://172.20.0.1:32123/v1",
    listen:"ws://0.0.0.0:23456",
  });
  const appIndex=args.indexOf("app-server");
  assert.ok(appIndex>0);
  assert.equal(args[appIndex+1],"--listen");
  assert.equal(args[appIndex+2],"ws://0.0.0.0:23456");
  const joined=args.slice(0,appIndex).join("\n");
  assert.match(joined,/model_provider="vyceai"/);
  assert.match(joined,/model_providers\.vyceai\.base_url="http:\/\/172\.20\.0\.1:32123\/v1"/);
  assert.match(joined,/wire_api="responses"/);
  assert.match(joined,/requires_openai_auth=false/);
});

test("remote Freebuff session can point at a tunneled local bridge",()=>{
  const args=remoteCodexArgs({
    provider:"freebuff",
    baseUrl:"http://127.0.0.1:23335/v1",
    listen:"ws://127.0.0.1:23456",
  });
  assert.ok(args.includes('model_provider="freebuff"'));
  assert.ok(args.includes('model_providers.freebuff.base_url="http://127.0.0.1:23335/v1"'));
});

test("remote Codex profiles honor custom binaries, homes, overlays and environment",()=>{
  const direct=remoteCodexProfileSetup({
    profile:{codexPath:"codex-default"},
    runtimeInstance:{binaryPath:"/opt/codex/bin/codex",homePath:"~/.codex-shared",environment:{TREBELL_FIXTURE:"yes"}},
  });
  assert.equal(direct.command,"/opt/codex/bin/codex");
  assert.match(direct.prelude,/export TREBELL_FIXTURE='yes'/);
  assert.match(direct.prelude,/export CODEX_HOME/);
  assert.match(direct.prelude,/\.codex-shared/);

  const overlay=remoteCodexProfileSetup({
    profile:{},
    runtimeInstance:{homePath:"~/.codex-shared",shadowHomePath:"~/.codex-work"},
  });
  assert.match(overlay.prelude,/trebell_codex_shared/);
  assert.match(overlay.prelude,/sessions/);
  assert.match(overlay.prelude,/ln -s/);
  assert.match(overlay.prelude,/\.codex-work/);
});

test("SSH remote Codex servers derive distinct app and provider tunnel ports",()=>{
  const first=sshRemotePorts(23456),second=sshRemotePorts(23457);
  assert.notEqual(first.appPort,first.providerPort);
  assert.notDeepEqual(first,second);
  for(const port of [first.appPort,first.providerPort,second.appPort,second.providerPort])assert.ok(port>1024&&port<65536);
});
