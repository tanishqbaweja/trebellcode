import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeEnvironment, normalizeApprovedEnvironmentKeys, runtimeEnvironmentKeys } from "../src/runtime-environment.mjs";

test("runtime environments keep OS essentials and only the selected runtime credentials",()=>{
  const parent={
    PATH:"/usr/bin",HOME:"/home/me",LANG:"en_US.UTF-8",
    ANTHROPIC_API_KEY:"claude-secret",OPENAI_API_KEY:"openai-secret",XAI_API_KEY:"xai-secret",
    GITHUB_TOKEN:"github-secret",AWS_SECRET_ACCESS_KEY:"aws-secret",TREBELL_INTERNAL_SECRET:"trebell-secret",
  };
  const claude=buildRuntimeEnvironment("claude",{parent,platform:"linux"});
  assert.equal(claude.PATH,"/usr/bin");assert.equal(claude.HOME,"/home/me");assert.equal(claude.ANTHROPIC_API_KEY,"claude-secret");
  assert.equal(claude.OPENAI_API_KEY,undefined);assert.equal(claude.XAI_API_KEY,undefined);assert.equal(claude.GITHUB_TOKEN,undefined);assert.equal(claude.AWS_SECRET_ACCESS_KEY,undefined);assert.equal(claude.TREBELL_INTERNAL_SECRET,undefined);
  const codex=buildRuntimeEnvironment("codex",{parent,platform:"linux"});assert.equal(codex.OPENAI_API_KEY,"openai-secret");assert.equal(codex.ANTHROPIC_API_KEY,undefined);
});

test("explicit inherited variable names expose values without persisting them in the profile",()=>{
  const parent={PATH:"/bin",AWS_SECRET_ACCESS_KEY:"approved-secret",TEAM_FEATURE_FLAG:"yes",UNRELATED_SECRET:"nope"};
  const approved=normalizeApprovedEnvironmentKeys(["AWS_SECRET_ACCESS_KEY","TEAM_FEATURE_FLAG","TEAM_FEATURE_FLAG","not-valid?"]);
  assert.deepEqual(approved,["AWS_SECRET_ACCESS_KEY","TEAM_FEATURE_FLAG"]);
  const env=buildRuntimeEnvironment("opencode",{parent,approved,overrides:{CUSTOM_MODE:"safe"},platform:"linux"});
  assert.equal(env.AWS_SECRET_ACCESS_KEY,"approved-secret");assert.equal(env.TEAM_FEATURE_FLAG,"yes");assert.equal(env.CUSTOM_MODE,"safe");assert.equal(env.UNRELATED_SECRET,undefined);
  assert.ok(runtimeEnvironmentKeys("opencode",{approved}).includes("AWS_SECRET_ACCESS_KEY"));
});

test("OpenCode receives supported upstream provider variables without inheriting unrelated credentials",()=>{
  const parent={PATH:"/bin",HF_TOKEN:"hf-value",NVIDIA_API_KEY:"nv-value",OPENAI_API_KEY:"oa-value",GEMINI_API_KEY:"gem-value",GITHUB_TOKEN:"github-value",CI_DEPLOY_TOKEN:"ci-value"};
  const env=buildRuntimeEnvironment("opencode",{parent,platform:"linux"});
  assert.equal(env.HF_TOKEN,"hf-value");assert.equal(env.NVIDIA_API_KEY,"nv-value");assert.equal(env.OPENAI_API_KEY,"oa-value");assert.equal(env.GEMINI_API_KEY,"gem-value");
  assert.equal(env.GITHUB_TOKEN,undefined);assert.equal(env.CI_DEPLOY_TOKEN,undefined);
});

test("Antigravity receives Google authentication inputs without inheriting unrelated secrets",()=>{
  const parent={PATH:"/bin",HOME:"/home/me",GOOGLE_API_KEY:"google-value",GOOGLE_CLOUD_PROJECT:"project-a",GOOGLE_APPLICATION_CREDENTIALS:"/home/me/adc.json",OPENAI_API_KEY:"other-provider",GITHUB_TOKEN:"unrelated"};
  const env=buildRuntimeEnvironment("antigravity",{parent,platform:"linux"});
  assert.equal(env.GOOGLE_API_KEY,"google-value");assert.equal(env.GOOGLE_CLOUD_PROJECT,"project-a");assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS,"/home/me/adc.json");
  assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.GITHUB_TOKEN,undefined);
});

test("Windows runtime environment lookup handles Path casing without copying unrelated variables",()=>{
  const env=buildRuntimeEnvironment("cursor",{parent:{Path:"C:\\Tools",USERPROFILE:"C:\\Users\\me",CURSOR_AUTH_TOKEN:"cursor-secret",RANDOM_TOKEN:"nope"},platform:"win32"});
  assert.equal(env.PATH,"C:\\Tools");assert.equal(env.USERPROFILE,"C:\\Users\\me");assert.equal(env.CURSOR_AUTH_TOKEN,"cursor-secret");assert.equal(env.RANDOM_TOKEN,undefined);
});

test("Antigravity inherits only its explicit Google auth lane plus the OS baseline",()=>{
  const env=buildRuntimeEnvironment("antigravity",{parent:{PATH:"/bin",GEMINI_HOME:"/tmp/gemini",GEMINI_API_KEY:"gem-value",GOOGLE_CLOUD_PROJECT:"project-value",OPENAI_API_KEY:"nope",GITHUB_TOKEN:"nope"},platform:"linux"});
  assert.equal(env.GEMINI_HOME,"/tmp/gemini");assert.equal(env.GEMINI_API_KEY,"gem-value");assert.equal(env.GOOGLE_CLOUD_PROJECT,"project-value");assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.GITHUB_TOKEN,undefined);
});

// The benchmark's Ruby images keep their gems under /usr/local/bundle (GEM_HOME, BUNDLE_*) and its Rust images keep rustup's
// toolchains under RUSTUP_HOME: a command Native runs without them cannot load an installed gem or pick a default toolchain.
test("Native's command environment keeps the toolchain variables a project's commands need and still drops credentials",()=>{
  const toolchain={
    GEM_HOME:"/usr/local/bundle",GEM_PATH:"/usr/local/bundle:/usr/local/lib/ruby/gems/3.3.0",BUNDLE_PATH:"/usr/local/bundle",BUNDLE_APP_CONFIG:"/usr/local/bundle",
    CARGO_HOME:"/usr/local/cargo",RUSTUP_HOME:"/usr/local/rustup",JAVA_HOME:"/opt/java/openjdk",GOPATH:"/go",VIRTUAL_ENV:"/opt/venv",
  };
  const secrets={
    OPENAI_API_KEY:"sk-fixture-openai",ANTHROPIC_API_KEY:"sk-ant-fixture",GITHUB_TOKEN:"ghp_fixture",AWS_SECRET_ACCESS_KEY:"fixture-aws-secret",
    CI_DEPLOY_TOKEN:"fixture-deploy-token",BUNDLE_GEMS__CONTRIBSYS__COM:"fixture-user:fixture-pass",NPM_CONFIG__AUTH:"fixture-npm-auth",
    CARGO_REGISTRIES_PRIVATE_TOKEN:"fixture-cargo-token",DATABASE_PASSWORD:"fixture-db-pass",APP_SECRET:"fixture-app-secret",COMPOSER_AUTH:"{\"github-oauth\":{}}",
    GOPROXY:"https://fixture-user:fixture-pass@proxy.example/go",PIP_INDEX_URL:"https://fixture-user:fixture-pass@pypi.example/simple",
  };
  const parent={PATH:"/usr/local/bundle/bin:/usr/local/cargo/bin:/usr/bin",HOME:"/root",...toolchain,...secrets};
  const env=buildRuntimeEnvironment("native",{parent,platform:"linux",toolchain:true});
  assert.equal(env.PATH,parent.PATH);assert.equal(env.HOME,"/root");
  for(const [name,value] of Object.entries(toolchain))assert.equal(env[name],value,name);
  for(const name of Object.keys(secrets))assert.equal(env[name],undefined,name);
  // Without the option the environment is the baseline alone, as Trebell's own git, diagnostics and transports keep it.
  const plain=buildRuntimeEnvironment("native",{parent,platform:"linux"});
  assert.equal(plain.PATH,parent.PATH);for(const name of Object.keys(toolchain))assert.equal(plain[name],undefined,name);
});

test("a toolchain variable whose value carries credentials is dropped while its plain values pass",()=>{
  const build=values=>buildRuntimeEnvironment("native",{parent:{PATH:"/bin",...values},platform:"linux",toolchain:true});
  assert.equal(build({RUSTUP_DIST_SERVER:"https://fixture-user:fixture-pass@mirror.example/rustup"}).RUSTUP_DIST_SERVER,undefined);
  assert.equal(build({RUSTUP_DIST_SERVER:"https://ghp_fixture@mirror.example/rustup"}).RUSTUP_DIST_SERVER,undefined,"a token as the URL's user is userinfo too");
  assert.equal(build({RUSTUP_DIST_SERVER:"https://mirror.example/rustup"}).RUSTUP_DIST_SERVER,"https://mirror.example/rustup");
  assert.equal(build({MAVEN_OPTS:"-Xmx2g -Dmaven.repo.remote=https://fixture-user:fixture-pass@repo.example/maven2"}).MAVEN_OPTS,undefined);
  assert.equal(build({MAVEN_OPTS:"-Xmx2g -Dhttps.proxyPassword=fixture-pass"}).MAVEN_OPTS,undefined);
  assert.equal(build({GRADLE_OPTS:"-Dorg.gradle.project.repoToken=fixture"}).GRADLE_OPTS,undefined);
  assert.equal(build({JAVA_TOOL_OPTIONS:"-Djavax.net.ssl.trustStorePassword=fixture"}).JAVA_TOOL_OPTIONS,undefined);
  assert.equal(build({MAVEN_OPTS:"-Xmx2g -Dmaven.repo.local=/opt/m2"}).MAVEN_OPTS,"-Xmx2g -Dmaven.repo.local=/opt/m2");
  assert.equal(build({NODE_OPTIONS:"--max-old-space-size=4096"}).NODE_OPTIONS,"--max-old-space-size=4096");
  assert.equal(build({RUSTFLAGS:"--cfg tokio_unstable"}).RUSTFLAGS,"--cfg tokio_unstable");
  // An @ that is not a URL's userinfo, as in a scoped package folder, is no credential.
  assert.equal(build({NODE_PATH:"/srv/node_modules/@scope"}).NODE_PATH,"/srv/node_modules/@scope");
  // A name the person approved explicitly passes as it is, as approved names always have.
  const approved=buildRuntimeEnvironment("native",{parent:{PATH:"/bin",MAVEN_OPTS:"-Dhttps.proxyPassword=fixture-pass"},approved:["MAVEN_OPTS"],platform:"linux",toolchain:true});
  assert.equal(approved.MAVEN_OPTS,"-Dhttps.proxyPassword=fixture-pass");
});

// JAVA_TOOL_OPTIONS, which every JVM prints as it starts ("Picked up JAVA_TOOL_OPTIONS: ..."), and the build tools' option strings
// can hold a credential in a documented form that no password= shows: the AWS SDK's -Daws.secretKey, New Relic's license_key,
// SonarQube's -Dsonar.login, an OpenTelemetry Authorization header, and an Oracle connect string's user/password@.
test("a JVM or build option string holding a credential in a documented form is dropped, and its plain settings pass",()=>{
  const build=values=>buildRuntimeEnvironment("native",{parent:{PATH:"/bin",...values},platform:"linux",toolchain:true});
  for(const [name,value] of [
    ["JAVA_TOOL_OPTIONS","-Daws.accessKeyId=AKIAFIXTURE -Daws.secretKey=fixture-secret"],
    ["JAVA_TOOL_OPTIONS","-Daws.secretAccessKey=fixture-secret"],
    ["MAVEN_OPTS","-Xmx2g -Dnewrelic.config.license_key=fixture-license"],
    ["GRADLE_OPTS","-Dsonar.login=fixture-token"],
    ["JAVA_OPTS","-Ddb.url=jdbc:oracle:thin:scott/tiger@//db.example:1521/svc"],
    ["MAVEN_ARGS","-Ddb=scott/tiger@orcl"],
    ["SBT_OPTS","-Dotel.exporter.otlp.headers=Authorization=Bearer fixture"],
  ])assert.equal(build({[name]:value})[name],undefined,value);
  for(const [name,value] of [
    ["JAVA_TOOL_OPTIONS","-XX:MaxRAMPercentage=75 -Dfile.encoding=UTF-8"],
    ["JAVA_OPTS","-Ddb.url=jdbc:oracle:thin:@//db.example:1521/svc"],
    ["MAVEN_OPTS","-Dmaven.repo.local=/root/.m2/repository -Djavax.net.ssl.trustStore=/etc/keys/cacerts"],
    // A path's folder before an @ is no user/password@: Homebrew's versioned formulae, Go's module cache.
    ["LDFLAGS","-L/opt/homebrew/opt/openssl@3/lib -Wl,-rpath,/opt/homebrew/opt/openssl@3/lib"],
    ["PKG_CONFIG_PATH","/opt/homebrew/opt/libffi/lib/pkgconfig:/opt/homebrew/opt/openssl@3/lib/pkgconfig"],
    ["CGO_CFLAGS","-I/go/pkg/mod/github.com/fixture/mod@v1.2.3/include"],
    ["NODE_OPTIONS","--max-old-space-size=4096 --require /srv/node_modules/@babel/register"],
    ["UV_PYTHON","cpython@3.12"],
  ])assert.equal(build({[name]:value})[name],value,value);
});

test("on Windows Native's commands find the toolchain variables whatever their case, and the places Windows toolchains look",()=>{
  const env=buildRuntimeEnvironment("native",{parent:{
    Path:"C:\\Tools",Java_Home:"C:\\jdk-21",GoPath:"C:\\Users\\me\\go",PROGRAMFILES:"C:\\Program Files","ProgramFiles(x86)":"C:\\Program Files (x86)",
    OS:"Windows_NT",PROCESSOR_ARCHITECTURE:"AMD64",GITHUB_TOKEN:"fixture",Random_Token:"fixture",
  },platform:"win32",toolchain:true});
  assert.equal(env.PATH,"C:\\Tools");assert.equal(env.JAVA_HOME,"C:\\jdk-21");assert.equal(env.GOPATH,"C:\\Users\\me\\go");
  assert.equal(env.ProgramFiles,"C:\\Program Files");assert.equal(env["ProgramFiles(x86)"],"C:\\Program Files (x86)");
  assert.equal(env.OS,"Windows_NT");assert.equal(env.PROCESSOR_ARCHITECTURE,"AMD64");assert.equal(env.GITHUB_TOKEN,undefined);assert.equal(env.RANDOM_TOKEN,undefined);assert.equal(env.Random_Token,undefined);
});
