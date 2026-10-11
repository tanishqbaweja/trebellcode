// Syntax colours for the Files viewer: the Prism grammar that fits a file, by its extension or its name, or none.
import Prism from "prismjs";
// Prism's own build holds markup, css, clike and javascript. These add the languages repositories commonly hold, each after the
// grammar it extends (clike before the C family, c before cpp).
import "prismjs/components/prism-c.js";
import "prismjs/components/prism-cpp.js";
import "prismjs/components/prism-csharp.js";
import "prismjs/components/prism-java.js";
import "prismjs/components/prism-go.js";
import "prismjs/components/prism-rust.js";
import "prismjs/components/prism-kotlin.js";
import "prismjs/components/prism-swift.js";
import "prismjs/components/prism-python.js";
import "prismjs/components/prism-ruby.js";
import "prismjs/components/prism-bash.js";
import "prismjs/components/prism-powershell.js";
import "prismjs/components/prism-yaml.js";
import "prismjs/components/prism-toml.js";
import "prismjs/components/prism-ini.js";
import "prismjs/components/prism-docker.js";
import "prismjs/components/prism-makefile.js";
import "prismjs/components/prism-sql.js";
import "prismjs/components/prism-diff.js";

// TypeScript and JSON keep the JavaScript grammar they have always had, and other curly-brace languages get the shared C-like
// one. Files without a grammar here (.txt, .log, LICENSE, …) show as plain text: a prose file coloured as code reads "this" or
// "if" as keywords.
const GRAMMARS={
  javascript:"js mjs cjs jsx ts tsx mts cts json jsonc json5 webmanifest",
  css:"css scss less sass pcss postcss",
  markup:"html htm xhtml xml svg xsl xslt xsd plist rss atom vue svelte csproj fsproj vbproj props targets resx xaml nuspec",
  clike:"php dart scala groovy gradle jenkinsfile mm zig sol cu cuh glsl hlsl frag vert proto",
  c:"c h",
  cpp:"cpp cc cxx hpp hh hxx ino",
  csharp:"cs csx",
  java:"java",
  go:"go",
  rust:"rs",
  kotlin:"kt kts",
  swift:"swift",
  python:"py pyw pyi bzl",
  ruby:"rb rake gemspec ru gemfile rakefile vagrantfile podfile brewfile",
  bash:"sh bash zsh ksh env bashrc zshrc bash_profile zprofile",
  powershell:"ps1 psm1 psd1",
  yaml:"yml yaml",
  toml:"toml",
  ini:"ini cfg conf properties editorconfig gitconfig npmrc",
  docker:"dockerfile containerfile",
  makefile:"makefile gnumakefile mk mak",
  sql:"sql",
  diff:"diff patch",
};
const LANGUAGE_BY_EXTENSION=new Map(Object.entries(GRAMMARS).flatMap(([language,extensions])=>extensions.split(" ").map(extension=>[extension,language])));

// The grammar for a file name, or "" for plain text. A name with no extension is looked up whole ("Dockerfile", "Makefile"), and
// "Dockerfile.dev" is still a Dockerfile.
export function syntaxLanguage(name=""){
  const base=String(name??"").split(/[\\/]/).pop().toLowerCase();
  if(/^(?:docker|container)file(?:\.|$)/.test(base))return "docker";
  const language=LANGUAGE_BY_EXTENSION.get(base.split(".").pop())||"";
  return language&&Prism.languages[language]?language:"";
}

// The file's text as Prism HTML, or null for plain text, which is then rendered as text (React escapes it) with no colours.
export function highlightSyntax(text,name){
  const language=syntaxLanguage(name);
  return text!=null&&language?Prism.highlight(String(text),Prism.languages[language],language):null;
}
