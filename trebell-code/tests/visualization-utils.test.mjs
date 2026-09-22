import test from "node:test";
import assert from "node:assert/strict";
import { parseVisualizationMessage, visualizationUrl } from "../ui/src/visualization-utils.js";

test("visualization parser extracts modern Codex inline directives",()=>{
  const parsed=parseVisualizationMessage('Here is the chart.\n::codex-inline-vis{file="latency.html" mode="wide"}');
  assert.equal(parsed.text,"Here is the chart.");
  assert.deepEqual(parsed.visualizations,[{file:"latency.html",mode:"wide"}]);
  const url=visualizationUrl(parsed.visualizations[0],{projectPath:"/srv/app",environmentId:"ssh-1",threadId:"thread-1"});
  const params=new URL("http://trebell.invalid"+url).searchParams;
  assert.equal(params.get("file"),"latency.html");assert.equal(params.get("root"),"/srv/app");assert.equal(params.get("environmentId"),"ssh-1");assert.equal(params.get("threadId"),"thread-1");
});

test("visualization parser extracts legacy content references and ignores unsafe extensions",()=>{
  const marker="\uFFFDvisualize\uFFFD"+JSON.stringify({path:"/tmp/report.html",mode:"wide"})+"\uFFFD";
  const parsed=parseVisualizationMessage("Before\n"+marker+"\nAfter");
  assert.equal(parsed.text,"Before\n\nAfter");
  assert.deepEqual(parsed.visualizations,[{path:"/tmp/report.html",mode:"wide"}]);
  const unsafe=parseVisualizationMessage('::codex-inline-vis{file="secrets.txt"}');
  assert.equal(unsafe.visualizations.length,0);
  assert.match(unsafe.text,/codex-inline-vis/);
});
