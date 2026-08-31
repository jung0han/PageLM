import fs from "fs"
import { getSharedAsset, getSharedMaterials, listSharedNamespaces } from "../../shared/snapshot"

export function sharedNamespaceRoutes(app: any) {
  app.get("/shared-namespaces", async (req: any, res: any) => {
    res.send({ ok: true, namespaces: await listSharedNamespaces({
      subject: req.auth.subject,
      organizationSubjects: req.auth.person.organizationSubjects,
    }) })
  })

  app.get("/shared-namespaces/:namespaceId/materials", async (req: any, res: any) => {
    const materials = await getSharedMaterials(req.params.namespaceId, {
      subject: req.auth.subject,
      organizationSubjects: req.auth.person.organizationSubjects,
    })
    if (!materials) return res.status(404).send({ error: "not found" })
    res.send({ ok: true, materials })
  })

  app.get("/shared-namespaces/:namespaceId/assets/:assetId", async (req: any, res: any) => {
    const asset = await getSharedAsset(req.params.namespaceId, req.params.assetId, {
      subject: req.auth.subject,
      organizationSubjects: req.auth.person.organizationSubjects,
    })
    if (!asset) return res.status(404).send({ error: "not found" })
    res.setHeader("Content-Type", asset.mimeType || "application/octet-stream")
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(asset.filename)}`)
    fs.createReadStream(asset.path).on("error", () => {
      if (!res.headersSent) res.status(404).send({ error: "not found" })
      else res.destroy()
    }).pipe(res)
  })
}
