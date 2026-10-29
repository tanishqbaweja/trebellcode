import { isSecretEnvironmentName } from "./secret-redactor.mjs";

const BASELINE_KEYS=Object.freeze([
  "PATH","PATHEXT","SystemRoot","WINDIR","COMSPEC","TEMP","TMP","TMPDIR",
  "HOME","USERPROFILE","HOMEDRIVE","HOMEPATH","APPDATA","LOCALAPPDATA","PROGRAMDATA",
  "XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_CACHE_HOME",
  "LANG","LC_ALL","LC_CTYPE","TERM","COLORTERM","SHELL","USER","USERNAME","LOGNAME",
  "SSL_CERT_FILE","SSL_CERT_DIR","NODE_EXTRA_CA_CERTS","NO_COLOR","FORCE_COLOR",
]);

// What each harness gets of Trebell's own environment beside the baseline: its home, its config, its endpoint, its release channel
// and Trebell's own lock on the OpenCode server it starts. None is a credential: a harness signs in with its own login in its own
// home, or, only when the person picks it in Settings, runs on its vendor's API key, which AgentRuntimeManager adds itself
// (harness-auth.mjs). A key in .env, the shell, the Windows user environment or a profile's approved names never reaches a harness,
// on this machine or on a WSL or SSH host (each name here is forwarded from the host's shell there), and never switches one to its
// key method. Claude Code's cloud-provider switches (Bedrock, Vertex, Foundry) are its own configuration (its settings.json env).
const RUNTIME_KEYS=Object.freeze({
  native:Object.freeze([]),
  codex:Object.freeze(["CODEX_HOME","OPENAI_BASE_URL"]),
  claude:Object.freeze(["ANTHROPIC_BASE_URL"]),
  cursor:Object.freeze(["CURSOR_API_ENDPOINT"]),
  grok:Object.freeze([
    "GROK_HOME","GROK_OIDC_ISSUER","GROK_OIDC_CLIENT_ID","GROK_OAUTH2_ISSUER","GROK_OAUTH2_CLIENT_ID","GROK_OAUTH2_PRINCIPAL_TYPE",
    "GROK_OAUTH2_PRINCIPAL_ID","GROK_LOCAL_AUTH","GROK_CLI_CHAT_PROXY_BASE_URL","GROK_MODELS_BASE_URL","GROK_CONFIG","GROK_CONFIG_PATH",
  ]),
  opencode:Object.freeze(["OPENCODE_CONFIG","OPENCODE_CONFIG_DIR","OPENCODE_SERVER_USERNAME","OPENCODE_SERVER_PASSWORD","AZURE_OPENAI_ENDPOINT","AWS_REGION","AWS_DEFAULT_REGION"]),
  // Antigravity takes no Google credential, project or home from Trebell's environment (antigravity-auth.mjs).
  antigravity:Object.freeze([]),
  muse:Object.freeze(["MUSE_CHANNEL"]),
});

// Trebell's own lock on an OpenCode server (the password it starts one with, or the one a profile's own server asks for): no
// provider's credential, so it passes where its name is listed.
const HARNESS_SERVER_LOCKS=new Set(["OPENCODE_SERVER_PASSWORD"]);
// The names that carry a model provider's key or a harness's sign-in, beside every name isSecretEnvironmentName matches (any
// *_API_KEY, *_TOKEN, *_SECRET*, *_PASSWORD): Native's providers' keys (provider-manager.mjs MODEL_PROVIDERS, tests check each is
// here), the keys and sign-ins each harness reads (Grok's stored sign-in and the command that prints its token, OpenCode's stored
// credentials, Muse's and Claude Code's header strings, AWS's key id) and Google's credential file.
const HARNESS_CREDENTIAL_NAMES=new Set([
  "OPENAI_API_KEY","CODEX_API_KEY","CODEX_ACCESS_TOKEN","ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN",
  "CURSOR_API_KEY","CURSOR_AUTH_TOKEN","XAI_API_KEY","GROK_CODE_XAI_API_KEY","GROK_AUTH","GROK_AUTH_PROVIDER_COMMAND",
  "OPENCODE_API_KEY","OPENCODE_AUTH_CONTENT","GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","GOOGLE_APPLICATION_CREDENTIALS",
  "META_API_KEY","MODEL_API_KEY","AGENTROUTER_API_KEY","JUSTWORKER_API_KEY","HCNSEC_API_KEY","VYCEAI_API_KEY","OPENROUTER_API_KEY",
  "AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AWS_BEARER_TOKEN_BEDROCK","ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_FOUNDRY_API_KEY","ANTHROPIC_FOUNDRY_AUTH_TOKEN","ANTHROPIC_CUSTOM_HEADERS","MUSE_CUSTOM_HEADERS","HF_TOKEN",
]);
// Whether a variable's name carries a credential no harness gets from Trebell: whatever its case, as Windows reads names so.
export function isHarnessCredentialName(name){
  const upper=String(name||"").trim().toUpperCase();if(!upper)return false;
  return isSecretEnvironmentName(upper)||HARNESS_CREDENTIAL_NAMES.has(upper)||/(?:_CREDENTIALS|_AUTH_CONTENT|_API_KEY|_ACCESS_KEY_ID)$/.test(upper);
}
// What a harness may get by name: anything but a credential, except Trebell's lock on its OpenCode server.
const harnessMay=(runtime,name)=>runtime==="native"||!isHarnessCredentialName(name)||HARNESS_SERVER_LOCKS.has(String(name).toUpperCase());
// A profile's approved names a harness can get: for every kind but Native, none that carries a credential (a profile saved before
// this kept them, and they stay out).
export function harnessApprovedKeys(kind,approved=[]){
  const runtime=String(kind||"").toLowerCase();
  return normalizeApprovedEnvironmentKeys(approved).filter(name=>runtime==="native"||!isHarnessCredentialName(name));
}

// What a project's toolchain reads to find itself, the version picked for the project, the packages already installed and how
// to build: the commands Native runs for the model (its terminal and background processes) get these on top of the baseline, as
// the person's own shell has them, so a command finds what is installed (gems under GEM_HOME and BUNDLE_*, /usr/local/bundle in
// the Ruby images; rustup's default toolchain under RUSTUP_HOME; a JDK at JAVA_HOME; an activated virtualenv). Every name is a
// location, a version, a switch or build flags. None holds a credential, and no family that does is listed or matched by prefix:
// BUNDLE_<host> credentials, NPM_CONFIG_* (_auth), *_TOKEN, *_PASSWORD, *_SECRET, CARGO_REGISTRIES_*_TOKEN, COMPOSER_AUTH, the
// package-index and proxy URLs (GOPROXY, PIP_INDEX_URL, UV_INDEX_URL, HTTPS_PROXY), which can embed user:password, and the JVM's
// and the build tools' option strings (below). A value that carries a credential all the same is dropped (carriesCredentials).
// Trebell's own git, diagnostics and transports keep the baseline: they run fixed commands that need none of this.
export const TOOLCHAIN_ENVIRONMENT_KEYS=Object.freeze([
  // Rust: rustup's toolchains, the one selected and the mirror it installs a pinned one from; cargo's home (registry cache,
  // installed tools), build directory, offline and git switches, and flags.
  "RUSTUP_HOME","RUSTUP_TOOLCHAIN","RUSTUP_DIST_SERVER","RUSTUP_UPDATE_ROOT","CARGO_HOME","CARGO_TARGET_DIR","CARGO_NET_OFFLINE",
  "CARGO_NET_GIT_FETCH_WITH_CLI","CARGO_INCREMENTAL","RUSTFLAGS","RUSTDOCFLAGS",
  // Ruby: where gems are installed and looked up, Bundler's settings by their names, the load path and interpreter options, rbenv.
  "GEM_HOME","GEM_PATH","BUNDLE_PATH","BUNDLE_APP_CONFIG","BUNDLE_BIN","BUNDLE_GEMFILE","BUNDLE_WITHOUT","BUNDLE_WITH","BUNDLE_DEPLOYMENT",
  "BUNDLE_FROZEN","BUNDLE_JOBS","BUNDLE_SILENCE_ROOT_WARNING","RUBYLIB","RUBYOPT","RBENV_ROOT","RBENV_VERSION",
  // Go: the workspace and module cache (modules downloaded into the image), the toolchain and its selection (GOTOOLCHAIN=local),
  // build switches and cgo flags, and which modules are private (GOPROXY stays out).
  "GOPATH","GOROOT","GOBIN","GOMODCACHE","GOCACHE","GOENV","GOFLAGS","GO111MODULE","GOTOOLCHAIN","GOWORK","GOPRIVATE","GONOPROXY",
  "GONOSUMDB","CGO_ENABLED","CGO_CFLAGS","CGO_CPPFLAGS","CGO_CXXFLAGS","CGO_LDFLAGS",
  // JVM: the JDK, Maven, Gradle, Ant, SDKMAN and the Android SDK. The options the JVM and the build tools read stay out
  // (JAVA_TOOL_OPTIONS, which every JVM prints as it starts, JAVA_OPTS, MAVEN_OPTS, MAVEN_ARGS, GRADLE_OPTS, SBT_OPTS): their vendors
  // document credentials in them in forms no check of names and shapes tells from a plain option (Honeycomb's
  // -Dotel.exporter.otlp.headers=x-honeycomb-team=<key>, an Azure SAS's sig=, a user:password@host with no scheme), and the
  // benchmark images set none of them.
  "JAVA_HOME","JDK_HOME","JRE_HOME","MAVEN_HOME","M2_HOME","GRADLE_HOME","GRADLE_USER_HOME","ANT_HOME","SDKMAN_DIR",
  "ANDROID_HOME","ANDROID_SDK_ROOT","ANDROID_NDK_HOME","ANDROID_NDK_ROOT",
  // Python: the active virtualenv or conda env, the import path and interpreter switches, pyenv, and pip's and uv's settings by
  // their names (PIP_BREAK_SYSTEM_PACKAGES for an image's system Python; never an index URL).
  "VIRTUAL_ENV","CONDA_PREFIX","CONDA_DEFAULT_ENV","CONDA_EXE","CONDA_PYTHON_EXE","CONDA_SHLVL","MAMBA_ROOT_PREFIX","MAMBA_EXE",
  "PYTHONPATH","PYTHONHOME","PYTHONUSERBASE","PYTHONNOUSERSITE","PYTHONDONTWRITEBYTECODE","PYTHONUNBUFFERED","PYTHONIOENCODING","PYTHONUTF8",
  "PYENV_ROOT","PYENV_VERSION","PIP_BREAK_SYSTEM_PACKAGES","PIP_ROOT_USER_ACTION","PIP_NO_CACHE_DIR","PIP_CACHE_DIR","PIP_DISABLE_PIP_VERSION_CHECK",
  "UV_CACHE_DIR","UV_PYTHON","UV_PYTHON_INSTALL_DIR","UV_PROJECT_ENVIRONMENT","UV_SYSTEM_PYTHON","UV_TOOL_DIR","UV_TOOL_BIN_DIR",
  // JavaScript: Node's module path and options, the version managers (nvm, nodenv, Volta, fnm), pnpm, Corepack, Bun and Deno.
  "NODE_PATH","NODE_OPTIONS","NVM_DIR","NVM_BIN","NVM_INC","NODENV_ROOT","NODENV_VERSION","VOLTA_HOME","FNM_DIR","PNPM_HOME",
  "COREPACK_HOME","COREPACK_ENABLE_DOWNLOAD_PROMPT","COREPACK_ENABLE_STRICT","BUN_INSTALL","DENO_DIR",
  // PHP: Composer's home, cache, folders and switches (never COMPOSER_AUTH), and where PHP finds its ini files.
  "COMPOSER_HOME","COMPOSER_CACHE_DIR","COMPOSER_VENDOR_DIR","COMPOSER_BIN_DIR","COMPOSER_ALLOW_SUPERUSER","COMPOSER_MEMORY_LIMIT",
  "PHP_INI_DIR","PHP_INI_SCAN_DIR","PHPRC",
  // .NET: the SDK root, the CLI's home and switches (its telemetry opt-out included), and the NuGet package folder.
  "DOTNET_ROOT","DOTNET_CLI_HOME","DOTNET_CLI_TELEMETRY_OPTOUT","DOTNET_NOLOGO","NUGET_PACKAGES",
  // C and C++: the compilers and archiver, their flags and search paths, pkg-config, CMake and vcpkg, CUDA, the macOS SDK and
  // deployment target, and MSVC's INCLUDE, LIB and LIBPATH from a developer prompt.
  "CC","CXX","AR","CFLAGS","CXXFLAGS","CPPFLAGS","LDFLAGS","CPATH","C_INCLUDE_PATH","CPLUS_INCLUDE_PATH","LIBRARY_PATH","LD_LIBRARY_PATH",
  "PKG_CONFIG_PATH","CMAKE_PREFIX_PATH","VCPKG_ROOT","CUDA_HOME","CUDA_PATH","SDKROOT","DEVELOPER_DIR","MACOSX_DEPLOYMENT_TARGET",
  "INCLUDE","LIB","LIBPATH",
  // The CA bundles package downloads trust behind a TLS-inspecting proxy, beside the baseline's SSL_CERT_FILE.
  "REQUESTS_CA_BUNDLE","CURL_CA_BUNDLE","PIP_CERT","CARGO_HTTP_CAINFO","GIT_SSL_CAINFO",
  // Other languages' library paths and package homes (Perl's local::lib, R, Julia, Erlang and Elixir, Dart and Flutter,
  // Haskell, OCaml, Lua) and asdf's folders.
  "PERL5LIB","PERL_LOCAL_LIB_ROOT","PERL_MB_OPT","PERL_MM_OPT","R_LIBS","R_LIBS_USER","JULIA_DEPOT_PATH","ERL_LIBS","MIX_HOME","HEX_HOME",
  "PUB_CACHE","FLUTTER_ROOT","STACK_ROOT","CABAL_DIR","OPAMROOT","OPAM_SWITCH_PREFIX","CAML_LD_LIBRARY_PATH","LUA_PATH","LUA_CPATH",
  "ASDF_DIR","ASDF_DATA_DIR",
  // Windows: where programs are installed (Python, node-gyp and cargo's cc find Visual Studio's vswhere under ProgramFiles(x86)),
  // and the OS and processor values build scripts test (a Makefile's $(OS) = Windows_NT). libuv already gives every child
  // SYSTEMROOT, SYSTEMDRIVE, WINDIR and the other variables Windows itself needs.
  "ProgramFiles","ProgramFiles(x86)","ProgramW6432","OS","PROCESSOR_ARCHITECTURE","NUMBER_OF_PROCESSORS",
]);

// A toolchain value that carries a credential although its name does not: a URL with userinfo (https://user:pass@host, or a token
// as the user); a connect string's user/password@ (jdbc:oracle:thin:scott/tiger@//db:1521/svc); or a setting whose name holds one
// of these words anywhere, whatever its case, as documented credential settings do (-Dhttps.proxyPassword, -Daws.secretKey,
// -Dsonar.login, -Dnewrelic.config.license_key, an OpenTelemetry Authorization header) and a C define or a Go -X flag can
// (-DSENTRY_AUTH_TOKEN=, -X=main.apiToken=). A setting's name is the run of letters, digits, _, . and - before its =, so a path's
// words (--sysroot=/opt/keys/sdk) are not one. environment-manager.mjs checks a remote host's values the same way.
export const CREDENTIAL_SETTING_WORDS=Object.freeze(["pass","pwd","secret","token","credential","key","login","auth"]);
const URL_USERINFO=/[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@/i;
const CREDENTIAL_SETTING=new RegExp("(?:"+CREDENTIAL_SETTING_WORDS.join("|")+")[A-Za-z0-9_.-]*=","i");
// The user starts the value or follows a space, :, =, a comma or ;, and neither part holds a / or \. An absolute path's folder
// before an @ (/opt/homebrew/opt/openssl@3) follows a /, so it passes; a relative path's (-Ivendor/openssl@3/include,
// src:lib/vendor@1) and one past a space in its path (/home/me/My Projects/openssl@3) read as user/password@, and the value is dropped.
const CONNECT_USERINFO=/(?:^|[ \t\n\r\v\f:=,;])[^ \t\n\r\v\f/\\:=,;@]+\/[^ \t\n\r\v\f/\\@]+@/;
export function carriesCredentials(value){const text=String(value??"");return URL_USERINFO.test(text)||CREDENTIAL_SETTING.test(text)||CONNECT_USERINFO.test(text)}

// The proxy an external harness reaches its API through, as the person's terminal gives it: both spellings, as curl, Go and Rust read
// the lower-case ones (curl reads http_proxy only that way). A proxy that holds a user name or password (http://user:pass@proxy:8080,
// or user:pass@proxy:8080 with no scheme, as curl takes it) passes only when the profile approves its name.
export const PROXY_ENVIRONMENT_KEYS=Object.freeze(["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy"]);
const PROXY_USERINFO=/^\s*(?:[a-z][a-z0-9+.-]*:\/\/)?[^\s/?#@]+@/i;
function proxyCarriesCredentials(value){return carriesCredentials(value)||PROXY_USERINFO.test(String(value))}

function keyName(value){return String(value||"").trim()}
function validName(value){return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)}

export function normalizeApprovedEnvironmentKeys(value){
  const source=Array.isArray(value)?value:typeof value==="string"?value.split(/[\s,]+/):[];
  return [...new Set(source.map(keyName).filter(validName))].slice(0,100);
}

export function runtimeEnvironmentKeys(kind,{approved=[]}={}){
  return [...new Set([...BASELINE_KEYS,...(RUNTIME_KEYS[String(kind||"").toLowerCase()]||[]),...harnessApprovedKeys(kind,approved)])];
}

// A name's value in the parent; on Windows whatever its case, the first spelling in the parent's order winning. The parent's
// spellings are listed once, when a name is first missed: most toolchain names are unset, and each listing of process.env asks
// the OS for the whole environment.
function parentLookup(parent,{caseInsensitive=false}={}){
  let spellings=null;
  return name=>{
    if(Object.prototype.hasOwnProperty.call(parent,name))return parent[name];
    if(!caseInsensitive)return undefined;
    if(!spellings){spellings=new Map();for(const key of Object.keys(parent)){const lower=key.toLowerCase();if(!spellings.has(lower))spellings.set(lower,key)}}
    const found=spellings.get(name.toLowerCase());
    return found==null?undefined:parent[found];
  };
}

// toolchain adds TOOLCHAIN_ENVIRONMENT_KEYS, for the commands Native runs for the model. A name already set keeps that value;
// a toolchain value that carries credentials is left out. An external harness (every kind but native) always gets them, and the
// proxy variables, as its CLI gets them in the person's terminal: the builds it runs find their toolchains (JAVA_HOME, an activated
// virtualenv, GOPATH, CARGO_HOME), and its requests go out through the proxy the network needs. Native's commands and Trebell's
// git, diagnostics and transports keep what they had; a harness on a remote host forwards only runtimeEnvironmentKeys' names.
export function buildRuntimeEnvironment(kind,{parent={},approved=[],overrides={},platform=process.platform,toolchain=false}={}){
  const env={},caseInsensitive=platform==="win32",lookup=parentLookup(parent,{caseInsensitive}),runtime=String(kind||"").toLowerCase(),harness=runtime!=="native";
  for(const name of runtimeEnvironmentKeys(kind,{approved})){
    const value=lookup(name);
    if(value!=null&&String(value)!=="")env[name]=String(value);
  }
  if(toolchain||harness){
    const fold=name=>caseInsensitive?name.toLowerCase():name,set=new Set(Object.keys(env).map(fold));
    for(const name of TOOLCHAIN_ENVIRONMENT_KEYS){
      if(set.has(fold(name)))continue;
      const value=lookup(name);
      if(value!=null&&String(value)!==""&&!carriesCredentials(value))env[name]=String(value);
    }
    // On Windows a name is one variable whatever its case: HTTPS_PROXY and https_proxy are the same one, given once.
    if(harness)for(const name of PROXY_ENVIRONMENT_KEYS){
      if(set.has(fold(name)))continue;
      const value=lookup(name);
      if(value!=null&&String(value)!==""&&!proxyCarriesCredentials(value)){env[name]=String(value);set.add(fold(name))}
    }
  }
  // A profile's own variables, none that carries a credential for a harness (as its approved names).
  for(const [name,value] of Object.entries(overrides||{})){
    if(!validName(name)||value==null||!harnessMay(runtime,name))continue;
    env[name]=String(value);
  }
  return env;
}
