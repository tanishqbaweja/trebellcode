// Lines an ACP agent prints on stderr that hold something an error or a warning must not quote back: the test inputs of the agent log
// redaction (tests/acp-client.test.mjs, tests/acp-sign-in-url-redaction.test.mjs, tests/harness-text-generation.test.mjs). A pair
// is [what the agent printed, what an excerpt of its log shows of that line].

// A Google sign-in address as an app signing in through Google's OAuth 2.0 for desktop apps opens it: the authorization endpoint, a
// client id in Google's form, a loopback redirect (written out plainly, as some agents print it), the scopes, a PKCE challenge and
// the state tb-signin-state-41c9.
export const GOOGLE_SIGN_IN_URL="https://accounts.google.com/o/oauth2/v2/auth?client_id=104729000000-trebelltestclient.apps.googleusercontent.com&redirect_uri=http://127.0.0.1:61205/callback&response_type=code&scope=openid%20email&code_challenge=q2Vn8sFhJ0cY5tWm3RkLx7bD9aZpE1uG4oNiTyHjKwM&code_challenge_method=S256&state=tb-signin-state-41c9";

// What a signed-out agent prints as it starts, and an excerpt of it.
export const SIGN_IN_LINE=["Sign in with your Google account to continue: "+GOOGLE_SIGN_IN_URL,"Sign in with your Google account to continue: [redacted sign-in link]"];
// A shorter sign-in address on plain http, another of Google's sign-in pages.
export const ACCOUNT_CHOOSER_LINE=[
  "Session expired, choose an account at http://accounts.google.com/AccountChooser?continue=https%3A%2F%2Fconsole.cloud.google.com%2F",
  "Session expired, choose an account at [redacted sign-in link]",
];
// An Authorization header with a Bearer token (RFC 6750), its token using each character a token may hold: letters, digits, . _ - ~ + /
// and the = padding at its end.
export const BEARER_LINE=[
  "GET /v1/models answered 401, retrying with Authorization: Bearer trebell.bearer_4u-Zp+9Q~t/x==",
  "GET /v1/models answered 401, retrying with Authorization: Bearer [redacted]",
];
// A pairing link: an address whose fragment, after /pair#, is the one-time code that pairs a device.
export const PAIRING_LINE=[
  "Remote control is on: pair a device at http://192.168.1.20:47100/pair#otp=7DK4QP9Z within 10 minutes",
  "Remote control is on: pair a device at [redacted pairing link] within 10 minutes",
];

// None of the secrets above, the state, the loopback redirect or Google's sign-in host is left in an excerpt.
export const HIDDEN_IN_EXCERPT=/tb-signin-state-41c9|127\.0\.0\.1:61205|accounts\.google\.com|bearer_4u|Zp\+9Q|7DK4QP9Z/;
