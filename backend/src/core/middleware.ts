import { AuthError, AuthService } from "../auth/service"

export function loggerMiddleware(req: any, _res: any, next: Function) {
  const now = new Date().toISOString()
  console.log(`[${now}] ${req.method} ${req.path}`)
  next()
}

const PUBLIC_PATHS = new Set([
  "/health/live",
  "/health/ready",
  "/auth/login",
  "/auth/callback",
  "/auth/refresh",
  "/auth/logout",
])

export function authenticationMiddleware(auth: AuthService) {
  return async (req: any, res: any, next: Function) => {
    if (req.method === "OPTIONS" || PUBLIC_PATHS.has(req.path)) return next()
    try {
      req.auth = await auth.authenticate(req.headers)
      next()
    } catch (error) {
      const known = error instanceof AuthError
      res.status(known ? error.statusCode : 503).send({
        ok: false,
        error: known ? error.code : "identity_authority_unavailable",
      })
    }
  }
}

export function websocketAuthentication(auth: AuthService) {
  return async (req: any) => {
    req.auth = await auth.authenticate(req.headers)
  }
}
