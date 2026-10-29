// The relay waits five minutes for the person's answer to a harness's approval, question or form (agent-relay.mjs serverRequest), then
// takes the request off the screen and rejects the wait with this time-out. Only that rejection is a request left unanswered: the relay
// closing (Trebell quitting) rejects every wait it still holds too, before it closes the harness sessions one by one.
export const USER_RESPONSE_TIMED_OUT="USER_RESPONSE_TIMED_OUT";

export function userResponseTimeout(method){
  return Object.assign(new Error(`${method} user response timed out`),{code:USER_RESPONSE_TIMED_OUT});
}

export function isUserResponseTimeout(error){
  return error?.code===USER_RESPONSE_TIMED_OUT;
}
