const bridge = window.bridge
const decoder = new TextDecoder('utf-8')

const workers = { main: '/workers/main.js' }

const config = bridge.config ? bridge.config() : { role: 'voter', pollConfig: null }
const role = config.role === 'creator' ? 'creator' : 'voter'

// ── DOM refs ──────────────────────────────────────────────────────────────────
const statusEl        = document.getElementById('status')
const topicEl         = document.getElementById('topic')
const topicHelpEl     = document.getElementById('topic-help')
const topicHeadingEl  = document.getElementById('topic-heading')
const topicCardEl     = document.getElementById('topic-card')
const copyTopicBtn    = document.getElementById('copy-topic-btn')
const peersEl         = document.getElementById('peers')
const roleBadgeEl     = document.getElementById('role-badge')
const joinCardEl      = document.getElementById('join-card')
const topicInputEl    = document.getElementById('topic-input')
const joinBtn         = document.getElementById('join-btn')
const pollCardEl      = document.getElementById('poll-card')
const pollStateEl     = document.getElementById('poll-state')
const pollBodyEl      = document.getElementById('poll-body')
const eventsEl        = document.getElementById('events')
const mobileCardEl    = document.getElementById('mobile-card')
const mobileUrlEl     = document.getElementById('mobile-url')
const mobileQrEl      = document.getElementById('mobile-qr')
const copyMobileUrlBtn = document.getElementById('copy-mobile-url-btn')

// ── Create-poll form refs ─────────────────────────────────────────────────────
const createPollCardEl  = document.getElementById('create-poll-card')
const pollQuestionEl    = document.getElementById('poll-question')
const pollOptionsListEl = document.getElementById('poll-options-list')
const addOptionBtn      = document.getElementById('add-option-btn')
const pollTimeoutEl     = document.getElementById('poll-timeout')
const createPollBtn     = document.getElementById('create-poll-btn')
const createPollErrorEl = document.getElementById('create-poll-error')

// ── Certificate overlay DOM refs ──────────────────────────────────────────────
const certOverlayEl   = document.getElementById('cert-overlay')
const certFileArea    = document.getElementById('cert-file-area')
const certFileInput   = document.getElementById('cert-file-input')
const certFileNameEl  = document.getElementById('cert-file-name')
const certPasswordEl  = document.getElementById('cert-password')
const certVerifyBtn   = document.getElementById('cert-verify-btn')
const certStatusEl    = document.getElementById('cert-status')
const identityBadgeEl = document.getElementById('identity-badge')
const identityNameEl  = document.getElementById('identity-name')
const identityMetaEl  = document.getElementById('identity-meta')

// ── Certificate verification ──────────────────────────────────────────────────
let certIdentity = null
let selectedP12Buffer = null

certFileArea.addEventListener('click', () => certFileInput.click())

certFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0]
  if (!file) return
  certFileNameEl.textContent = file.name
  certFileArea.classList.add('has-file')
  certStatusEl.textContent = ''
  certStatusEl.style.color = ''
  const reader = new FileReader()
  reader.onload = (ev) => {
    selectedP12Buffer = ev.target.result
    certVerifyBtn.disabled = !certPasswordEl.value.trim()
  }
  reader.readAsArrayBuffer(file)
})

certPasswordEl.addEventListener('input', () => {
  certVerifyBtn.disabled = !selectedP12Buffer || !certPasswordEl.value.trim()
})

certPasswordEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !certVerifyBtn.disabled) certVerifyBtn.click()
})

certVerifyBtn.addEventListener('click', async () => {
  certVerifyBtn.disabled = true
  certStatusEl.textContent = 'Verifying certificate...'
  certStatusEl.style.color = '#aaa'

  try {
    const result = await bridge.verifyCert(selectedP12Buffer, certPasswordEl.value)

    if (result.ok) {
      certIdentity = result

      identityNameEl.textContent = result.name || 'Name unavailable'
      identityMetaEl.textContent = [
        result.nif ? 'NIF: ' + result.nif : null,
        result.issuer ? 'Issued by: ' + result.issuer : null,
      ].filter(Boolean).join(' · ')
      identityBadgeEl.classList.remove('hidden')

      certStatusEl.textContent = '✓ Identity verified successfully'
      certStatusEl.style.color = '#4caf50'

      setTimeout(() => {
        certOverlayEl.style.display = 'none'
        logEvent('Identity verified: ' + (result.name || result.nif || 'unknown'))
      }, 1000)
    } else {
      certStatusEl.textContent = '✗ ' + (result.error || 'Verification failed')
      certStatusEl.style.color = '#f44336'
      certVerifyBtn.disabled = false
    }
  } catch (e) {
    certStatusEl.textContent = '✗ Unexpected error: ' + e.message
    certStatusEl.style.color = '#f44336'
    certVerifyBtn.disabled = false
  }
})

// ── Role setup ────────────────────────────────────────────────────────────────
roleBadgeEl.textContent = role.toUpperCase()
roleBadgeEl.classList.add(role)

// ── Create-poll form (creator only) ───────────────────────────────────────────
const MAX_OPTIONS = 8
const MIN_OPTIONS = 2

if (role === 'creator') {
  topicHeadingEl.textContent = 'Topic to share'
  topicHelpEl.textContent = 'Share this hash with voters by any channel (chat, QR, paper).'
  joinCardEl.classList.add('hidden')
  setupCreatePollForm()
} else {
  topicCardEl.classList.add('hidden')
  pollCardEl.classList.add('hidden')
  joinCardEl.classList.remove('hidden')
}

function renumberOptionRows() {
  const rows = pollOptionsListEl.querySelectorAll('.poll-option-row')
  rows.forEach((row, i) => {
    const bullet = row.querySelector('.poll-option-bullet')
    if (bullet) bullet.textContent = String(i + 1).padStart(2, '0')
    const removeBtn = row.querySelector('.poll-option-remove')
    if (removeBtn) removeBtn.disabled = rows.length <= MIN_OPTIONS
  })
  if (addOptionBtn) addOptionBtn.disabled = rows.length >= MAX_OPTIONS
}

function addOptionRow(value = '') {
  const row = document.createElement('div')
  row.className = 'poll-option-row'

  const bullet = document.createElement('span')
  bullet.className = 'poll-option-bullet'

  const input = document.createElement('input')
  input.className = 'poll-option-input'
  input.type = 'text'
  input.placeholder = 'Option text'
  input.maxLength = 80
  input.value = value
  input.autocomplete = 'off'

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'poll-option-remove'
  remove.textContent = '×'
  remove.title = 'Remove option'
  remove.addEventListener('click', () => {
    if (pollOptionsListEl.children.length <= MIN_OPTIONS) return
    row.remove()
    renumberOptionRows()
  })

  row.appendChild(bullet)
  row.appendChild(input)
  row.appendChild(remove)
  pollOptionsListEl.appendChild(row)
  renumberOptionRows()
}

function getCurrentOptionValues() {
  return Array.from(pollOptionsListEl.querySelectorAll('.poll-option-input'))
    .map((i) => i.value.trim())
}

function setupCreatePollForm() {
  if (!createPollCardEl) return
  pollOptionsListEl.replaceChildren()
  for (let i = 0; i < MIN_OPTIONS; i++) addOptionRow()

  addOptionBtn.addEventListener('click', () => {
    if (pollOptionsListEl.children.length >= MAX_OPTIONS) return
    addOptionRow()
  })

  createPollBtn.addEventListener('click', async () => {
    const question = pollQuestionEl.value.trim()
    const options = getCurrentOptionValues().filter(Boolean)
    const seconds = Number(pollTimeoutEl.value)

    createPollErrorEl.textContent = ''

    if (!question) {
      createPollErrorEl.textContent = 'Please enter a question.'
      return
    }
    if (options.length < MIN_OPTIONS) {
      createPollErrorEl.textContent = 'At least two non-empty options are required.'
      return
    }
    if (!Number.isFinite(seconds) || seconds < 5) {
      createPollErrorEl.textContent = 'Duration must be at least 5 seconds.'
      return
    }

    createPollBtn.disabled = true
    createPollBtn.textContent = 'Creating…'
    statusEl.textContent = 'Creating poll…'

    try {
      await sendMessage({
        type: 'CREATE_POLL',
        question,
        options,
        timeoutMs: Math.floor(seconds * 1000)
      })
      logEvent('Poll created: ' + question)
    } catch (err) {
      createPollErrorEl.textContent = 'Failed to create poll: ' + (err.message || err)
      createPollBtn.disabled = false
      createPollBtn.textContent = 'Create poll →'
    }
  })

  pollQuestionEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createPollBtn.click()
  })
}

// ── State ─────────────────────────────────────────────────────────────────────
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

  if (role === 'creator') {
    if (poll) {
      createPollCardEl.classList.add('hidden')
      pollCardEl.classList.remove('hidden')
    } else {
      createPollCardEl.classList.remove('hidden')
      pollCardEl.classList.add('hidden')
    }
  }

  if (!poll) {
    pollStateEl.textContent =
      role === 'creator' ? 'No active poll yet.' : 'Waiting for an active poll...'
    return
  }

  const options   = Array.isArray(poll.options) ? poll.options : []
  const votes     = poll && typeof poll.votes === 'object' && poll.votes ? poll.votes : {}
  const counts    = Array.from({ length: options.length }, () => 0)
  for (const choice of Object.values(votes)) {
    if (Number.isInteger(choice) && choice >= 0 && choice < options.length) counts[choice] += 1
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

  const myPeerId    = window.__myPeerId
  const alreadyVoted = !!myPeerId && myPeerId in votes
  const canVote      = role === 'voter' && !ended && !alreadyVoted

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
      statusEl.textContent = 'Signing vote with digital certificate...'
      await new Promise(r => setTimeout(r, 500))
      statusEl.textContent = 'Voting...'
      await sendMessage({ type: 'CAST_VOTE', optionIndex: index })
    }
    list.appendChild(button)
  }

  pollBodyEl.appendChild(list)

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

// ── Worker ────────────────────────────────────────────────────────────────────
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
      if (
        role === 'creator' &&
        createPollBtn &&
        createPollBtn.disabled &&
        /Creating/i.test(createPollBtn.textContent || '')
      ) {
        createPollBtn.disabled = false
        createPollBtn.textContent = 'Create poll →'
        createPollErrorEl.textContent = message.message || 'Failed to create poll'
      }
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

// ── Auto refresh ──────────────────────────────────────────────────────────────
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

// ── UI event handlers ─────────────────────────────────────────────────────────
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

// ── Mobile bridge card ────────────────────────────────────────────────────────
let mobileBaseUrls = []
let mobileLastTopic = ''
let mobileLastUrl = ''

function pickPreferredUrl(urls) {
  if (!urls || !urls.length) return ''
  // Prefer common LAN ranges (192.168.*, 10.*, 172.16-31.*) over link-local.
  const score = (u) => {
    try {
      const host = new URL(u).hostname
      if (host.startsWith('192.168.')) return 3
      if (host.startsWith('10.')) return 2
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 2
      return 1
    } catch { return 0 }
  }
  return [...urls].sort((a, b) => score(b) - score(a))[0]
}

async function refreshMobileCard() {
  const topic = (topicEl.textContent || '').trim()
  const validTopic = /^[0-9a-fA-F]{64}$/.test(topic) ? topic.toLowerCase() : ''
  const base = pickPreferredUrl(mobileBaseUrls)
  if (!base) {
    mobileCardEl.classList.add('hidden')
    return
  }
  mobileCardEl.classList.remove('hidden')
  const fullUrl = validTopic ? `${base}/#${validTopic}` : base
  if (fullUrl === mobileLastUrl && validTopic === mobileLastTopic) return
  mobileLastUrl = fullUrl
  mobileLastTopic = validTopic
  mobileUrlEl.textContent = fullUrl
  try {
    const res = await fetch(`${base}/qr?data=${encodeURIComponent(fullUrl)}`)
    if (res.ok) {
      const svg = await res.text()
      mobileQrEl.innerHTML = svg
      const svgEl = mobileQrEl.querySelector('svg')
      if (svgEl) {
        svgEl.setAttribute('width', '100%')
        svgEl.setAttribute('height', 'auto')
        svgEl.style.display = 'block'
      }
    }
  } catch {
  }
}

async function loadHttpInfo() {
  if (!bridge.httpInfo) return
  try {
    const info = await bridge.httpInfo()
    if (info && info.urls) {
      mobileBaseUrls = info.urls
      refreshMobileCard()
    }
  } catch {
  }
}

if (bridge.onHttpReady) {
  bridge.onHttpReady((data) => {
    if (data && data.urls) {
      mobileBaseUrls = data.urls
      refreshMobileCard()
    }
  })
}

if (copyMobileUrlBtn) {
  copyMobileUrlBtn.addEventListener('click', async () => {
    const text = mobileUrlEl.textContent.trim()
    if (!text || text === '…') return
    try {
      await navigator.clipboard.writeText(text)
      copyMobileUrlBtn.textContent = 'Copied!'
      setTimeout(() => (copyMobileUrlBtn.textContent = 'Copy URL'), 1500)
    } catch {
      copyMobileUrlBtn.textContent = 'Copy failed'
    }
  })
}

loadHttpInfo()
// Topic appears asynchronously after the worker is ready; keep refreshing.
setInterval(refreshMobileCard, 1500)
