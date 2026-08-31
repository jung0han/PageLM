import { config } from "../config/env"
import { HttpAuthentikOidc, HttpQaiPersonResolver } from "./adapters"
import { AuthService } from "./service"

export function createRuntimeAuth() {
  const oidc = new HttpAuthentikOidc({
    authorizationUrl: process.env.AUTHENTIK_AUTHORIZATION_URL || "",
    tokenUrl: process.env.AUTHENTIK_TOKEN_URL || "",
    userinfoUrl: process.env.AUTHENTIK_USERINFO_URL || "",
    revocationUrl: process.env.AUTHENTIK_REVOCATION_URL,
    clientId: process.env.AUTHENTIK_CLIENT_ID || "",
    clientSecret: process.env.AUTHENTIK_CLIENT_SECRET || "",
  })
  return new AuthService({
    oidc,
    personResolver: new HttpQaiPersonResolver(
      process.env.QAI_PERSON_RESOLVER_URL || "",
      process.env.QAI_PERSON_RESOLVER_TOKEN || "",
    ),
    redirectUri: process.env.AUTHENTIK_REDIRECT_URI || `${config.baseUrl}/auth/callback`,
    frontendUrl: config.frontendUrl,
  })
}
