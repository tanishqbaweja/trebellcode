import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeEnvironment, carriesCredentials, normalizeApprovedEnvironmentKeys, runtimeEnvironmentKeys, TOOLCHAIN_ENVIRONMENT_KEYS } from "../src/runtime-environment.mjs";

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
  assert.equal(build({RUSTUP_UPDATE_ROOT:"https://fixture-user:fixture-pass@mirror.example/rustup/rustup"}).RUSTUP_UPDATE_ROOT,undefined);
  assert.equal(build({GOFLAGS:"-ldflags=-X=main.apiToken=fixture"}).GOFLAGS,undefined);
  assert.equal(build({CFLAGS:"-O2 -DSENTRY_AUTH_TOKEN=fixture"}).CFLAGS,undefined);
  assert.equal(build({CGO_CFLAGS:"-DDB_PASSWORD=fixture-pass"}).CGO_CFLAGS,undefined);
  assert.equal(build({GOFLAGS:"-mod=mod -modcacherw"}).GOFLAGS,"-mod=mod -modcacherw");
  assert.equal(build({CFLAGS:"-O2 -DNDEBUG=1"}).CFLAGS,"-O2 -DNDEBUG=1");
  assert.equal(build({NODE_OPTIONS:"--max-old-space-size=4096"}).NODE_OPTIONS,"--max-old-space-size=4096");
  assert.equal(build({RUSTFLAGS:"--cfg tokio_unstable"}).RUSTFLAGS,"--cfg tokio_unstable");
  // An @ that is not a URL's userinfo, as in a scoped package folder, is no credential.
  assert.equal(build({NODE_PATH:"/srv/node_modules/@scope"}).NODE_PATH,"/srv/node_modules/@scope");
  // A name the person approved explicitly passes as it is, as approved names always have.
  const approved=buildRuntimeEnvironment("native",{parent:{PATH:"/bin",MAVEN_OPTS:"-Dhttps.proxyPassword=fixture-pass"},approved:["MAVEN_OPTS"],platform:"linux",toolchain:true});
  assert.equal(approved.MAVEN_OPTS,"-Dhttps.proxyPassword=fixture-pass");
});

// A credential can be held in a documented form that no password= shows: the AWS SDK's -Daws.secretKey, New Relic's license_key,
// SonarQube's -Dsonar.login, an OpenTelemetry Authorization header, and an Oracle connect string's user/password@. The check tells
// these from plain settings, paths and package specs, for a toolchain value here and a remote host's (environment-manager.mjs).
test("a value holding a credential in a documented form is told from plain settings, and plain toolchain values pass",()=>{
  const build=values=>buildRuntimeEnvironment("native",{parent:{PATH:"/bin",...values},platform:"linux",toolchain:true});
  for(const value of [
    "-Daws.accessKeyId=AKIAFIXTURE -Daws.secretKey=fixture-secret",
    "-Daws.secretAccessKey=fixture-secret",
    "-Xmx2g -Dnewrelic.config.license_key=fixture-license",
    "-Dsonar.login=fixture-token",
    "-Ddb.url=jdbc:oracle:thin:scott/tiger@//db.example:1521/svc",
    "-Ddb=scott/tiger@orcl",
    "-Dotel.exporter.otlp.headers=Authorization=Bearer fixture",
  ])assert.equal(carriesCredentials(value),true,value);
  for(const value of [
    "-XX:MaxRAMPercentage=75 -Dfile.encoding=UTF-8",
    "-Ddb.url=jdbc:oracle:thin:@//db.example:1521/svc",
    "-Dmaven.repo.local=/root/.m2/repository -Djavax.net.ssl.trustStore=/etc/keys/cacerts",
  ])assert.equal(carriesCredentials(value),false,value);
  for(const [name,value] of [
    // A path's folder before an @ is no user/password@: Homebrew's versioned formulae, Go's module cache.
    ["LDFLAGS","-L/opt/homebrew/opt/openssl@3/lib -Wl,-rpath,/opt/homebrew/opt/openssl@3/lib"],
    ["PKG_CONFIG_PATH","/opt/homebrew/opt/libffi/lib/pkgconfig:/opt/homebrew/opt/openssl@3/lib/pkgconfig"],
    ["CGO_CFLAGS","-I/go/pkg/mod/github.com/fixture/mod@v1.2.3/include"],
    ["NODE_OPTIONS","--max-old-space-size=4096 --require /srv/node_modules/@babel/register"],
    ["UV_PYTHON","cpython@3.12"],
  ])assert.equal(build({[name]:value})[name],value,value);
});

// JAVA_TOOL_OPTIONS (which every JVM prints as it starts), JAVA_OPTS, MAVEN_OPTS, MAVEN_ARGS, GRADLE_OPTS and SBT_OPTS can hold a
// credential in a form its vendor documents that no check of names and shapes tells from a plain option: Honeycomb's
// -Dotel.exporter.otlp.headers=x-honeycomb-team=<key>, an Azure SAS's sig=, a user:password@host with no scheme. Native's commands
// never get them, holding one or not; the JDK's, Maven's and Gradle's homes and the other toolchain variables still pass.
const JVM_OPTION_STRINGS=["JAVA_TOOL_OPTIONS","JAVA_OPTS","MAVEN_OPTS","MAVEN_ARGS","GRADLE_OPTS","SBT_OPTS"];
test("Native's commands never get the JVM's or the build tools' option strings, and the other toolchain variables pass",()=>{
  for(const name of JVM_OPTION_STRINGS)assert.equal(TOOLCHAIN_ENVIRONMENT_KEYS.includes(name),false,name);
  const toolchain={JAVA_HOME:"/opt/java/openjdk",MAVEN_HOME:"/usr/share/maven",GRADLE_USER_HOME:"/root/.gradle",GEM_HOME:"/usr/local/bundle",RUSTFLAGS:"--cfg tokio_unstable"};
  const credentials={
    JAVA_TOOL_OPTIONS:"-javaagent:/otel/opentelemetry-javaagent.jar -Dotel.exporter.otlp.headers=x-honeycomb-team=hcaik_fixture",
    JAVA_OPTS:"-Dspring.cloud.azure.storage.blob.connection-string=BlobEndpoint=https://acct.blob.core.windows.net/;SharedAccessSignature=sv=2022-11-02&ss=b&sp=rl&sig=fixture",
    MAVEN_OPTS:"-Dapp.blob.url=https://acct.blob.core.windows.net/c?sv=2022-11-02&sp=r&sig=fixture",
    MAVEN_ARGS:"-Ddsn=app:fixture-pass@tcp(db:3306)/app",
    GRADLE_OPTS:"-Dproxy=bob:fixture-pass@proxy.example:8080",
    SBT_OPTS:"-Daws.secretKey=fixture-secret",
  };
  const harmless={
    JAVA_TOOL_OPTIONS:"-XX:MaxRAMPercentage=75 -Dfile.encoding=UTF-8",JAVA_OPTS:"-Xmx2g",MAVEN_OPTS:"-Dmaven.repo.local=/root/.m2/repository",
    MAVEN_ARGS:"-o -B",GRADLE_OPTS:"-Dorg.gradle.daemon=false",SBT_OPTS:"-Xss4m",
  };
  for(const options of [credentials,harmless]){
    const env=buildRuntimeEnvironment("native",{parent:{PATH:"/bin",...toolchain,...options},platform:"linux",toolchain:true});
    for(const name of JVM_OPTION_STRINGS)assert.equal(env[name],undefined,name+"="+options[name]);
    for(const [name,value] of Object.entries(toolchain))assert.equal(env[name],value,name);
  }
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
