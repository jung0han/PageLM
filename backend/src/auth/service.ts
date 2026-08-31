import { createHash, randomBytes } from "crypto"
import type { AuthenticatedRequest, AuthentikOidc, QaiPersonResolver } from "./types"

export class AuthError extends Error {
  constructor(public statusCode: number, public code: string) {
    super(code)
  }
}

type LoginTransaction = {
  nonce: string
  codeVerifier: string
  redirectTo: string
  expiresAt: number
}

type BrowserSession = {
  subject: string
  refreshToken?: string
  expiresAt: number
  refreshUntil: number
}

export type AuthServiceOptions = {
  oidc: AuthentikOidc
  personResolver: QaiPersonResolver
  redirectUri: string
  frontendUrl: string
  cookieName?: string
  sessionTtlMs?: number
  refreshTtlMs?: number
  now?: () => number
}

const IDENTITY_HEADERS = [
  "x-authentik-username",
  "x-authentik-email",
  "x-authentik-name",
  "x-authentik-groups",
  "x-forwarded-user",
  "x-forwarded-email",
  "x-user",
  "x-user-id",
  "remote-user",
]

function opaque(): string {
  return randomBytes(32).toString("base64url")
}

function cookieValue(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = String(headers.cookie || "")
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=")
    if (key === name) return value.join("=") || undefined
  }
  return undefined
}

function safeReturnTo(input: string | undefined): string {
  if (!input || !input.startsWith("/") || input.startsWith("//")) return "/"
  return input
}

export class AuthService {
  readonly cookieName: string
  readonly loginCookieName: string
  private readonly sessions = new Map<string, BrowserSession>()
  private readonly transactions = new Map<string, LoginTransaction>()
  private readonly now: () => number
  private readonly sessionTtlMs: number
  private readonly refreshTtlMs: number

  constructor(private readonly options: AuthServiceOptions) {
    this.cookieName = options.cookieName || "pagelm_session"
    this.loginCookieName = `${this.cookieName}_login`
    this.now = options.now || Date.now
    this.sessionTtlMs = options.sessionTtlMs || 30 * 60_000
    this.refreshTtlMs = options.refreshTtlMs || 7 * 24 * 60 * 60_000
  }

  beginLogin(returnTo?: string, headers: Record<string, unknown> = {}) {
    this.assertOpaqueCookieRequest(headers)
    this.purgeExpired()
    const state = opaque()
    const nonce = opaque()
    const codeVerifier = opaque()
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url")
    this.transactions.set(state, {
      nonce,
      codeVerifier,
      redirectTo: safeReturnTo(returnTo),
      expiresAt: this.now() + 5 * 60_000,
    })
    return {
      location: this.options.oidc.authorizationUrl({ state, nonce, codeChallenge, redirectUri: this.options.redirectUri }),
      cookie: this.loginCookie(state),
    }
  }

  async completeLogin(state: string, code: string, headers: Record<string, unknown> = {}) {
    this.assertOpaqueCookieRequest(headers)
    const transaction = this.transactions.get(state)
    this.transactions.delete(state)
    if (
      !transaction ||
      transaction.expiresAt <= this.now() ||
      !code ||
      cookieValue(headers, this.loginCookieName) !== state
    ) throw new AuthError(401, "invalid_login")
    const upstream = await this.options.oidc.exchangeCode({
      code,
      codeVerifier: transaction.codeVerifier,
      redirectUri: this.options.redirectUri,
    })
    const person = await this.resolve(upstream.subject)
    const id = opaque()
    const now = this.now()
    this.sessions.set(id, {
      subject: upstream.subject,
      refreshToken: upstream.refreshToken,
      expiresAt: Math.min(upstream.expiresAt, now + this.sessionTtlMs),
      refreshUntil: now + this.refreshTtlMs,
    })
    return {
      cookies: [
        this.sessionCookie(id, Math.max(0, Math.floor((Math.min(upstream.expiresAt, now + this.sessionTtlMs) - now) / 1000))),
        this.clearLoginCookie(),
      ],
      location: new URL(transaction.redirectTo, this.options.frontendUrl).toString(),
      person,
    }
  }

  async authenticate(headers: Record<string, unknown>): Promise<AuthenticatedRequest> {
    this.assertOpaqueCookieRequest(headers)
    const id = cookieValue(headers, this.cookieName)
    const session = id ? this.sessions.get(id) : undefined
    if (!session || session.expiresAt <= this.now()) throw new AuthError(401, "authentication_required")
    const person = await this.resolve(session.subject)
    return { subject: session.subject, person, expiresAt: session.expiresAt }
  }

  async refresh(headers: Record<string, unknown>) {
    this.assertOpaqueCookieRequest(headers)
    const oldId = cookieValue(headers, this.cookieName)
    const old = oldId ? this.sessions.get(oldId) : undefined
    if (!old || !old.refreshToken || old.refreshUntil <= this.now()) throw new AuthError(401, "refresh_required")
    const upstream = await this.options.oidc.refresh(old.refreshToken)
    if (!upstream.subject || upstream.subject !== old.subject) {
      this.sessions.delete(oldId!)
      throw new AuthError(403, "subject_mismatch")
    }
    await this.resolve(old.subject)
    const now = this.now()
    const expiresAt = Math.min(upstream.expiresAt, now + this.sessionTtlMs)
    const id = opaque()
    this.sessions.delete(oldId!)
    this.sessions.set(id, {
      subject: old.subject,
      refreshToken: upstream.refreshToken || old.refreshToken,
      expiresAt,
      refreshUntil: old.refreshUntil,
    })
    return { cookie: this.sessionCookie(id, Math.max(0, Math.floor((expiresAt - now) / 1000))) }
  }

  async logout(headers: Record<string, unknown>) {
    this.assertOpaqueCookieRequest(headers)
    const id = cookieValue(headers, this.cookieName)
    const session = id ? this.sessions.get(id) : undefined
    if (id) this.sessions.delete(id)
    if (session?.refreshToken) await this.options.oidc.revoke(session.refreshToken).catch(() => undefined)
    return this.clearCookie()
  }

  assertOpaqueCookieRequest(headers: Record<string, unknown>) {
    if (headers.authorization || IDENTITY_HEADERS.some(name => headers[name] !== undefined)) {
      throw new AuthError(401, "browser_credentials_not_accepted")
    }
  }

  private purgeExpired() {
    const now = this.now()
    for (const [state, transaction] of this.transactions) {
      if (transaction.expiresAt <= now) this.transactions.delete(state)
    }
    for (const [id, session] of this.sessions) {
      if (session.refreshUntil <= now) this.sessions.delete(id)
    }
  }

  private async resolve(subject: string) {
    if (!subject) throw new AuthError(403, "not_a_learning_user")
    const person = await this.options.personResolver.resolveActivePerson(subject)
    if (!person || person.subject !== subject || !person.personId) throw new AuthError(403, "not_a_learning_user")
    return person
  }

  private sessionCookie(value: string, maxAge: number) {
    return `${this.cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
  }

  private loginCookie(value: string) {
    return `${this.loginCookieName}=${value}; Path=/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=300`
  }

  private clearLoginCookie() {
    return `${this.loginCookieName}=; Path=/auth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  }

  private clearCookie() {
    return `${this.cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  }
}
