import { AuthError, AuthService } from "./service"

function fail(res: any, error: unknown) {
  const known = error instanceof AuthError
  const status = known ? error.statusCode : 502
  res.status(status).send({ ok: false, error: known ? error.code : "identity_authority_unavailable" })
}

export function authRoutes(app: any, auth: AuthService) {
  app.get("/auth/login", (req: any, res: any) => {
    try {
      const result = auth.beginLogin(typeof req.query.returnTo === "string" ? req.query.returnTo : undefined, req.headers)
      res.set("Set-Cookie", result.cookie).status(302).set("Location", result.location).send("")
    } catch (error) {
      fail(res, error)
    }
  })

  app.get("/auth/callback", async (req: any, res: any) => {
    try {
      const result = await auth.completeLogin(String(req.query.state || ""), String(req.query.code || ""), req.headers)
      res.set("Set-Cookie", result.cookies).status(302).set("Location", result.location).send("")
    } catch (error) {
      fail(res, error)
    }
  })

  app.post("/auth/refresh", async (req: any, res: any) => {
    try {
      const result = await auth.refresh(req.headers)
      res.set("Set-Cookie", result.cookie).send({ ok: true })
    } catch (error) {
      fail(res, error)
    }
  })

  app.post("/auth/logout", async (req: any, res: any) => {
    try {
      const cookie = await auth.logout(req.headers)
      res.set("Set-Cookie", cookie).status(204).send("")
    } catch (error) {
      fail(res, error)
    }
  })

  app.get("/auth/me", (req: any, res: any) => {
    res.send({ ok: true, person: { id: req.auth.person.personId } })
  })
}
