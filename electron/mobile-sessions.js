const crypto = require('crypto')

// Each mobile browser gets its own voter worker so it has its own peerId in
// the Hyperswarm topic. The HTTP bridge identifies the browser via a cookie.
//
// A session goes through these states:
//   created -> awaiting (worker spawned, waiting for JOIN with topic)
//          -> joined (swarm joined for the requested topic)
//
// Lifecycle: workers are kept alive while the app runs. We do NOT recycle them
// per request — a long-lived worker means a stable peerId, which is required
// for vote-once semantics.

function defaultSnapshot() {
  return { role: 'voter', topic: '', poll: null, peers: 0, ready: false }
}

class MobileSessionManager {
  constructor({ pear, storage, workerSpecifier, app }) {
    this.pear = pear
    this.storage = storage
    this.workerSpecifier = workerSpecifier
    this.app = app
    this.sessions = new Map() // sid -> session
  }

  newSid() {
    return crypto.randomBytes(16).toString('hex')
  }

  hasSession(sid) {
    return this.sessions.has(sid)
  }

  getOrCreate(sid) {
    if (this.sessions.has(sid)) return this.sessions.get(sid)
    const config = JSON.stringify({ role: 'voter', pollConfig: null })
    const worker = this.pear.run(
      require.resolve('..' + this.workerSpecifier),
      [this.storage, config]
    )
    const session = {
      sid,
      worker,
      snapshot: defaultSnapshot(),
      buffer: '',
      pendingTopic: null,
      destroyed: false
    }
    const onIPC = (data) => this._onIPC(session, data)
    const onStderr = (data) => {
      // Surface for debugging; not noisy for normal flow.
      try {
        process.stderr.write('[mobile-worker ' + sid.slice(0, 6) + '] ' + data.toString())
      } catch {
      }
    }
    const onExit = () => {
      session.destroyed = true
      worker.removeListener('data', onIPC)
      worker.stderr.removeListener('data', onStderr)
      this.sessions.delete(sid)
    }
    const onBeforeQuit = () => {
      try { worker.destroy() } catch {
      }
    }
    worker.on('data', onIPC)
    worker.stderr.on('data', onStderr)
    worker.once('exit', onExit)
    if (this.app) this.app.on('before-quit', onBeforeQuit)
    this.sessions.set(sid, session)
    return session
  }

  _onIPC(session, data) {
    session.buffer += data.toString('utf8')
    const lines = session.buffer.split('\n')
    session.buffer = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        this._applyMessage(session, JSON.parse(line))
      } catch {
      }
    }
  }

  _applyMessage(session, message) {
    if (!message || typeof message.type !== 'string') return
    const prev = session.snapshot
    if (message.type === 'AWAITING_TOPIC') {
      session.snapshot = { ...prev, role: 'voter', ready: false }
      // If a JOIN was queued before the worker was ready, send it now.
      if (session.pendingTopic) {
        const key = session.pendingTopic
        session.pendingTopic = null
        this._writeToWorker(session, { type: 'JOIN', key })
      }
      return
    }
    if (message.type === 'READY') {
      session.snapshot = { ...prev, role: message.role || 'voter', topic: message.topic || prev.topic, peers: 0, ready: true }
      return
    }
    if (message.type === 'STATE') {
      session.snapshot = {
        role: message.role || prev.role || 'voter',
        topic: message.topic || prev.topic,
        poll: message.poll || null,
        peers: typeof message.peers === 'number' ? message.peers : prev.peers,
        ready: true
      }
      return
    }
    if (message.type === 'PEERS') {
      session.snapshot = {
        ...prev,
        peers: typeof message.count === 'number' ? message.count : prev.peers,
        topic: message.topic || prev.topic
      }
      return
    }
    if (message.type === 'PONG') {
      session.snapshot = {
        ...prev,
        topic: message.topic || prev.topic,
        peers: typeof message.peers === 'number' ? message.peers : prev.peers,
        poll: message.poll || prev.poll
      }
      return
    }
    if (message.type === 'error') {
      session.snapshot = { ...prev, lastError: message.message }
      return
    }
  }

  _writeToWorker(session, message) {
    if (session.destroyed) throw new Error('session worker destroyed')
    return session.worker.write(Buffer.from(JSON.stringify(message) + '\n'))
  }

  getSnapshot(sid) {
    const s = this.sessions.get(sid)
    if (!s) return defaultSnapshot()
    return s.snapshot
  }

  async join(sid, topicHex) {
    const session = this.getOrCreate(sid)
    if (!session.snapshot.ready) {
      // Worker hasn't sent AWAITING_TOPIC yet. Queue and dispatch on arrival.
      session.pendingTopic = topicHex
      return
    }
    // Worker may already be joined to a topic; if it's the same, no-op.
    if (session.snapshot.topic === topicHex) return
    await this._writeToWorker(session, { type: 'JOIN', key: topicHex })
  }

  async vote(sid, optionIndex) {
    const session = this.sessions.get(sid)
    if (!session) throw new Error('session not initialized')
    await this._writeToWorker(session, { type: 'CAST_VOTE', optionIndex })
  }

  async ping(sid) {
    const session = this.sessions.get(sid)
    if (!session) return
    try {
      await this._writeToWorker(session, { type: 'PING' })
    } catch {
    }
  }
}

module.exports = { MobileSessionManager }
