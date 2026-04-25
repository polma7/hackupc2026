const Hyperswarm = require('hyperswarm')

function randomBuffer(size) {
	const buf = Buffer.alloc(size)
	for (let i = 0; i < size; i++) {
		buf[i] = Math.floor(Math.random() * 256)
	}
	return buf
}

let bootConfig = { role: 'voter', pollConfig: null }
try {
	if (Bare.argv[3]) bootConfig = JSON.parse(Bare.argv[3])
} catch {
}

function isHexTopic(value) {
	return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)
}

const state = {
	role: bootConfig.role === 'creator' ? 'creator' : 'voter',
	pendingPollConfig: bootConfig.pollConfig || null,
	topic: null,
	localPeerId: randomBuffer(16).toString('hex'),
	swarm: null,
	discovery: null,
	connections: new Map(),
	currentPoll: null,
	revision: 0,
	ready: false,
	ipcBuffer: '',
	queue: Promise.resolve()
}

function send(message) {
	Bare.IPC.write(Buffer.from(JSON.stringify(message) + '\n'))
}

function topicHex() {
	return state.topic ? state.topic.toString('hex') : ''
}

function clonePoll(poll) {
	if (!poll) return null
	return {
		id: poll.id,
		question: poll.question,
		options: poll.options.map((option) => ({ ...option })),
		createdBy: poll.createdBy,
		createdAt: poll.createdAt,
		endsAt: poll.endsAt,
		status: poll.status,
		votes: { ...poll.votes },
		counts: [...poll.counts],
		closedAt: poll.closedAt || null
	}
}

function computeCounts(votes, optionsLength) {
	const counts = Array.from({ length: optionsLength }, () => 0)
	for (const choice of Object.values(votes)) {
		if (Number.isInteger(choice) && choice >= 0 && choice < optionsLength) {
			counts[choice] += 1
		}
	}
	return counts
}

function publishState() {
	const pollClone = clonePoll(state.currentPoll)
	send({
		type: 'STATE',
		role: state.role,
		topic: topicHex(),
		poll: pollClone,
		revision: state.revision,
		peers: state.connections.size
	})
}

// CRDT-style merge: union of votes, prefer first-seen choice per voter, closed wins.
function mergePolls(local, remote) {
	if (!remote) return local
	if (!local) return { ...remote, timer: null }
	if (local.id !== remote.id) {
		// Different polls. Prefer the open one; otherwise the older.
		if (local.status === 'open' && remote.status !== 'open') return local
		if (remote.status === 'open' && local.status !== 'open') return { ...remote, timer: null }
		return local.createdAt <= remote.createdAt ? local : { ...remote, timer: null }
	}

	const mergedVotes = { ...local.votes }
	for (const [voterId, choice] of Object.entries(remote.votes || {})) {
		if (!(voterId in mergedVotes)) mergedVotes[voterId] = choice
	}

	const closed = local.status === 'closed' || remote.status === 'closed'
	let closedAt = null
	if (closed) {
		const candidates = [local.closedAt, remote.closedAt].filter((v) => Number.isFinite(v))
		closedAt = candidates.length ? Math.min(...candidates) : Date.now()
	}

	return {
		...local,
		votes: mergedVotes,
		counts: computeCounts(mergedVotes, local.options.length),
		status: closed ? 'closed' : 'open',
		closedAt,
		timer: local.timer || null
	}
}

function pollsEqual(a, b) {
	if (a === b) return true
	if (!a || !b) return false
	if (a.id !== b.id) return false
	if (a.status !== b.status) return false
	if ((a.closedAt || null) !== (b.closedAt || null)) return false
	const aKeys = Object.keys(a.votes || {})
	const bKeys = Object.keys(b.votes || {})
	if (aKeys.length !== bKeys.length) return false
	for (const key of aKeys) {
		if (a.votes[key] !== b.votes[key]) return false
	}
	return true
}

function sendToConnection(connection, message) {
	try {
		connection.write(Buffer.from(JSON.stringify(message) + '\n'))
	} catch (error) {
		send({ type: 'error', code: 'WRITE_FAILED', message: error.message })
	}
}

function broadcast(message) {
	for (const connection of state.connections.values()) {
		sendToConnection(connection, message)
	}
}

function clearDiscovery() {
	if (!state.discovery) return
	try {
		state.discovery.destroy()
	} catch {
	}
	state.discovery = null
}

async function closeSwarm() {
	clearDiscovery()
	for (const connection of state.connections.values()) {
		try {
			connection.destroy()
		} catch {
		}
	}
	state.connections.clear()
	if (state.swarm) {
		try {
			await state.swarm.destroy()
		} catch {
		}
		state.swarm = null
	}
}

function schedulePollClose() {
	if (!state.currentPoll || state.currentPoll.status !== 'open') return
	if (state.currentPoll.timer) {
		clearTimeout(state.currentPoll.timer)
	}
	const remaining = Math.max(0, state.currentPoll.endsAt - Date.now())
	state.currentPoll.timer = setTimeout(() => {
		state.queue = state.queue
			.then(() => closePoll('timeout'))
			.catch((error) => {
				send({ type: 'error', code: 'TIMEOUT_FAILED', message: error.message })
			})
	}, remaining)
}

function setCurrentPoll(poll) {
	if (state.currentPoll && state.currentPoll.timer) {
		clearTimeout(state.currentPoll.timer)
	}
	state.currentPoll = poll
	state.revision += 1
	if (state.currentPoll && state.currentPoll.status === 'open') {
		schedulePollClose()
	}
}

function createPollPayload(question, options, timeoutMs) {
	const cleanQuestion = typeof question === 'string' ? question.trim() : ''
	const cleanOptions = Array.isArray(options)
		? options.map((option) => String(option).trim()).filter(Boolean)
		: []
	const duration = Number(timeoutMs)

	if (!cleanQuestion) throw new Error('question is required')
	if (cleanOptions.length < 2) throw new Error('at least two options are required')
	if (!Number.isFinite(duration) || duration < 5000) throw new Error('timeout must be at least 5000 ms')

	return {
		id: randomBuffer(16).toString('hex'),
		question: cleanQuestion,
		options: cleanOptions.map((label, index) => ({ id: String(index), label })),
		timeoutMs: duration
	}
}

function isCurrentPollOpen() {
	return !!state.currentPoll && state.currentPoll.status === 'open'
}

async function createPoll(data, createdBy, broadcastChange) {
	if (isCurrentPollOpen()) throw new Error('there is already an active poll')

	const payload = createPollPayload(data.question, data.options, data.timeoutMs)
	const now = Date.now()
	const poll = {
		id: payload.id,
		question: payload.question,
		options: payload.options,
		createdBy,
		createdAt: now,
		endsAt: now + payload.timeoutMs,
		status: 'open',
		votes: {},
		counts: Array.from({ length: payload.options.length }, () => 0),
		closedAt: null
	}

	setCurrentPoll(poll)
	if (broadcastChange) {
		broadcast({
			type: 'CREATE_POLL',
			poll: clonePoll(state.currentPoll),
			topic: topicHex()
		})
	}
	publishState()
}

async function castVote(data, voterId, broadcastChange) {
	if (state.role === 'creator') throw new Error('creator node cannot vote')
	if (!isCurrentPollOpen()) throw new Error('there is no active poll')

	const optionIndex = Number(data.optionIndex)
	if (
		!Number.isInteger(optionIndex) ||
		optionIndex < 0 ||
		optionIndex >= state.currentPoll.options.length
	) {
		throw new Error('invalid optionIndex')
	}

	// Vote-once semantics: keep first vote per voterId.
	if (voterId in state.currentPoll.votes) {
		// No change, but still publish (idempotent).
		publishState()
		return
	}

	state.currentPoll.votes[voterId] = optionIndex
	state.currentPoll.counts = computeCounts(
		state.currentPoll.votes,
		state.currentPoll.options.length
	)
	state.revision += 1

	if (broadcastChange) {
		broadcast({
			type: 'VOTE_CAST',
			pollId: state.currentPoll.id,
			voterId,
			optionIndex,
			topic: topicHex()
		})
	}
	publishState()
}

async function closePoll(reason, broadcastChange = true) {
	if (!state.currentPoll || state.currentPoll.status !== 'open') return
	if (state.currentPoll.timer) {
		clearTimeout(state.currentPoll.timer)
		state.currentPoll.timer = null
	}

	state.currentPoll.status = 'closed'
	state.currentPoll.closedAt = Date.now()
	state.revision += 1
	if (broadcastChange) {
		broadcast({
			type: 'POLL_CLOSED',
			pollId: state.currentPoll.id,
			reason,
			topic: topicHex(),
			poll: clonePoll(state.currentPoll)
		})
	}
	publishState()
}

async function handlePeerMessage(message, senderId) {
	if (!message || typeof message.type !== 'string') return

	if (message.type === 'HELLO') {
		const conn = state.connections.get(senderId)
		if (conn) {
			sendToConnection(conn, {
				type: 'STATE_SYNC',
				topic: topicHex(),
				poll: clonePoll(state.currentPoll)
			})
		}
		return
	}

	if (message.type === 'STATE_SYNC') {
		if (!message.poll) return
		const merged = mergePolls(state.currentPoll, message.poll)
		if (!pollsEqual(state.currentPoll, merged)) {
			setCurrentPoll(merged)
			publishState()
		}
		return
	}

	if (message.type === 'CREATE_POLL') {
		if (!message.poll || !message.poll.id) return
		if (!state.currentPoll) {
			setCurrentPoll({ ...message.poll, timer: null })
			publishState()
			return
		}
		const merged = mergePolls(state.currentPoll, message.poll)
		if (!pollsEqual(state.currentPoll, merged)) {
			setCurrentPoll(merged)
			publishState()
		}
		return
	}

	if (message.type === 'VOTE_CAST') {
		if (!isCurrentPollOpen()) return
		if (message.pollId !== state.currentPoll.id) return
		const voterId = message.voterId || senderId
		if (voterId in state.currentPoll.votes) return
		const optionIndex = Number(message.optionIndex)
		if (
			!Number.isInteger(optionIndex) ||
			optionIndex < 0 ||
			optionIndex >= state.currentPoll.options.length
		) return
		state.currentPoll.votes[voterId] = optionIndex
		state.currentPoll.counts = computeCounts(
			state.currentPoll.votes,
			state.currentPoll.options.length
		)
		state.revision += 1
		publishState()
		// Re-broadcast so the gossip reaches peers we are bridging to.
		broadcast({
			type: 'VOTE_CAST',
			pollId: state.currentPoll.id,
			voterId,
			optionIndex,
			topic: topicHex()
		})
		return
	}

	if (message.type === 'POLL_CLOSED') {
		if (!state.currentPoll || message.pollId !== state.currentPoll.id) return
		await closePoll(message.reason || 'closed', false)
		return
	}
}

function setupConnection(connection) {
	const connectionId = randomBuffer(16).toString('hex')
	state.connections.set(connectionId, connection)
	send({ type: 'PEERS', count: state.connections.size, topic: topicHex() })
	sendToConnection(connection, { type: 'HELLO', topic: topicHex(), peerId: state.localPeerId })
	if (state.currentPoll) {
		sendToConnection(connection, {
			type: 'STATE_SYNC',
			topic: topicHex(),
			poll: clonePoll(state.currentPoll)
		})
	}

	let buffer = ''
	connection.on('data', (chunk) => {
		buffer += chunk.toString()
		const lines = buffer.split('\n')
		buffer = lines.pop()
		for (const line of lines) {
			if (!line.trim()) continue
			let message = null
			try {
				message = JSON.parse(line)
			} catch (error) {
				send({ type: 'error', code: 'BAD_JSON', message: error.message })
				continue
			}
			state.queue = state.queue
				.then(() => handlePeerMessage(message, connectionId))
				.catch((error) => {
					send({ type: 'error', code: 'PEER_MESSAGE_FAILED', message: error.message })
				})
		}
	})

	connection.on('close', () => {
		state.connections.delete(connectionId)
		send({ type: 'PEERS', count: state.connections.size, topic: topicHex() })
	})

	connection.on('error', (error) => {
		send({ type: 'error', code: 'CONNECTION_ERROR', message: error.message })
	})
}

async function startSwarm(topic) {
	await closeSwarm()
	if (state.currentPoll && state.currentPoll.timer) {
		clearTimeout(state.currentPoll.timer)
	}
	state.currentPoll = null
	state.revision = 0
	if (!topic || topic.length !== 32) throw new Error('topic must be a 32-byte buffer')
	state.topic = topic
	state.swarm = new Hyperswarm()
	state.swarm.on('connection', (conn, info) => {
		console.error(
			'[worker] peer connected, relayed:',
			info.relayed,
			'topic:',
			topicHex().slice(0, 8)
		)
		setupConnection(conn)
	})
	state.swarm.on('error', (error) => {
		console.error('[worker] swarm error:', error.message)
		send({ type: 'error', code: 'SWARM_ERROR', message: error.message })
	})
	state.discovery = state.swarm.join(state.topic, { client: true, server: true })
	state.discovery
		.flushed()
		.then(() => {
			console.error('[worker] DHT lookup flushed, peers:', state.swarm.connections.size)
		})
		.catch((e) => {
			console.error('[worker] DHT flush error:', e.message)
		})
	state.ready = true
	send({ type: 'READY', role: state.role, topic: topicHex(), peerId: state.localPeerId })
	publishState()
}

async function handleLocalMessage(message) {
	if (message.type === 'JOIN') {
		if (state.role === 'creator') {
			send({ type: 'error', code: 'FORBIDDEN', message: 'creator does not join external topics' })
			return
		}
		const raw = typeof message.key === 'string' ? message.key.trim() : ''
		const match = raw.match(/[0-9a-fA-F]{64}/)
		const key = match ? match[0].toLowerCase() : ''
		if (!isHexTopic(key)) {
			send({ type: 'error', code: 'INVALID_KEY', message: 'topic must be 64 hex characters' })
			return
		}
		await startSwarm(Buffer.from(key, 'hex'))
		return
	}

	if (!state.ready) {
		send({ type: 'error', code: 'NOT_READY', message: 'Worker is not ready yet' })
		return
	}

	if (message.type === 'CREATE_POLL') {
		if (state.role !== 'creator') {
			send({ type: 'error', code: 'FORBIDDEN', message: 'only creator can create polls' })
			return
		}
		await createPoll(message, state.localPeerId, true)
		return
	}

	if (message.type === 'CAST_VOTE') {
		if (state.role === 'creator') {
			send({ type: 'error', code: 'FORBIDDEN', message: 'creator cannot vote' })
			return
		}
		await castVote(message, state.localPeerId, true)
		return
	}

	if (message.type === 'CLOSE_POLL') {
		if (state.role !== 'creator') {
			send({ type: 'error', code: 'FORBIDDEN', message: 'only creator can force-close' })
			return
		}
		await closePoll(message.reason || 'closed', true)
		return
	}

	if (message.type === 'PING') {
		send({
			type: 'PONG',
			topic: topicHex(),
			peerId: state.localPeerId,
			revision: state.revision,
			role: state.role,
			peers: state.connections.size,
			poll: clonePoll(state.currentPoll)
		})
		return
	}

	send({ type: 'error', code: 'UNKNOWN_TYPE', message: 'Unsupported message type' })
}

Bare.IPC.on('data', (chunk) => {
	state.ipcBuffer += chunk.toString()
	const lines = state.ipcBuffer.split('\n')
	state.ipcBuffer = lines.pop()

	for (const line of lines) {
		if (!line.trim()) continue
		let message = null
		try {
			message = JSON.parse(line)
		} catch (error) {
			send({ type: 'error', code: 'BAD_JSON', message: error.message })
			continue
		}

		state.queue = state.queue
			.then(() => handleLocalMessage(message))
			.catch((error) => {
				send({ type: 'error', code: 'INTERNAL', message: error.message })
			})
	}
})

async function main() {
	try {
		if (state.role === 'creator') {
			await startSwarm(randomBuffer(32))
			console.log('[worker] creator swarm ready:', topicHex())
			if (state.pendingPollConfig) {
				try {
					await createPoll(state.pendingPollConfig, state.localPeerId, true)
					console.log('[worker] creator auto-created poll:', state.currentPoll.id)
				} catch (error) {
					send({ type: 'error', code: 'AUTOPOLL_FAILED', message: error.message })
				}
				state.pendingPollConfig = null
			}
		} else {
			// Voter: do not join any swarm yet. UI must call JOIN with the hash.
			send({ type: 'AWAITING_TOPIC', role: 'voter', peerId: state.localPeerId })
			console.log('[worker] voter awaiting topic')
		}
	} catch (error) {
		console.error('[worker] startup failed:', error.message)
		send({ type: 'error', code: 'STARTUP_FAILED', message: error.message })
	}
}

main()
