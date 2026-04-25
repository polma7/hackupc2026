const bridge = window.bridge
const decoder = new TextDecoder('utf-8')

const workers = {
	main: '/workers/main.js'
}

const config = bridge.config ? bridge.config() : { role: 'voter', pollConfig: null }
const role = config.role === 'creator' ? 'creator' : 'voter'

const statusEl = document.getElementById('status')
const topicEl = document.getElementById('topic')
const topicHelpEl = document.getElementById('topic-help')
const topicHeadingEl = document.getElementById('topic-heading')
const topicCardEl = document.getElementById('topic-card')
const copyTopicBtn = document.getElementById('copy-topic-btn')
const peersEl = document.getElementById('peers')
const roleBadgeEl = document.getElementById('role-badge')
const joinCardEl = document.getElementById('join-card')
const topicInputEl = document.getElementById('topic-input')
const joinBtn = document.getElementById('join-btn')
const pollCardEl = document.getElementById('poll-card')
const pollStateEl = document.getElementById('poll-state')
const pollBodyEl = document.getElementById('poll-body')
const eventsEl = document.getElementById('events')

roleBadgeEl.textContent = role.toUpperCase()
roleBadgeEl.classList.add(role)

if (role === 'creator') {
	topicHeadingEl.textContent = 'Topic to share'
	topicHelpEl.textContent = 'Share this hash with voters by any channel (chat, QR, paper).'
	joinCardEl.classList.add('hidden')
} else {
	// Voter: hide topic card and poll card until they join.
	topicCardEl.classList.add('hidden')
	pollCardEl.classList.add('hidden')
	joinCardEl.classList.remove('hidden')
}

let workerBuffer = ''
let latestRevision = -1
let currentPoll = null
let joined = false

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
	li.textContent = new Date().toLocaleTimeString() + ' — ' + text
	eventsEl.prepend(li)
	while (eventsEl.children.length > 30) eventsEl.removeChild(eventsEl.lastChild)
}

function formatRemaining(ms) {
	if (!Number.isFinite(ms) || ms <= 0) return '0s'
	const total = Math.ceil(ms / 1000)
	const m = Math.floor(total / 60)
	const s = total % 60
	if (m > 0) return m + 'm ' + s.toString().padStart(2, '0') + 's'
	return s + 's'
}

function markJoined() {
	if (joined) return
	joined = true
	if (role === 'voter') {
		joinCardEl.classList.add('hidden')
		pollCardEl.classList.remove('hidden')
		topicCardEl.classList.remove('hidden')
		topicHeadingEl.textContent = 'Connected to topic'
		topicHelpEl.textContent =
			'You can re-share this hash with other voters even if the creator goes offline.'
	}
}

function renderPoll(poll) {
	currentPoll = poll
	pollBodyEl.replaceChildren()

	if (!poll) {
		pollStateEl.textContent =
			role === 'creator' ? 'Initializing poll...' : 'Waiting for an active poll...'
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

	const stateLine = document.createElement('span')
	if (ended) {
		stateLine.textContent = 'Closed at ' + new Date(poll.closedAt || Date.now()).toLocaleTimeString()
	} else {
		const remaining = (poll.endsAt || 0) - Date.now()
		stateLine.innerHTML =
			'Open — closes in <span class="countdown">' + formatRemaining(remaining) + '</span>'
	}
	pollStateEl.replaceChildren(stateLine)

	const title = document.createElement('div')
	title.innerHTML = '<strong>' + escapeHtml(poll.question) + '</strong>'
	pollBodyEl.appendChild(title)

	const totalVotes = Object.values(votes).length
	const meta = document.createElement('div')
	meta.className = 'muted'
	meta.textContent = 'Votes: ' + totalVotes + ' | Created by: ' + (poll.createdBy || '?').slice(0, 8)
	pollBodyEl.appendChild(meta)

	const list = document.createElement('div')
	list.className = 'options'

	const myPeerId = window.__myPeerId
	const alreadyVoted = !!myPeerId && myPeerId in votes
	const canVote = role === 'voter' && !ended && !alreadyVoted

	for (let index = 0; index < options.length; index++) {
		const option = options[index]
		const optionLabel = typeof option === 'string' ? option : option?.label
		const button = document.createElement('button')
		const label = optionLabel || 'Option ' + (index + 1)
		button.textContent = label + ' — ' + counts[index] + ' votes'
		button.disabled = !canVote
		if (alreadyVoted && votes[myPeerId] === index) {
			button.textContent = '✓ ' + button.textContent
		}
		button.onclick = async () => {
			if (!canVote) return
			statusEl.textContent = 'Voting...'
			await sendMessage({ type: 'CAST_VOTE', optionIndex: index })
		}
		list.appendChild(button)
	}

	pollBodyEl.appendChild(list)

	if (role === 'creator' && !ended) {
		const note = document.createElement('div')
		note.className = 'muted'
		note.style.marginTop = '8px'
		note.textContent = 'Creator node does not vote.'
		pollBodyEl.appendChild(note)
	}

	if (alreadyVoted && !ended) {
		const note = document.createElement('div')
		note.className = 'muted'
		note.style.marginTop = '8px'
		note.textContent = 'You already voted (one vote per peer).'
		pollBodyEl.appendChild(note)
	}
}

function escapeHtml(str) {
	return String(str).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
	)
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

		if (message.type === 'AWAITING_TOPIC') {
			window.__myPeerId = message.peerId
			statusEl.textContent = 'Waiting for hash'
			continue
		}

		if (message.type === 'READY') {
			statusEl.textContent = role === 'creator' ? 'Ready' : 'Joined'
			topicEl.textContent = message.topic
			window.__myPeerId = message.peerId
			latestRevision = -1
			markJoined()
			continue
		}

		if (message.type === 'STATE') {
			if (!shouldApplyMessageState(message)) continue
			statusEl.textContent = 'Synced'
			topicEl.textContent = message.topic
			peersEl.textContent = String(message.peers)
			markJoined()
			renderPoll(message.poll)
			if (!autoRefreshInterval) startAutoRefresh()
			continue
		}

		if (message.type === 'PEERS') {
			peersEl.textContent = String(message.count)
			topicEl.textContent = message.topic
			continue
		}

		if (message.type === 'PONG') {
			if (!shouldApplyMessageState(message)) continue
			peersEl.textContent = String(message.peers ?? peersEl.textContent)
			if (message.poll) renderPoll(message.poll)
			else renderPoll(null)
			continue
		}

		if (message.type === 'error') {
			statusEl.textContent = 'Error: ' + message.message
			logEvent('error: ' + message.message)
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
let countdownInterval = null

function startAutoRefresh() {
	if (autoRefreshInterval) clearInterval(autoRefreshInterval)
	autoRefreshInterval = setInterval(() => {
		sendMessage({ type: 'PING' }).catch(() => {})
	}, 500)

	if (countdownInterval) clearInterval(countdownInterval)
	countdownInterval = setInterval(() => {
		if (!currentPoll || currentPoll.status !== 'open') return
		const remaining = (currentPoll.endsAt || 0) - Date.now()
		const span = pollStateEl.querySelector('.countdown')
		if (span) span.textContent = formatRemaining(remaining)
	}, 250)
}

if (joinBtn) {
	joinBtn.addEventListener('click', async () => {
		const raw = topicInputEl.value.trim()
		const match = raw.match(/[0-9a-fA-F]{64}/)
		const key = match ? match[0].toLowerCase() : ''
		if (!key) {
			statusEl.textContent = 'Paste a 64-char hex hash'
			return
		}
		statusEl.textContent = 'Joining...'
		await sendMessage({ type: 'JOIN', key })
	})

	topicInputEl.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') joinBtn.click()
	})
}

if (copyTopicBtn) {
	copyTopicBtn.addEventListener('click', async () => {
		const text = topicEl.textContent.trim()
		if (!text || text === '...') return
		try {
			await navigator.clipboard.writeText(text)
			copyTopicBtn.textContent = 'Copied!'
			setTimeout(() => (copyTopicBtn.textContent = 'Copy hash'), 1500)
		} catch {
			copyTopicBtn.textContent = 'Copy failed'
		}
	})
}
