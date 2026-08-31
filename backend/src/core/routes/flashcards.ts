import db from '../../utils/database/keyv'
import crypto from 'crypto'
import {
  completeLearningArtifact,
  createLearningArtifact,
  getAuthorizedLearningArtifact,
  getLearningArtifact,
  resolveAssistantTurnOrigin,
} from '../../learning/artifacts'

async function canReadCard(id: string, ownerSubject: string) {
  const artifact = await getLearningArtifact('flashcards', id)
  return artifact ? !!await getAuthorizedLearningArtifact('flashcards', id, ownerSubject) : true
}

function publicCard(card: any) {
  const { ownerSubject: _owner, ...result } = card
  return result
}

export function flashcardRoutes(app: any) {
  app.post('/flashcards', async (req: any, res: any) => {
    try {
      const origin = await resolveAssistantTurnOrigin(req.body, req.auth.subject)
      if ((req.body?.chatId || req.body?.assistantTurnId) && !origin) return res.status(404).send({ error: 'not found' })
      const question = req.body?.question || (origin ? 'Review this assistant turn' : '')
      const answer = req.body?.answer || origin?.material
      const tag = req.body?.tag || (origin ? 'chat' : '')
      if (!question || !answer || !tag) return res.status(400).send({ error: 'question, answer, tag required' })
      const id = crypto.randomUUID()
      const ownerSubject = req.auth.subject
      const card = { id, question, answer, tag, created: Date.now(), ownerSubject }
      await createLearningArtifact(id, 'flashcards', ownerSubject, origin)
      let cards = await db.get(`flashcards:${ownerSubject}`) || []
      cards.push(card)
      await db.set(`flashcard:${id}`, card)
      await db.set(`flashcards:${ownerSubject}`, cards)
      const result = publicCard(card)
      await completeLearningArtifact('flashcards', id, { output: result })
      res.send({ ok: true, flashcard: result })
    } catch (e: any) {
      res.status(500).send({ ok: false, error: e?.message || 'failed' })
    }
  })

  app.get('/flashcards', async (req: any, res: any) => {
    try {
      const cards = await db.get(`flashcards:${req.auth.subject}`) || []
      const visible: any[] = []
      for (const card of cards) {
        if (await canReadCard(card.id, req.auth.subject)) visible.push(publicCard(card))
      }
      res.send({ ok: true, flashcards: visible })
    } catch (e: any) {
      res.status(500).send({ ok: false, error: e?.message || 'failed' })
    }
  })

  app.get('/flashcards/:id', async (req: any, res: any) => {
    const card = await db.get(`flashcard:${req.params.id}`) as any
    if (!card || card.ownerSubject !== req.auth.subject || !await canReadCard(card.id, req.auth.subject)) {
      return res.status(404).send({ error: 'not found' })
    }
    res.send({ ok: true, flashcard: publicCard(card) })
  })

  app.delete('/flashcards/:id', async (req: any, res: any) => {
    try {
      const id = req.params.id
      if (!id) return res.status(400).send({ error: 'id required' })
      const card = await db.get(`flashcard:${id}`)
      if (!card || card.ownerSubject !== req.auth.subject || !await canReadCard(id, req.auth.subject)) return res.status(404).send({ error: 'not found' })
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
