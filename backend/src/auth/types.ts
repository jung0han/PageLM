export type ActiveQaiPerson = {
  subject: string
  personId: string
  organizationSubjects?: string[]
}

/** The only application-facing authority from an Authentik subject to a QAI learning user. */
export interface QaiPersonResolver {
  resolveActivePerson(subject: string): Promise<ActiveQaiPerson | null>
}

export type OidcAuthorizationInput = {
  state: string
  nonce: string
  codeChallenge: string
  redirectUri: string
}

export type OidcSession = {
  subject: string
  refreshToken?: string
  expiresAt: number
}

export interface AuthentikOidc {
  authorizationUrl(input: OidcAuthorizationInput): string
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<OidcSession>
  refresh(refreshToken: string): Promise<OidcSession>
  revoke(refreshToken: string): Promise<void>
}

export type AuthenticatedRequest = {
  subject: string
  person: ActiveQaiPerson
  expiresAt: number
}
