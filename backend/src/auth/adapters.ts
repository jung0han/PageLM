import type { ActiveQaiPerson, AuthentikOidc, OidcSession, QaiPersonResolver } from "./types"

async function jsonResponse(response: Response) {
  if (!response.ok) throw new Error(`identity authority returned ${response.status}`)
  return response.json() as Promise<any>
}

export class HttpAuthentikOidc implements AuthentikOidc {
  constructor(private readonly config: {
    authorizationUrl: string
    tokenUrl: string
    userinfoUrl: string
    revocationUrl?: string
    clientId: string
    clientSecret: string
  }) {}

  authorizationUrl(input: { state: string; nonce: string; codeChallenge: string; redirectUri: string }) {
    const url = new URL(this.config.authorizationUrl)
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: input.redirectUri,
      scope: "openid profile email",
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
    }).toString()
    return url.toString()
  }

  async exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }) {
    return this.tokens(new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }))
  }

  async refresh(refreshToken: string) {
    return this.tokens(new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }))
  }

  async revoke(refreshToken: string) {
    if (!this.config.revocationUrl) return
    await fetch(this.config.revocationUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" }),
    })
  }

  private async tokens(form: URLSearchParams): Promise<OidcSession> {
    const token = await jsonResponse(await fetch(this.config.tokenUrl, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form,
    }))
    if (!token.access_token) throw new Error("Authentik token response omitted access_token")
    const info = await jsonResponse(await fetch(this.config.userinfoUrl, {
      headers: { authorization: `Bearer ${token.access_token}` },
    }))
    if (!info.sub) throw new Error("Authentik userinfo omitted sub")
    return {
      subject: String(info.sub),
      refreshToken: token.refresh_token ? String(token.refresh_token) : undefined,
      expiresAt: Date.now() + Math.max(1, Number(token.expires_in || 300)) * 1000,
    }
  }
}

export class HttpQaiPersonResolver implements QaiPersonResolver {
  constructor(private readonly endpoint: string, private readonly serviceToken: string) {}

  async resolveActivePerson(subject: string): Promise<ActiveQaiPerson | null> {
    if (!this.endpoint || !this.serviceToken) return null
    const url = new URL(this.endpoint)
    url.searchParams.set("authentik_sub", subject)
    const response = await fetch(url, { headers: { authorization: `Bearer ${this.serviceToken}` } })
    if (response.status === 404) return null
    const person = await jsonResponse(response)
    if (
      person.authentikSub !== subject ||
      person.classification !== "person" ||
      person.active !== true ||
      person.scimDeleted !== false ||
      !person.id
    ) return null
    return { subject, personId: String(person.id) }
  }
}
