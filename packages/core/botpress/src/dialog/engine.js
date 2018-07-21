import _ from 'lodash'
import Promise from 'bluebird'
import { VM } from 'vm2'
import mware from 'mware'

const loggerShim = { debug: () => {} }
const callSubflowRegex = /(.+\.flow\.json)\s?@?\s?(.+)?/i // e.g. './login.flow.json' or './login.flow.json @ username'
const MAX_STACK_SIZE = 100

/** The Dialog Engine (or Dialog Manager) is the component that
 handles the flow logic. It it responsible for executing flows, including
 executing the actions and flowing to the nodes, redirections etc.
 @namespace DialogEngine
 @example
 bp.dialogEngine.processMessage(...)
 */
class DialogEngine {
  constructor({ flowProvider, stateManager, options, logger = loggerShim }) {
    Object.assign(this, { logger, flowProvider, stateManager })

    this.flowsLoaded = false
    this.flows = []
    this.defaultFlow = _.get(options, 'defaultFlow') || 'main.flow.json'
    this.outputProcessors = []
    this.errorHandlers = []
    this.actions = {}
    this.actionMetadataProviders = []

    /**
     * @typedef {Function} DialogEngine~DialogMiddleware
     * @param {object} ctx A mutable context object
     * @param {function} next Call this to continue processing
     */

    /**
     * Middleware triggered before a new session is started.
     * > **Note:** This middleware allows you to alter `ctx.flowName` to change
     * > which flow will be selected to start the conversation.
     * @function DialogEngine#onBeforeCreated
     * @param {DialogEngine~DialogMiddleware} middleware
     * @example
bp.dialogEngine.onBeforeCreated((ctx, next) => {
  ctx.flowName = 'example.flow.json'
  next()
})
     */
    this.onBeforeCreated = mware()

    /**
     * Middleware triggered **after** a new session is started.
     * `ctx` is not mutable.
     * @function DialogEngine#onAfterCreated
     * @param {DialogEngine~DialogMiddleware} middleware
     * @example
bp.dialogEngine.onAfterCreated((ctx, next) => {
  // Do something here
  next()
})
     */
    this.onAfterCreated = mware()

    /**
     * Middleware triggered **before** a conversation is ended for any reason.
     * `ctx` is not mutable.
     * @function DialogEngine#onBeforeEnd
     * @param {DialogEngine~DialogMiddleware} middleware
     * @example
bp.dialogEngine.onBeforeEnd((ctx, next) => {
  // Do something here
  next()
})
     */
    this.onBeforeEnd = mware()

    /**
     * Middleware triggered **before** a node is entered (before the `onEnter` execution).
     * > **⚠️ Warn:** It is **not** recommended to mutate `ctx.node` for now, it might break in a future version of Botpress.
     * @function DialogEngine#onBeforeNodeEnter
     * @param {DialogEngine~DialogMiddleware} middleware
     * @example
bp.dialogEngine.onBeforeNodeEnter((ctx, next) => {
  // Do something here
  next()
})
     */
    this.onBeforeNodeEnter = mware()

    /**
     * Middleware triggered **before** a conversation/session times out.
     * > **Note:** You can't prevent it from timing out at this point.
     * > You also can't change the timeout behavior/location at this time.
     * @function DialogEngine#onBeforeSessionTimeout
     * @param {DialogEngine~DialogMiddleware} middleware
     * @example
bp.dialogEngine.onBeforeSessionTimeout((ctx, next) => {
  // Do something here
  next()
})
     */
    this.onBeforeSessionTimeout = mware()

    flowProvider.on('flowsChanged', () => Object.assign(this, { flows: [], flowsLoaded: false }))
  }

  /**
   * Process a new incoming message from the user.
   * This will execute and run the flow until the flow ends or gets paused by user input
   * @param  {string} stateId The Id of the state.
   *                          This is usually unique per user/group/channel, depending on the platform.
   * @param  {BPIncomingEvent} event   The incoming event (message)
   * @return {Promise<State>}         Returns a promise that resolves with the new state
   *                                  when the flow is done processing
   */
  async processMessage(stateId, event) {
    try {
      if (!this.flowsLoaded) {
        await this.reloadFlows()
      }

      const context = await this._getOrCreateContext(stateId)
      let state = await this.stateManager.getState(stateId)

      if (event.type === 'bp_dialog_timeout') {
        state = await this._processTimeout(stateId, state, context, event)

        if (!_.isNil(state)) {
          await this.stateManager.setState(stateId, state)
        }

        return state
      }

      const msg = (event.text || '').substr(0, 20)
      this._trace('<~', 'RECV', `"${msg}"`, context, state)

      if (!context.currentFlow) {
        throw new Error('Expected currentFlow to be defined for stateId=' + stateId)
      }

      const catchAllOnReceive = _.get(context, 'currentFlow.catchAll.onReceive')

      if (catchAllOnReceive) {
        this._trace('!!', 'KALL', '', context, state)
        state = await this._processInstructions(catchAllOnReceive, state, event, context)
      }

      // If there's a 'next' defined in catchAll, this will try to match any condition and if it is matched it
      // will run the node defined in the next instead of the current context node
      const catchAllNext = _.get(context, 'currentFlow.catchAll.next')
      if (catchAllNext) {
        this._trace('..', 'KALL', '', context, state)
        for (let i = 0; i < catchAllNext.length; i++) {
          if (await this._evaluateCondition(catchAllNext[i].condition, state, event)) {
            return this._processNode(stateId, state, context, catchAllNext[i].node, event)
          }
        }

        this._trace('?X', 'KALL', '', context, state)
      }

      state = await this._processNode(stateId, state, context, context.node, event)

      if (!_.isNil(state)) {
        await this.stateManager.setState(stateId, state)
      }

      return state
    } catch (e) {
      this.errorHandlers.forEach(errorHandler => errorHandler(e))
    }
  }

  /**
   * Make the stateId jump to the specified flow and node
   * regardless of if there was already an active flow or not
   * in execution. If there was already an active flow executing,
   * this will override it. Note that by default, the current state
   * will be preserved; if you wish to reset the state as well,
   * set `resetState` to `true`.
   * Note that this will not continue processing, i.e. the user must send a message or
   * you should call {@link BotEngine#processMessage} manually to continue execution.
   * @example
   * // inside a bp.hear (...)
   * await bp.dialogEngine.jumpTo(stateId, 'main.flow.json')
   * await bp.dialogEngine.processMessage(stateId, event) // Continue processing
   * @param  {string} stateId  The stateId of the user/channel/group to make jump.
   * @param  {string} flowName The name of the flow, e.g. `main.flow.json`
   * @param  {string} [nodeName=null] The name of the node to jump to. Defaults to the flow's entry point.
   * @param  {boolean} [options.resetState=false] Whether or not the state should be reset
   */
  async jumpTo(stateId, flowName, nodeName = null, options) {
    options = Object.assign(
      {
        resetState: false
      },
      options
    )

    if (!this.flowsLoaded) {
      await this.reloadFlows()
    }

    const flow = this._findFlow(flowName, true)

    if (nodeName) {
      // We're just calling for throwing if doesn't exist
      DialogEngine._findNode(flow, nodeName, true)
    }

    await this._setContext(stateId, {
      currentFlow: flow,
      node: nodeName || flow.startNode,
      hasJumped: true,
      flowStack: [{ flow: flow.name, node: nodeName || flow.startNode }]
    })

    if (options.resetState) {
      await this.stateManager.setState(stateId, {})
    }
  }

  /**
   * Get the current flow and node for a specific stateId
   * @param  {string} stateId
   * @return {{ flow: string, node: string }} Returns the current flow and node
   */
  async getCurrentPosition(stateId) {
    const context = await this._getContext(stateId)

    if (context) {
      return {
        flow: context.currentFlow && context.currentFlow.name,
        node: context.node
      }
    }

    return {
      flow: null,
      node: null
    }
  }

  /**
   * Ends the flow for a specific stateId if there's an active flow,
   * otherwise does nothing.
   * @param  {string} stateId [description]
   */
  async endFlow(stateId) {
    return this._endFlow(stateId)
  }

  async reloadFlows() {
    this._trace('**', 'LOAD', '')
    this.flows = await this.flowProvider.loadAll()
    this.flowsLoaded = true
  }

  async getFlows() {
    if (!this.flowsLoaded) {
      await this.reloadFlows()
    }

    return this.flows
  }

  /**
   * Registers a new output processor (there can be many, which all get triggered on output).
   * @param {OutpoutProcessor} processor - Is an object with {id, send}
   * @param {string} processor.id - The unique id of the processor
   * @param {Function} processor.send - The `send` function of the processor
   * @returns {void}
   * @private
   */
  registerOutputProcessor(processor) {
    if (_.isNil(processor) || !_.isFunction(processor.send) || !_.isString(processor.id)) {
      throw new Error('Invalid processor. Processor must have a function `send` defined and a valid `id`')
    }

    // For now we only ever support a single output processor
    // We might want many output processors in the future, for example to hook up a debugger or a test suite
    this.outputProcessors = [processor]
  }

  /**
   * @typedef {object} DialogEngine~ActionMetadata
   * @var {string} title
   * @var {string} description
   * @var {boolean} required
   * @var {string} default
   * @var {string} type
   * @private
   */

  /**
   * A metadata provider returns metadata for an action or
   * returns null, in which case other providers will be called
   * @typedef {Function} DialogEngine~MetadataProvider
   * @param {string} action The name of the action
   * @returns {DialogEngine~ActionMetadata}
   * @private
   */

  /**
   * Adds a new provider of function metadata
   * @param {DialogEngine~MetadataProvider} provider
   * @returns {void}
   * @private
   */
  registerActionMetadataProvider(provider) {
    if (!_.isFunction(provider)) {
      throw new Error('Expected the function metadata provider to be a function')
    }

    if (!_.includes(this.actionMetadataProviders, provider)) {
      this.actionMetadataProviders.push(provider)
    }
  }

  /**
   * Introduce new actions to the Flows that they can call.
   * @param {Object} fnMap
   * @param {bool} [overwrite=false] - Whether or not it should overwrite existing actions with the same name.
   * Note that if overwrite is false, an error will be thrown on conflict.
   * @returns {Promise.<void>}
   */
  async registerActions(fnMap, overwrite = false) {
    const toRegister = {}
    _.keys(fnMap).forEach(name => {
      if (this.actions[name] && !overwrite) {
        throw new Error(`There is already a function named "${name}" registered`)
      }

      let handler = fnMap[name]
      let metadata = null

      if (!_.isFunction(fnMap[name])) {
        if (!_.isObject(fnMap[name]) || !_.isFunction(fnMap[name].handler)) {
          throw new Error(`Expected function "${name}" to be a function or an object with a 'hander' function`)
        }

        handler = fnMap[name].handler
        metadata = Object.assign({}, fnMap[name], { name: name, handler: null })
      }

      for (const provider of this.actionMetadataProviders) {
        const extra = provider(name)

        if (extra) {
          metadata = Object.assign({}, extra, metadata || {})
          break
        }
      }

      toRegister[name] = {
        name: name,
        metadata: metadata,
        fn: handler
      }
    })

    Object.assign(this.actions, toRegister)
  }

  /**
   * @deprecated Use registerActions() instead
   */
  async registerFunctions(fnMap, overwrite = false) {
    return this.registerActions(fnMap, overwrite)
  }

  /**
   * Returns all the available actions along with their metadata
   * @private
   */
  getAvailableActions() {
    return _.values(this.actions)
      .filter(x => !String(x.name).startsWith('__'))
      .map(x => Object.assign({}, x, { fn: null }))
  }

  onError = fn => this.errorHandlers.push(fn)

  async _processTimeout(stateId, userState, context, event) {
    const beforeCtx = { stateId }
    await Promise.fromCallback(callback => this.onBeforeSessionTimeout.run(beforeCtx, callback))

    const currentNodeTimeout = _.get(DialogEngine._findNode(context.currentFlow, context.node), 'timeoutNode')
    const currentFlowTimeout = _.get(context, 'currentFlow.timeoutNode')
    const fallbackTimeoutNode = DialogEngine._findNode(context.currentFlow, 'timeout')
    const fallbackTimeoutFlow = this._findFlow('timeout.flow.json')

    if (currentNodeTimeout) {
      this._trace('<>', 'SNDE', '', context)
      userState = await this._processNode(stateId, userState, context, currentNodeTimeout, event)
    } else if (currentFlowTimeout) {
      this._trace('<>', 'SFLW', '', context)
      userState = await this._processNode(stateId, userState, context, currentFlowTimeout, event)
    } else if (fallbackTimeoutNode) {
      this._trace('<>', 'DNDE', '', context)
      userState = await this._processNode(stateId, userState, context, fallbackTimeoutNode.name, event)
    } else if (fallbackTimeoutFlow) {
      this._trace('<>', 'DFLW', '', context)
      userState = await this._processNode(stateId, userState, context, fallbackTimeoutFlow.name, event)
    } else {
      this._trace('<>', 'NTHG', '', context)
      userState = await this._endFlow(stateId)
    }

    return userState
  }

  async _processNode(stateId, userState, context, nodeName, event) {
    let switchedFlow = false
    let switchedNode = false

    if (context.hasJumped) {
      context.hasJumped = false
      switchedNode = true
    }

    const originalFlow = context.currentFlow.name
    const originalNode = context.node

    if (callSubflowRegex.test(nodeName)) {
      this._trace('>>', 'FLOW', `"${nodeName}"`, context, null)
      context = this._gotoSubflow(nodeName, context)
      switchedFlow = true
    } else if (/^#/.test(nodeName)) {
      // e.g. '#success'
      this._trace('<<', 'FLOW', `"${nodeName}"`, context, null)
      context = this._gotoPreviousFlow(nodeName, context)
      switchedFlow = true
    } else if (context.node !== nodeName) {
      this._trace('>>', 'FLOW', `"${nodeName}"`)
      switchedNode = true
      context.node = nodeName
    } else if (_.isNil(context.node)) {
      // We just created the context
      switchedNode = true
      context.node = context.currentFlow.startNode
    }

    const node = DialogEngine._findNode(context.currentFlow, context.node)

    if (!node || !node.name) {
      userState = await this._endFlow(stateId)
      return userState
      // TODO Trace error
      throw new Error(`Could not find node "${context.node}" in flow "${context.currentFlow.name}"`)
    }

    if (switchedFlow || switchedNode) {
      context.flowStack.push({
        flow: context.currentFlow.name,
        node: context.node
      })

      // Flattens the stack to only include flow jumps, not node jumps
      context.flowStack = context.flowStack.filter((el, i) => {
        return i === context.flowStack.length - 1 || context.flowStack[i + 1].flow !== el.flow
      })

      if (context.flowStack.length >= MAX_STACK_SIZE) {
        throw new Error(
          `Exceeded maximum flow stack size (${MAX_STACK_SIZE}).
         This might be due to an unexpected infinite loop in your flows.
         Current flow: ${context.currentFlow.name}
         Current node: ${context.node}`
        )
        return this._endFlow(stateId)
      }

      await this._setContext(stateId, context)

      const beforeCtx = { stateId, node }
      await Promise.fromCallback(callback => this.onBeforeNodeEnter.run(beforeCtx, callback))

      if (node.onEnter) {
        this._trace('!!', 'ENTR', '', context, userState)
        userState = await this._processInstructions(node.onEnter, userState, event, context)
      }

      if (!node.onReceive) {
        this._trace('..', 'NOWT', '', context, userState)

        if (node.type === 'skill-call' && originalFlow !== node.flow) {
          userState = await this._processNode(stateId, userState, context, node.flow, event)
        } else {
          userState = await this._transitionToNextNodes(node, context, userState, stateId, event)
        }
      }
    } else {
      // i.e. we were already on that node before we received the message
      if (node.onReceive) {
        this._trace('!!', 'RECV', '', context, userState)
        userState = await this._processInstructions(node.onReceive, userState, event, context)
      }

      this._trace('..', 'RECV', '', context, userState)

      if (node.type === 'skill-call' && originalFlow !== node.flow) {
        userState = await this._processNode(stateId, userState, context, node.flow, event)
      } else {
        userState = await this._transitionToNextNodes(node, context, userState, stateId, event)
      }
    }

    return userState
  }

  async _transitionToNextNodes(node, context, userState, stateId, event) {
    const nextNodes = node.next || []
    for (let i = 0; i < nextNodes.length; i++) {
      if (await this._evaluateCondition(nextNodes[i].condition, userState, event)) {
        this._trace('??', 'MTCH', `cond = "${nextNodes[i].condition}"`, context)
        if (/^end$/i.test(nextNodes[i].node)) {
          // Node "END" or "end" ends the flow (reserved keyword)
          return this._endFlow(stateId)
        } else {
          return this._processNode(stateId, userState, context, nextNodes[i].node, event)
        }
      }
    }

    if (!nextNodes.length) {
      // You reach this if there were no next nodes, in which case we end the flow
      return this._endFlow(stateId)
    }

    return userState
  }

  async _endFlow(stateId) {
    const beforeCtx = { stateId }
    await Promise.fromCallback(callback => this.onBeforeEnd.run(beforeCtx, callback))

    this._trace('--', 'ENDF', '', null, null)
    await this.stateManager.deleteState(stateId, ['context'])

    return null
  }

  async _getOrCreateContext(stateId) {
    let state = await this._getContext(stateId)

    if (!state || !state.currentFlow) {
      const beforeCtx = { stateId, flowName: this.defaultFlow }
      await Promise.fromCallback(callback => this.onBeforeCreated.run(beforeCtx, callback))

      const flow = this._findFlow(beforeCtx.flowName, true)

      if (!flow) {
        throw new Error(`Could not find the default flow "${this.defaultFlow}"`)
      }

      state = {
        currentFlow: flow,
        flowStack: [{ flow: flow.name, node: flow.startNode }]
      }

      await this._setContext(stateId, state)

      const afterCtx = { ...beforeCtx }
      await Promise.fromCallback(callback => this.onAfterCreated.run(afterCtx, callback))
    }

    return state
  }

  _getContext(stateId) {
    return this.stateManager.getState(stateId + '___context')
  }

  _setContext(stateId, state) {
    return this.stateManager.setState(stateId + '___context', state)
  }

  _gotoSubflow(nodeName, context) {
    let [, subflow, subflowNode] = nodeName.match(callSubflowRegex)

    const flow = this._findFlow(subflow, true)

    if (_.isNil(subflowNode)) {
      subflowNode = flow.startNode
    }

    Object.assign(context, {
      currentFlow: flow,
      node: subflowNode
    })

    return context
  }

  _gotoPreviousFlow(nodeName, context) {
    if (!context.flowStack) {
      context.flowStack = []
    }

    while (context.currentFlow.name === _.get(_.last(context.flowStack), 'flow')) {
      context.flowStack.pop()
    }

    if (context.flowStack.length < 1) {
      this._trace('Flow tried to go back to previous flow but there was none. Exiting flow.', context, null)
      // TODO END FLOW
    } else {
      let { flow, node } = _.last(context.flowStack)

      if (nodeName !== '#') {
        node = nodeName.substr(1)
      }

      Object.assign(context, {
        currentFlow: this._findFlow(flow, true),
        node: node
      })
    }

    return context
  }

  async _processInstructions(instructions, userState, event, context) {
    if (!_.isArray(instructions)) {
      instructions = [instructions]
    }

    await Promise.mapSeries(instructions, async instruction => {
      if (_.isString(instruction) && instruction.startsWith('say ')) {
        const chunks = instruction.split(' ')
        const params = _.slice(chunks, 2).join(' ')

        if (chunks.length < 2) {
          this.trace('ERROR Invalid text instruction. Expected an instruction along "say #text Something"')
          return userState
        }

        await this._dispatchOutput(
          {
            type: chunks[1], // e.g. "#text" or "#!trivia-12342"
            value: params // e.g. Any additional parameter provided to the template
          },
          userState,
          event,
          context
        )
      } else {
        userState = await this._invokeAction(instruction, userState, event, context)
      }
    })

    return userState
  }

  async _dispatchOutput(output, userState, event, context) {
    const msg = String(output.type + (output.value || '')).substr(0, 20)
    this._trace('~>', 'SEND', `"${msg}"`)

    return Promise.map(this.outputProcessors, processor =>
      processor.send({ message: output, state: userState, originalEvent: event, flowContext: context })
    )
  }

  async _invokeAction(instruction, userState, event, context) {
    let name = null
    let args = {}

    if (_.isString(instruction)) {
      if (instruction.includes(' ')) {
        const chunks = instruction.split(' ')
        const argsStr = _.tail(chunks).join(' ')
        name = _.first(chunks)
        try {
          args = JSON.parse(argsStr)
          args = _.mapValues(args, value => {
            if (_.isString(value) && value.startsWith('{{') && value.endsWith('}}')) {
              const key = value.substr(2, value.length - 4)
              return _.get({ state: userState, s: userState, event: event, e: event }, key)
            }
            return value
          })
        } catch (err) {
          throw new Error('ERROR function has invalid arguments (not a valid JSON string): ' + argsStr)
        }
      } else {
        name = instruction
      }
    } else {
      this._trace(`ERROR function is not a valid string`)
    }

    if (!this.actions[name]) {
      this._trace(`ERROR function "${name}" not found`, context, userState)
    } else {
      try {
        this._trace('!!', 'EXEC', `func "${name}"`, context, userState)
        const ret = await this.actions[name].fn(Object.freeze(userState), event, args || {})

        if (ret && _.isObject(ret)) {
          if (Object.isFrozen(ret)) {
            this._trace(
              `ERROR function "${name}" returned the original (frozen) state. You should clone the state (see 'Object.assign()') instead of returning the original state.`,
              context,
              userState
            )
          } else {
            this._trace('!!', 'SSET', '', context)
            return ret
          }
        }
      } catch (err) {
        throw new Error(`ERROR function "${name}" thrown an error: ${err && err.message}`)
      }
    }

    return userState
  }

  async _evaluateCondition(condition, userState, event) {
    if (/^true|always|yes$/i.test(condition) || condition === '') {
      return true
    }

    const vm = new VM({
      timeout: 5000
    })

    _.keys(this.actions).forEach(name => {
      vm.freeze(this.actions[name].fn, name)
    })

    vm.freeze(userState, 's')
    vm.freeze(userState, 'state')
    vm.freeze(event, 'event')
    vm.freeze(event, 'e')

    try {
      return (await vm.run(condition)) == true
    } catch (err) {
      throw new Error(`ERROR evaluating condition "${condition}": ${err.message}`)
    }
  }

  static _findNode(flow, nodeName, throwIfNotFound = false) {
    if (throwIfNotFound && _.isNil(flow)) {
      throw new Error(`Could not find node ${nodeName} because the flow was not defined (null)`)
    }

    const node = _.find(flow.nodes, { name: nodeName })

    if (throwIfNotFound && _.isNil(nodeName)) {
      throw new Error(`Could not find node "${nodeName}" in flow "${flow.name}"`)
    }

    return node
  }

  _findFlow(flowName, throwIfNotFound = false) {
    const flow = _.find(this.flows, { name: flowName })

    if (throwIfNotFound && _.isNil(flow)) {
      throw new Error(`Could not find flow "${flowName}"`)
    }

    return flow
  }

  log(message, context, state) {
    const flow = (_.get(context, 'currentFlow.name') || 'NONE').replace(/\.flow\.json/i, '')
    const node = (context && context.node) || 'NONE'
    const msg = `Dialog: [${flow} – ${node}]\t${message}`
    this.logger.debug(msg)
  }

  /**
   * Dialog: [flow] (node) \t OP  RESN  "Description"
   * @param message
   * @param context
   * @param state
   * @private
   */
  _trace(operation, reason, message, context) {
    let flow = (_.get(context, 'currentFlow.name') || ' N/A ').replace(/\.flow\.json/i, '')
    let node = (context && context.node) || ' N/A '

    flow = flow.length > 13 ? flow.substr(0, 13) + '&' : flow
    node = node.length > 13 ? node.substr(0, 13) + '&' : node

    const spc = _.repeat(' ', 30 - flow.length - node.length)

    const msg = `Dialog: [${flow}] (${node}) ${spc} ${operation}  ${reason} \t ${message}`

    this.logger.debug(msg)
  }
}

module.exports = DialogEngine
