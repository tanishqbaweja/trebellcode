// Host-side download cache for benchmark verifiers. A Terminal-Bench 2.0 verifier installs its test tools at grade time: uv from
// GitHub releases, Python from python-build-standalone releases, pytest and the task's test libraries from PyPI. From inside the
// Docker VM those downloads are slow, and GitHub's release CDN resets them partway, so a lane's tests can fail to run at all. This
// server fetches each file once on the host, resuming across resets, and streams it to every verifier from the cache:
//   GET /gh/<owner>/<repo>/releases/download/<tag>/<file>   <- https://github.com/<owner>/<repo>/releases/download/<tag>/<file>
//   GET /pypi/simple/<project>/                             <- https://pypi.org/simple/<project>/, file links pointed at /pypi/files/
//   GET /pypi/files/<path>                                  <- https://files.pythonhosted.org/<path>
// Files are byte-identical copies: uv's installer checks its own checksum, and uv and pip check the index's sha256. The launcher
// points only the verifier at it (verifierDownloadCacheArgs in terminal-bench-task-cache.mjs), so agents never see it.
// Index pages are kept too (serveIndex below), since PyPI's stall partway from this host.
// Usage: node scripts/verifier-download-cache.mjs [--port=18090] [--root=<cache dir>] [--minutes=1440]
import http from "node:http";
import https from "node:https";
import { appendFileSync, closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

export function upstreamFor(pathname){
  const gh=pathname.match(/^\/gh\/([\w.-]+)\/([\w.-]+)\/releases\/download\/([\w.%+-]+)\/([\w.%+-]+)$/);
  if(gh)return {kind:"file",url:`https://github.com/${gh[1]}/${gh[2]}/releases/download/${gh[3]}/${gh[4]}`,cachePath:pathname.slice(1)};
  const simple=pathname.match(/^\/pypi\/simple\/([\w.-]+)\/?$/);
  if(simple)return {kind:"index",url:`https://pypi.org/simple/${simple[1].toLowerCase()}/`};
  const file=pathname.match(/^\/pypi\/files\/(packages(?:\/[\w.%+-]+)+)$/);
  if(file&&!file[1].split("/").some(part=>part===".."||part==="."))return {kind:"file",url:`https://files.pythonhosted.org/${file[1]}`,cachePath:pathname.slice(1)};
  return null;
}

// Points an index page's file links (PEP 503 HTML or PEP 691 JSON; PEP 658 metadata sits next to each file) at this cache.
export function rewriteIndex(body,base){
  return body.split("https://files.pythonhosted.org/").join(`${base}/pypi/files/`);
}

function get(url,headers={},redirects=8){
  return new Promise((done,fail)=>{
    const request=https.get(url,{headers:{"user-agent":"trebell-verifier-download-cache/1",...headers},timeout:60_000},response=>{
      if([301,302,303,307,308].includes(response.statusCode)&&response.headers.location&&redirects>0){
        response.resume();
        get(new URL(response.headers.location,url).href,headers,redirects-1).then(done,fail);
      }else done(response);
    });
    request.on("timeout",()=>request.destroy(new Error("upstream idle for 60 s")));
    request.on("error",fail);
  });
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

export function decodeBody(body,encoding){
  const coding=String(encoding||"").trim().toLowerCase();
  if(coding==="gzip"||coding==="x-gzip")return gunzipSync(body);
  if(coding==="deflate")return inflateSync(body);
  if(coding==="br")return brotliDecompressSync(body);
  return body;
}
// One index page from PyPI, asked for gzip (a quarter of the bytes), tried three times when the transfer breaks off.
async function fetchIndexUpstream(url,accept){
  for(let attempt=1;;attempt++){
    try{
      const response=await get(url,{accept,"accept-encoding":"gzip"}),chunks=[];
      for await(const chunk of response)chunks.push(chunk);
      if(response.statusCode!==200)return {status:response.statusCode};
      return {status:200,contentType:response.headers["content-type"]||"text/html",body:decodeBody(Buffer.concat(chunks),response.headers["content-encoding"]).toString("utf8")};
    }catch(error){if(attempt>=3)throw error;await sleep(1_000*attempt);}
  }
}

// fetchIndex, now, freshMs and deadlineMs are for the tests; the server uses the defaults.
export function createCache({root,log=()=>{},maxAttempts=12,fetchIndex=fetchIndexUpstream,now=Date.now,freshMs=6*3_600_000,deadlineMs=20_000}){
  const base=resolve(root),inflight=new Map(),indexInflight=new Map();
  const pathOf=cachePath=>{const file=resolve(base,cachePath);if(!file.startsWith(base+sep))throw new Error("path escapes the cache root");return file;};
  // Downloads url to <file>.part with positional writes, resuming with a Range request after each reset, then renames it.
  function fetchToCache(url,file){
    if(existsSync(file))return null;
    if(inflight.has(file))return inflight.get(file);
    const state={part:file+".part",total:null,written:0,finished:false,error:null,notFound:false};
    state.done=(async()=>{
      mkdirSync(dirname(file),{recursive:true});
      const fd=openSync(state.part,"w");
      try{
        for(let attempt=1;;attempt++){
          let response;
          try{response=await get(url,state.written?{range:`bytes=${state.written}-`}:{});}
          catch(error){if(attempt>=maxAttempts)throw error;log(`retry ${attempt} ${url}: ${error.message} at ${state.written} B`);await sleep(Math.min(30_000,2_000*attempt));continue;}
          if(response.statusCode===404){response.resume();state.notFound=true;throw new Error(`${url}: HTTP 404`);}
          const resumed=response.statusCode===206,fresh=response.statusCode===200&&!state.written;
          if(!resumed&&!fresh){response.resume();if(attempt>=maxAttempts)throw new Error(`${url}: HTTP ${response.statusCode}`);log(`retry ${attempt} ${url}: HTTP ${response.statusCode} at ${state.written} B`);await sleep(Math.min(30_000,2_000*attempt));continue;}
          const range=response.headers["content-range"]?.match(/\/(\d+)$/);
          state.total=range?Number(range[1]):Number(response.headers["content-length"])||null;
          const complete=await new Promise(settle=>{
            response.on("data",chunk=>{writeSync(fd,chunk,0,chunk.length,state.written);state.written+=chunk.length;});
            response.on("end",()=>settle(state.total==null||state.written>=state.total));
            response.on("error",()=>settle(false));response.on("aborted",()=>settle(false));
          });
          if(complete)break;
          if(attempt>=maxAttempts)throw new Error(`${url}: reset ${attempt} times, ${state.written} of ${state.total} B`);
          log(`resume ${url} at ${state.written} of ${state.total} B (attempt ${attempt})`);
        }
      }finally{closeSync(fd);}
      renameSync(state.part,file);
      log(`cached ${url} (${state.written} B)`);
    })().then(()=>{state.finished=true;inflight.delete(file);},error=>{state.error=error;state.finished=true;inflight.delete(file);log(`failed ${url}: ${error.message}`);});
    inflight.set(file,state);
    return state;
  }
  const write=(res,chunk)=>new Promise(done=>{if(res.destroyed)return done(false);if(res.write(chunk))return done(true);const go=()=>{res.off("close",stop);done(true);},stop=()=>{res.off("drain",go);done(false);};res.once("drain",go);res.once("close",stop);});
  // Sends the file, following the .part file while its download runs, so a verifier gets bytes at once rather than waiting.
  async function serveFile(url,cachePath,res){
    const file=pathOf(cachePath),state=fetchToCache(url,file);
    if(!state){res.writeHead(200,{"content-length":statSync(file).size,"content-type":"application/octet-stream"});createReadStream(file).pipe(res);return;}
    for(let waited=0;state.total==null&&!state.finished&&waited<120_000;waited+=200)await sleep(200);
    if(state.error){res.writeHead(state.notFound?404:502);res.end();return;}
    res.writeHead(200,{...(state.total?{"content-length":state.total}:{}),"content-type":"application/octet-stream"});
    const buffer=Buffer.alloc(1<<20);
    for(let sent=0;;){
      const finished=state.finished,source=existsSync(file)?file:state.part;
      let read=0;
      try{const fd=openSync(source,"r");try{read=readSync(fd,buffer,0,buffer.length,sent);}finally{closeSync(fd);}}catch{}
      if(read>0){sent+=read;if(!await write(res,buffer.subarray(0,read)))return;continue;}
      if(finished){if(state.error)res.destroy(state.error);else res.end();return;}
      if(res.destroyed)return;
      await sleep(200);
    }
  }
  // PyPI's index pages run to a few MB and, from this host, stall partway: on 2026-10-20 modal's, numpy's and xxhash's took over
  // the 30 s uv waits, so every SWE-bench parser installing through this cache failed and its lane went ungraded. Each page is
  // kept on disk, one copy for the JSON form uv and pip ask for and one for HTML. A copy younger than freshMs is served without
  // asking PyPI; an older one is served when PyPI has not answered within deadlineMs or fails. Requests for the same page share
  // one fetch. The parsers and test tools pin their packages, so a page some hours old resolves the same.
  async function serveIndex(target,req,res){
    const accept=req.headers.accept||"text/html",form=/application\/vnd\.pypi\.simple\.v1\+json/i.test(accept)?"json":"html";
    const file=pathOf(`pypi-index/index-${target.url.match(/\/simple\/([^/]+)\/$/)[1]}.${form}.json`);
    let copy=null;
    try{copy=JSON.parse(readFileSync(file,"utf8"));}catch{}
    const send=page=>{res.writeHead(200,{"content-type":page.contentType});res.end(rewriteIndex(page.body,`http://${req.headers.host}`));};
    if(copy&&now()-copy.fetchedAt<freshMs){send(copy);return;}
    let pending=indexInflight.get(file);
    if(!pending){
      pending=Promise.resolve().then(()=>fetchIndex(target.url,accept)).then(page=>{
        if(page.status===200){
          try{mkdirSync(dirname(file),{recursive:true});writeFileSync(file+".part",JSON.stringify({url:target.url,contentType:page.contentType,fetchedAt:now(),body:page.body}));renameSync(file+".part",file);}
          catch(error){log(`could not keep ${target.url}: ${error.message}`);}
        }
        return page;
      }).finally(()=>indexInflight.delete(file));
      indexInflight.set(file,pending);
    }
    const settled=pending.then(page=>({page}),error=>({error}));
    const outcome=copy?await Promise.race([settled,sleep(deadlineMs).then(()=>({late:true}))]):await settled;
    if(outcome.page?.status===200){send(outcome.page);return;}
    if(copy&&(outcome.late||outcome.error||outcome.page.status>=500)){
      log(`stale ${target.url}: ${outcome.late?`no answer within ${deadlineMs/1000} s`:outcome.error?outcome.error.message:`HTTP ${outcome.page.status}`}; served the copy of ${new Date(copy.fetchedAt).toISOString()}`);
      send(copy);return;
    }
    if(outcome.error)throw outcome.error;
    res.writeHead(outcome.page.status);res.end();
  }
  async function handle(req,res){
    const pathname=new URL(req.url,"http://cache").pathname;
    if(req.method==="GET"&&pathname==="/health"){res.writeHead(200,{"content-type":"text/plain"});res.end(`ok ${inflight.size} in flight\n`);return;}
    const target=req.method==="GET"?upstreamFor(pathname):null;
    if(!target){res.writeHead(404);res.end();return;}
    if(target.kind==="index"){await serveIndex(target,req,res);return;}
    await serveFile(target.url,target.cachePath,res);
  }
  return {handle};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const arg=name=>process.argv.find(a=>a.startsWith(`--${name}=`))?.slice(name.length+3);
  const port=Number(arg("port")||18090),root=resolve(arg("root")||"H:/TrebellCache/verifier-downloads"),minutes=Number(arg("minutes")||1440);
  mkdirSync(root,{recursive:true});
  const logFile=join(root,"cache.log"),log=line=>appendFileSync(logFile,`${new Date().toISOString()} ${line}\n`);
  const cache=createCache({root,log});
  const server=http.createServer((req,res)=>{cache.handle(req,res).catch(error=>{log(`error ${req.url}: ${error.message}`);if(!res.headersSent){res.writeHead(502);res.end();}else res.destroy();});});
  server.on("request",req=>log(`${req.method} ${req.url}`));
  server.listen(port,"127.0.0.1",()=>log(`listening on 127.0.0.1:${port}, root ${root}, exits after ${minutes} min`));
  setTimeout(()=>{log("time limit reached; exiting");process.exit(0);},minutes*60_000).unref();
}
