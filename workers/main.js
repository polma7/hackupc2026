const Hyperswarm = require('hyperswarm')

function randomBuffer(size) {
	const buf = Buffer.alloc(size)
	for (let i = 0; i < size; i++) {
		buf[i] = Math.floor(Math.random() * 256)
	}
	return buf
}

const state = {
	topic: randomBuffer(32),
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
	return state.topic.toString('hex')
}

function isHexTopic(value) {
	return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)
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
		topic: topicHex(),
		poll: pollClone,
		revision: state.revision,
		peers: state.connections.size
	})
}

function voteCount(poll) {
	if (!poll || !poll.votes) return 0
	return Object.keys(poll.votes).length
}

function shouldReplacePoll(currentPoll, incomingPoll) {
	if (!incomingPoll) return false
	if (!currentPoll) return true
	if (currentPoll.id !== incomingPoll.id) return false

	const currentVotes = voteCount(currentPoll)
	const incomingVotes = voteCount(incomingPoll)
	if (incomingVotes > currentVotes) return true
	if (incomingVotes < currentVotes) return false

	if (currentPoll.status === 'closed' && incomingPoll.status !== 'closed') return false
	if (incomingPoll.status === 'closed' && currentPoll.status !== 'closed') return true

	return (incomingPoll.closedAt || 0) >= (currentPoll.closedAt || 0)
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

	if (!cleanQuestion) {
		throw new Error('question is required')
	}
	if (cleanOptions.length < 2) {
		throw new Error('at least two options are required')
	}
	if (!Number.isFinite(duration) || duration < 5000) {
		throw new Error('timeout must be at least 5000 ms')
	}

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
	if (isCurrentPollOpen()) {
		throw new Error('there is already an active poll')
	}

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
	if (!isCurrentPollOpen()) {
		throw new Error('there is no active poll')
	}

	const optionIndex = Number(data.optionIndex)
	if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= state.currentPoll.options.length) {
		throw new Error('invalid optionIndex')
	}

	const previous = state.currentPoll.votes[voterId]
	state.currentPoll.votes[voterId] = optionIndex
	state.currentPoll.counts = computeCounts(state.currentPoll.votes, state.currentPoll.options.length)
	state.revision += 1

	if (broadcastChange) {
		broadcast({
			type: 'VOTE_CAST',
			pollId: state.currentPoll.id,
			voterId,
			optionIndex,
			previous,
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
		sendToConnection(state.connections.get(senderId), {
			type: 'STATE_SYNC',
			topic: topicHex(),
			poll: clonePoll(state.currentPoll)
		})
		return
	}

	if (message.type === 'STATE_SYNC') {
		if (!message.poll) return
		if (shouldReplacePoll(state.currentPoll, message.poll)) {
			const poll = { ...message.poll, timer: null }
			setCurrentPoll(poll)
			publishState()
		}
		return
	}

	if (message.type === 'CREATE_POLL') {
		if (isCurrentPollOpen()) {
			if (state.currentPoll && message.poll && state.currentPoll.id === message.poll.id) {
				if (shouldReplacePoll(state.currentPoll, message.poll)) {
					setCurrentPoll({ ...message.poll, timer: null })
					publishState()
				}
			}
			return
		}

		if (message.poll && message.poll.id) {
			const poll = { ...message.poll, timer: null }
			setCurrentPoll(poll)
			publishState()
			return
		}

		await createPoll(message, message.createdBy || senderId, false)
		return
	}

	if (message.type === 'VOTE_CAST') {
		if (!isCurrentPollOpen()) return
		if (message.pollId !== state.currentPoll.id) return
		await castVote(message, message.voterId || senderId, false)
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
		sendToConnection(connection, { type: 'STATE_SYNC', topic: topicHex(), poll: clonePoll(state.currentPoll) })
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

async function startSwarm(nextTopic) {
	await closeSwarm()
	if (state.currentPoll && state.currentPoll.timer) {
		clearTimeout(state.currentPoll.timer)
	}
	state.currentPoll = null
	state.revision = 0
	state.topic = nextTopic || randomBuffer(32)
	state.swarm = new Hyperswarm()
	state.swarm.on('connection', setupConnection)
	state.swarm.on('error', (error) => {
		send({ type: 'error', code: 'SWARM_ERROR', message: error.message })
	})
	state.discovery = state.swarm.join(state.topic, { client: true, server: true })
	state.ready = true
	send({ type: 'READY', topic: topicHex(), peerId: state.localPeerId })
	publishState()
}

async function handleLocalMessage(message) {
	if (!state.ready) {
		send({ type: 'error', code: 'NOT_READY', message: 'Worker is not ready yet' })
		return
	}

	if (message.type === 'JOIN') {
		const raw = typeof message.key === 'string' ? message.key.trim() : ''
		const match = raw.match(/[0-9a-fA-F]{64}/)
		const key = match ? match[0].toLowerCase() : ''
		if (!isHexTopic(key)) {
			send({ type: 'error', code: 'INVALID_KEY', message: 'Topic must be 64 hex characters' })
			return
		}
		await startSwarm(Buffer.from(key, 'hex'))
		return
	}

	if (message.type === 'CREATE_POLL') {
		await createPoll(message, state.localPeerId, true)
		return
	}

	if (message.type === 'CAST_VOTE') {
		await castVote(message, state.localPeerId, true)
		return
	}

	if (message.type === 'CLOSE_POLL') {
		await closePoll(message.reason || 'closed', true)
		return
	}

	if (message.type === 'PING') {
		send({
			type: 'PONG',
			topic: topicHex(),
			peerId: state.localPeerId,
			revision: state.revision,
			poll: clonePoll(state.currentPoll)
		})
		return
	}

	send({ type: 'error', code: 'UNKNOWN_TYPE', message: 'Use JOIN, CREATE_POLL, CAST_VOTE, CLOSE_POLL or PING' })
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
		await startSwarm(state.topic)
		console.log('[worker] voting swarm ready:', topicHex())
	} catch (error) {
		console.error('[worker] startup failed:', error.message)
		send({ type: 'error', code: 'STARTUP_FAILED', message: error.message })
	}
}

main()