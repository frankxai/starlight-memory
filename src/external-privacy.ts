import type { PrivacyClass } from "./types.js";

export interface ExternalMirrorPrivacyPolicy {
  allowPrivateExternalMirror?: boolean;
  allowRegulatedExternalMirror?: boolean;
}

/**
 * Fail-closed privacy policy for any provider that can cross the local trust
 * boundary. `private-shareable` is the explicit projection class; `private`
 * remains local unless a tenant knowingly opts into an external mirror.
 */
export function isExternalMirrorAllowed(
  privacyClass: PrivacyClass,
  policy: ExternalMirrorPrivacyPolicy = {},
): boolean {
  switch (privacyClass) {
    case "public":
    case "private-shareable":
      return true;
    case "private":
      return policy.allowPrivateExternalMirror === true;
    case "regulated":
      return policy.allowRegulatedExternalMirror === true;
    case "secret":
      return false;
  }
}
