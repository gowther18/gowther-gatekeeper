// HMAC-SHA256 signing for Agent Games envelopes.
// The platform signs inbound bodies with the dashboard secret and expects the
// same signature over our raw response body, in the `x-agent-games-signature`
// header. Default encoding is lowercase hex with no prefix; the `sha256=`
// form exists as a fallback switch (AGENT_GAMES_HMAC_FORMAT=sha256=).
// The secret is NEVER logged by this module.
import crypto from "node:crypto";

export function signatureFor(secret, rawBody, format = "hex") {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return format === "sha256=" ? "sha256=" + hex : hex;
}

export function verifySignature(secret, rawBody, headerValue, format = "hex") {
  if (!secret || !headerValue) return false;
  const expected = Buffer.from(signatureFor(secret, rawBody, format));
  const actual = Buffer.from(String(headerValue).trim());
  if (expected.length !== actual.length) return false;
  try {
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
