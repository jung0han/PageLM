import db from '../../utils/database/keyv'

export function flashcardRoutes(app: any) {
  app.post('/flashcards', async (req: any, res: any) => {
    try {
      const { question, answer, tag } = req.body
      if (!question || !answer || !tag) return res.status(400).send({ error: 'question, answer, tag required' })
      const id = crypto.randomUUID()
      const ownerSubject = req.auth.subject
      const card = { id, question, answer, tag, created: Date.now(), ownerSubject }
      let cards = await db.get(`flashcards:${ownerSubject}`) || []
      cards.push(card)
      await db.set(`flashcard:${id}`, card)
      await db.set(`flashcards:${ownerSubject}`, cards)
      const { ownerSubject: _owner, ...result } = card
      res.send({ ok: true, flashcard: result })
    } catch (e: any) {
      res.status(500).send({ ok: false, error: e?.message || 'failed' })
    }
  })

  app.get('/flashcards', async (req: any, res: any) => {
    try {
      const cards = await db.get(`flashcards:${req.auth.subject}`) || []
      res.send({ ok: true, flashcards: cards.map(({ ownerSubject: _owner, ...card }: any) => card) })
    } catch (e: any) {
      res.status(500).send({ ok: false, error: e?.message || 'failed' })
    }
  })

  app.delete('/flashcards/:id', async (req: any, res: any) => {
    try {
      const id = req.params.id
      if (!id) return res.status(400).send({ error: 'id required' })
      const card = await db.get(`flashcard:${id}`)
      if (!card || card.ownerSubject !== req.auth.subject) return res.status(404).send({ error: 'not found' })
      await db.delete(`flashcard:${id}`)
      let cards = await db.get(`flashcards:${req.auth.subject}`) || []
      cards = cards.filter((c: any) => c.id !== id)
      await db.set(`flashcards:${req.auth.subject}`, cards)
      res.send({ ok: true })
    } catch (e: any) {
      res.status(500).send({ ok: false, error: e?.message || 'failed' })
    }
  })
}
