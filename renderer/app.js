const bridge = window.bridge
const decoder = new TextDecoder('utf-8')

const workers = {
	main: '/workers/main.js'
}

const statusEl = document.getElementById('status')
const topicEl = document.getElementById('topic')
const peersEl = document.getElementById('peers')
const topicInputEl = document.getElementById('topic-input')
const joinBtn = document.getElementById('join-btn')
const questionInputEl = document.getElementById('question-input')
const optionsInputEl = document.getElementById('options-input')
const timeoutInputEl = document.getElementById('timeout-input')
const createBtn = document.getElementById('create-btn')
const pollStateEl = document.getElementById('poll-state')
const pollBodyEl = document.getElementById('poll-body')
const eventsEl = document.getElementById('events')

let workerBuffer = ''
let latestRevision = -1

function shouldApplyMessageState(message) {
	const incomingRevision = Number(message?.revision)
	if (!Number.isFinite(incomingRevision)) return true
	if (incomingRevision < latestRevision) return false
	latestRevision = incomingRevision
	return true
}

function sendMessage(msg) {
	return bridge.writeWorkerIPC(workers.main, JSON.stringify(msg) + '\n')
}

function logEvent(text) {
	const li = document.createElement('li')
	li.textContent = text
	eventsEl.prepend(li)
}

function renderPoll(poll) {
	pollBodyEl.replaceChildren()

	if (!poll) {
		pollStateEl.textContent = 'No active poll'
		return
	}

	const options = Array.isArray(poll.options) ? poll.options : []
	const votes = poll && typeof poll.votes === 'object' && poll.votes ? poll.votes : {}
	const counts = Array.from({ length: options.length }, () => 0)
	for (const choice of Object.values(votes)) {
		if (Number.isInteger(choice) && choice >= 0 && choice < options.length) {
			counts[choice] += 1
		}
	}

	const ended = poll.status !== 'open'
	pollStateEl.textContent = ended ? 'Closed' : 'Open until ' + new Date(poll.endsAt).toLocaleTimeString()

	const title = document.createElement('div')
	title.innerHTML = '<strong>' + poll.question + '</strong>'
	pollBodyEl.appendChild(title)

	const meta = document.createElement('div')
	meta.className = 'muted'
	meta.textContent = 'Votes: ' + Object.values(votes).length + ' | Created by: ' + poll.createdBy
	pollBodyEl.appendChild(meta)

	const list = document.createElement('div')
	list.className = 'options'

	for (let index = 0; index < options.length; index++) {
		const option = options[index]
		const optionLabel = typeof option === 'string' ? option : option?.label
		const button = document.createElement('button')
		button.textContent = (optionLabel || 'Option ' + (index + 1)) + ' — ' + counts[index] + ' votes'
		button.disabled = ended
		button.onclick = async () => {
			statusEl.textContent = 'Voting...'
			await sendMessage({ type: 'CAST_VOTE', optionIndex: index })
		}
		list.appendChild(button)
	}

	pollBodyEl.appendChild(list)

	if (ended) {
		const closed = document.createElement('div')
		closed.className = 'muted'
		closed.textContent = 'Closed at ' + new Date(poll.closedAt || Date.now()).toLocaleTimeString()
		pollBodyEl.appendChild(closed)
	}
}

bridge.startWorker(workers.main)

const offWorkerStdout = bridge.onWorkerStdout(workers.main, (data) => {
	console.log('worker stdout', decoder.decode(data))
})

const offWorkerStderr = bridge.onWorkerStderr(workers.main, (data) => {
	console.error('worker stderr', decoder.decode(data))
})

const offWorkerIpc = bridge.onWorkerIPC(workers.main, (data) => {
	workerBuffer += decoder.decode(data)
	const lines = workerBuffer.split('\n')
	workerBuffer = lines.pop()

	for (const line of lines) {
		if (!line.trim()) continue

		let message
		try {
			message = JSON.parse(line)
		} catch (error) {
			statusEl.textContent = 'Bad worker message: ' + error.message
			continue
		}

		if (message.type === 'READY') {
			statusEl.textContent = 'Ready'
			topicEl.textContent = message.topic
			latestRevision = -1
			continue
		}

		if (message.type === 'STATE') {
			if (!shouldApplyMessageState(message)) {
				continue
			}
			statusEl.textContent = 'Synced'
			topicEl.textContent = message.topic
			peersEl.textContent = String(message.peers)
			renderPoll(message.poll)
			if (!autoRefreshInterval) {
				startAutoRefresh()
			}
			continue
		}

		if (message.type === 'PEERS') {
			peersEl.textContent = String(message.count)
			topicEl.textContent = message.topic
			continue
		}

		if (message.type === 'PONG') {
			if (!shouldApplyMessageState(message)) {
				continue
			}
			if (message.poll) {
				renderPoll(message.poll)
			}
			continue
		}

		if (message.type === 'error') {
			statusEl.textContent = 'Error: ' + message.message
			logEvent('error: ' + message.message)
			continue
		}

		if (message.type === 'PEER_CONNECTED') {
			logEvent('peer connected: ' + message.peer)
			continue
		}

		if (message.type === 'PEER_DISCONNECTED') {
			logEvent('peer disconnected: ' + message.peer)
			continue
		}
	}
})

const onWorkerExit = bridge.onWorkerExitSafe || bridge.onWorkerExit

const offWorkerExit = onWorkerExit(workers.main, (code) => {
	statusEl.textContent = 'Worker exited: ' + code
	offWorkerStdout()
	offWorkerStderr()
	offWorkerIpc()
	offWorkerExit()
})

let autoRefreshInterval = null

function startAutoRefresh() {
	if (autoRefreshInterval) clearInterval(autoRefreshInterval)
	autoRefreshInterval = setInterval(() => {
		sendMessage({ type: 'PING' }).catch(() => {})
	}, 500)
}

function stopAutoRefresh() {
	if (autoRefreshInterval) {
		clearInterval(autoRefreshInterval)
		autoRefreshInterval = null
	}
}

joinBtn.addEventListener('click', async () => {
	const raw = topicInputEl.value.trim()
	const match = raw.match(/[0-9a-fA-F]{64}/)
	const key = match ? match[0].toLowerCase() : ''
	if (!key) {
		statusEl.textContent = 'Paste a 64-char hex topic'
		return
	}

	statusEl.textContent = 'Joining...'
	await sendMessage({ type: 'JOIN', key })
	topicEl.textContent = key
})

createBtn.addEventListener('click', async () => {
	const question = questionInputEl.value.trim()
	const options = optionsInputEl.value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean)
	const timeoutSeconds = Number(timeoutInputEl.value)

	if (!question || options.length < 2 || !Number.isFinite(timeoutSeconds)) {
		statusEl.textContent = 'Fill question, at least 2 options and timeout'
		return
	}

	statusEl.textContent = 'Creating poll...'
	await sendMessage({
		type: 'CREATE_POLL',
		question,
		options,
		timeoutMs: timeoutSeconds * 1000
	})
})
