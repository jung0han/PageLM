import cors from "cors"
import server from "../utils/server/server"
import type { AuthentikOidc, QaiPersonResolver } from "../auth/types"
import { AuthService } from "../auth/service"
import { createRuntimeAuth } from "../auth/runtime"
import { authRoutes } from "../auth/routes"
import { config } from "../config/env"
import { registerRoutes } from "./router"
import { authenticationMiddleware, loggerMiddleware, websocketAuthentication } from "./middleware"

export type AppOptions = {
  auth?: AuthService
  oidc?: AuthentikOidc
  personResolver?: QaiPersonResolver
}

export function createApp(options: AppOptions = {}) {
  const app = server()
  const auth = options.auth || (options.oidc && options.personResolver
    ? new AuthService({
      oidc: options.oidc,
      personResolver: options.personResolver,
      redirectUri: `${config.baseUrl}/auth/callback`,
      frontendUrl: config.frontendUrl,
    })
    : createRuntimeAuth())

  app.use(loggerMiddleware)
  app.use(cors({
    origin: config.frontendUrl,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
    credentials: true,
  }))
  app.options("*", cors({ origin: config.frontendUrl, credentials: true }))
  app.use(authenticationMiddleware(auth))
  app.useWs(websocketAuthentication(auth))
  authRoutes(app, auth)
  registerRoutes(app)
  return app
}
