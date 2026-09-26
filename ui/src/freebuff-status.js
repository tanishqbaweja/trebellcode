const UNAVAILABLE_SESSION_STATUSES=new Set(["banned","blocked","suspended"]);

export function freebuffSessionUnavailable(overview){
  if(overview?.errors?.session)return true;
  const status=String(overview?.derived?.sessionStatus||overview?.session?.status||"").trim().toLowerCase();
  return UNAVAILABLE_SESSION_STATUSES.has(status);
}

export function freebuffSessionLabel(overview){
  return String(overview?.derived?.sessionStatus||overview?.session?.status||"").trim().toLowerCase()||"unavailable";
}
