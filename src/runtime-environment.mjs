const BASELINE_KEYS=Object.freeze([
  "PATH","PATHEXT","SystemRoot","WINDIR","COMSPEC","TEMP","TMP","TMPDIR",
  "HOME","USERPROFILE","HOMEDRIVE","HOMEPATH","APPDATA","LOCALAPPDATA","PROGRAMDATA",
  "XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_CACHE_HOME",
  "LANG","LC_ALL","LC_CTYPE","TERM","COLORTERM","SHELL","USER","USERNAME","LOGNAME",
  "SSL_CERT_FILE","SSL_CERT_DIR","NODE_EXTRA_CA_CERTS","NO_COLOR","FORCE_COLOR",
]);

const RUNTIME_KEYS=Object.freeze({
  native:Object.freeze([]),
  codex:Object.freeze(["CODEX_HOME","OPENAI_API_KEY","OPENAI_BASE_URL","OPENAI_ORG_ID","OPENAI_PROJECT_ID","CODEX_API_KEY"]),
  claude:Object.freeze(["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","CLAUDE_CODE_OAUTH_TOKEN","ANTHROPIC_BASE_URL"]),
  cursor:Object.freeze(["CURSOR_API_KEY","CURSOR_AUTH_TOKEN","CURSOR_API_ENDPOINT"]),
  grok:Object.freeze([
    "XAI_API_KEY","GROK_AUTH","GROK_HOME","GROK_OIDC_ISSUER","GROK_OIDC_CLIENT_ID",
    "GROK_OAUTH2_ISSUER","GROK_OAUTH2_CLIENT_ID","GROK_OAUTH2_PRINCIPAL_TYPE","GROK_OAUTH2_PRINCIPAL_ID",
    "GROK_AUTH_PROVIDER_COMMAND","GROK_LOCAL_AUTH","GROK_CLI_CHAT_PROXY_BASE_URL","GROK_MODELS_BASE_URL",
    "GROK_CONFIG","GROK_CONFIG_PATH",
  ]),
  opencode:Object.freeze([
    "OPENCODE_API_KEY","OPENCODE_AUTH_CONTENT","OPENCODE_CONFIG","OPENCODE_CONFIG_DIR","OPENCODE_SERVER_USERNAME","OPENCODE_SERVER_PASSWORD",
    "OPENAI_API_KEY","ANTHROPIC_API_KEY","GOOGLE_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY",
    "NVIDIA_API_KEY","HF_TOKEN","HUGGINGFACE_API_KEY","DEEPSEEK_API_KEY","MISTRAL_API_KEY","GROQ_API_KEY","XAI_API_KEY",
    "COHERE_API_KEY","CEREBRAS_API_KEY","TOGETHER_API_KEY","FIREWORKS_API_KEY","PERPLEXITY_API_KEY",
    "AZURE_OPENAI_API_KEY","AZURE_OPENAI_ENDPOINT",
    "AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN","AWS_REGION","AWS_DEFAULT_REGION",
  ]),
  antigravity:Object.freeze([
    "GEMINI_HOME","GOOGLE_API_KEY","GEMINI_API_KEY","GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT","GOOGLE_CLOUD_LOCATION","CLOUDSDK_CORE_PROJECT",
  ]),
});

// What a project's toolchain reads to find itself, the version picked for the project, the packages already installed and how
// to build: the commands Native runs for the model (its terminal and background processes) get these on top of the baseline, as
// the person's own shell has them, so a command finds what is installed (gems under GEM_HOME and BUNDLE_*, /usr/local/bundle in
// the Ruby images; rustup's default toolchain under RUSTUP_HOME; a JDK at JAVA_HOME; an activated virtualenv). Every name is a
// location, a version, a switch or build flags. None holds a credential, and no family that does is listed or matched by prefix:
// BUNDLE_<host> credentials, NPM_CONFIG_* (_auth), *_TOKEN, *_PASSWORD, *_SECRET, CARGO_REGISTRIES_*_TOKEN, COMPOSER_AUTH, and
// the package-index and proxy URLs (GOPROXY, PIP_INDEX_URL, UV_INDEX_URL, HTTPS_PROXY), which can embed user:password. A value
// that carries a credential all the same is dropped (carriesCredentials). Trebell's own git, diagnostics and transports keep the
// baseline: they run fixed commands that need none of this.
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
  // JVM: the JDK, Maven, Gradle, Ant, SDKMAN and the Android SDK, and the options the JVM and the build tools read (a local
  // repository given as -Dmaven.repo.local).
  "JAVA_HOME","JDK_HOME","JRE_HOME","JAVA_TOOL_OPTIONS","JAVA_OPTS","MAVEN_HOME","M2_HOME","MAVEN_OPTS","MAVEN_ARGS","GRADLE_HOME",
  "GRADLE_USER_HOME","GRADLE_OPTS","ANT_HOME","SBT_OPTS","SDKMAN_DIR","ANDROID_HOME","ANDROID_SDK_ROOT","ANDROID_NDK_HOME","ANDROID_NDK_ROOT",
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
// as the user), or a setting named as a secret (-Dhttps.proxyPassword=... in MAVEN_OPTS, -Dsonar.token=... in GRADLE_OPTS).
export const CREDENTIAL_SETTING_WORDS=Object.freeze(["password","passwd","passphrase","secret","token","credential","credentials","apikey","api_key","api-key"]);
const URL_USERINFO=/[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+@/i;
const CREDENTIAL_SETTING=new RegExp("(?:"+CREDENTIAL_SETTING_WORDS.join("|")+")=","i");
export function carriesCredentials(value){const text=String(value??"");return URL_USERINFO.test(text)||CREDENTIAL_SETTING.test(text)}

function keyName(value){return String(value||"").trim()}
function validName(value){return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)}

export function normalizeApprovedEnvironmentKeys(value){
  const source=Array.isArray(value)?value:typeof value==="string"?value.split(/[\s,]+/):[];
  return [...new Set(source.map(keyName).filter(validName))].slice(0,100);
}

export function runtimeEnvironmentKeys(kind,{approved=[]}={}){
  return [...new Set([...BASELINE_KEYS,...(RUNTIME_KEYS[String(kind||"").toLowerCase()]||[]),...normalizeApprovedEnvironmentKeys(approved)])];
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
// a toolchain value that carries credentials is left out.
export function buildRuntimeEnvironment(kind,{parent={},approved=[],overrides={},platform=process.platform,toolchain=false}={}){
  const env={},caseInsensitive=platform==="win32",lookup=parentLookup(parent,{caseInsensitive});
  for(const name of runtimeEnvironmentKeys(kind,{approved})){
    const value=lookup(name);
    if(value!=null&&String(value)!=="")env[name]=String(value);
  }
  if(toolchain){
    const fold=name=>caseInsensitive?name.toLowerCase():name,set=new Set(Object.keys(env).map(fold));
    for(const name of TOOLCHAIN_ENVIRONMENT_KEYS){
      if(set.has(fold(name)))continue;
      const value=lookup(name);
      if(value!=null&&String(value)!==""&&!carriesCredentials(value))env[name]=String(value);
    }
  }
  for(const [name,value] of Object.entries(overrides||{})){
    if(!validName(name)||value==null)continue;
    env[name]=String(value);
  }
  return env;
}
