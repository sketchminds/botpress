import Storage from './storage'
import { processEvent } from './middleware'
import { parseCsv, parseJson } from './csv_parse.js'
import multer from 'multer'
import { Parser as Json2csvParser } from 'json2csv'
import yn from 'yn'
import moment from 'moment'
import Promise from 'bluebird'

let storage
let logger

module.exports = {
  config: {
    qnaDir: { type: 'string', required: true, default: './qna', env: 'QNA_DIR' },
    textRenderer: { type: 'string', required: true, default: '#builtin_text', env: 'QNA_TEXT_RENDERER' }
  },
  async init(bp, configurator) {
    const config = await configurator.loadAll()
    storage = new Storage({ bp, config })
    await storage.initializeGhost()

    logger = bp.logger

    bp.middlewares.register({
      name: 'qna.incoming',
      module: 'botpress-qna',
      type: 'incoming',
      handler: async (event, next) => {
        if (!await processEvent(event, { bp, storage, logger, config })) {
          next()
        }
      },
      order: 11, // must be after the NLU middleware and before the dialog middleware
      description: 'Listen for predefined questions and send canned responses.'
    })
  },
  ready(bp) {
    bp.qna = {
      /**
       * Parses and imports questions; consecutive questions with similar answer get merged
       * @param {Array.<{question: String, action: String, answer: String}>}
       * @param {Object} options
       * @param {Boolean} [options.mergeRows = true] - whether consecutive questions with similar answer should be merged
       * @returns {Promise} Promise object represents an array of ids of imported questions
       */
      import(questions, { mergeRows = true }) {
        return Promise.each(parseJson(questions, { mergeRows }), question => storage.saveQuestion(question))
      },
      /**
       * @async
       * Fetches questions and represents them as json
       * @param {Object} options
       * @param {Boolean} [options.flatten = true] - whether multiple questions get split into multiple records
       * @returns {Array.<{question: String, action: String, answer: String}>}
       */
      async export({ flatten = true } = {}) {
        return (await storage.getQuestions()).flatMap(
          ({ data: { questions, answer: textAnswer, action, redirectFlow, redirectNode } }) => {
            const answer = action === 'text' ? textAnswer : [redirectFlow, redirectNode].filter(Boolean).join('#')
            if (!flatten) {
              return { questions, action, answer }
            }
            return questions.map(question => ({ question, action, answer }))
          }
        )
      }
    }

    const router = bp.getRouter('botpress-qna')

    router.get('/', async (req, res) => {
      try {
        res.send(await storage.getQuestions())
      } catch (e) {
        logger.error('QnA Error', e, e.stack)
        res.status(500).send(e.message || 'Error')
      }
    })

    router.post('/', async (req, res) => {
      try {
        const id = await storage.saveQuestion(req.body)
        res.send(id)
      } catch (e) {
        logger.error('QnA Error', e, e.stack)
        res.status(500).send(e.message || 'Error')
      }
    })

    router.put('/:question', async (req, res) => {
      try {
        await storage.saveQuestion(req.body, req.params.question)
        res.end()
      } catch (e) {
        logger.error('QnA Error', e, e.stack)
        res.status(500).send(e.message || 'Error')
      }
    })

    router.delete('/:question', async (req, res) => {
      try {
        await storage.deleteQuestion(req.params.question)
        res.end()
      } catch (e) {
        logger.error('QnA Error', e, e.stack)
        res.status(500).send(e.message || 'Error')
      }
    })

    router.get('/csv', async (req, res) => {
      res.setHeader('Content-Type', 'text/csv')
      res.setHeader('Content-disposition', `attachment; filename=qna_${moment().format('DD-MM-YYYY')}.csv`)
      const json2csvParser = new Json2csvParser({ fields: ['question', 'action', 'answer'], header: false })
      res.end(json2csvParser.parse(await bp.qna.export()))
    })

    const upload = multer()
    router.post('/csv', upload.single('csv'), async (req, res) => {
      if (yn(req.body.isReplace)) {
        const questions = await storage.getQuestions()
        await Promise.each(questions, ({ id }) => storage.deleteQuestion(id))
      }

      try {
        await Promise.each(parseCsv(req.file.buffer.toString()), question => storage.saveQuestion(question))
        res.end()
      } catch (e) {
        logger.error('QnA Error:', e)
        res.status(400).send(e.message || 'Error')
      }
    })
  }
}
