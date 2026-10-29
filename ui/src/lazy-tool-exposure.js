// The specialized tool namespaces a message's text selects are Native's shared configuration (src/native-configuration.mjs), which
// the benchmark runner applies to its task too. Background processes are not selected: Native always has them.
export { nativeSpecializedNamespaceNames as specializedToolNamespaceNames, nativeSpecializedSelection as specializedToolSelection } from "../../src/native-configuration.mjs";
