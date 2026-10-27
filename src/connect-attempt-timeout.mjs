import { getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

// Node tries a host's addresses in turn and gives each one 250 ms to connect (its Happy Eyeballs default). Where IPv6 is offered but
// does not route, that gave up on an IPv4 connect that works but takes longer, so reading the ACP registry and downloading
// Antigravity from dl.google.com failed. Trebell's server gives each address at least a second, once as it starts (T3
// extendConnectionAttemptTimeout); a longer --network-family-autoselection-attempt-timeout given to Node stays. The setting is the
// process's, so the server's entry points make it (src/gui-server.mjs, desktop/main.mjs), never a module of the Native benchmark bundle.
export const CONNECT_ATTEMPT_TIMEOUT_MS=1000;
export function extendConnectAttemptTimeout(){
  setDefaultAutoSelectFamilyAttemptTimeout(Math.max(getDefaultAutoSelectFamilyAttemptTimeout(),CONNECT_ATTEMPT_TIMEOUT_MS));
}
