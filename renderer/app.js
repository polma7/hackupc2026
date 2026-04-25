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
const qrImgEl         = document.getElementById('qr-img')
const peersEl         = document.getElementById('peers')
const roleBadgeEl     = document.getElementById('role-badge')
const joinCardEl      = document.getElementById('join-card')
const topicInputEl    = document.getElementById('topic-input')
const joinBtn         = document.getElementById('join-btn')
const pollCardEl      = document.getElementById('poll-card')
const pollStateEl     = document.getElementById('poll-state')
const pollBodyEl      = document.getElementById('poll-body')
const exportWrapEl    = document.getElementById('export-wrap')
const exportBtn       = document.getElementById('export-btn')
const eventsEl        = document.getElementById('events')
const createCardEl    = document.getElementById('create-card')
const pollQuestionEl  = document.getElementById('poll-question')
const optionsListEl   = document.getElementById('options-list')
const addOptionBtn    = document.getElementById('add-option-btn')
const pollDurationEl  = document.getElementById('poll-duration')
const createPollBtn   = document.getElementById('create-poll-btn')
const createStatusEl  = document.getElementById('create-status')
const mobileCardEl    = document.getElementById('mobile-card')
const mobileQrImgEl   = document.getElementById('mobile-qr-img')
const mobileUrlEl     = document.getElementById('mobile-url')

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
  certStatusEl.textContent = 'Verificando certificado...'
  certStatusEl.style.color = '#aaa'
  try {
    const result = await bridge.verifyCert(selectedP12Buffer, certPasswordEl.value)
    if (result.ok) {
      certIdentity = result
      identityNameEl.textContent = result.name || 'Nombre no disponible'
      identityMetaEl.textContent = [
        result.nif ? 'NIF: ' + result.nif : null,
        result.issuer ? 'Emitido por: ' + result.issuer : null,
      ].filter(Boolean).join(' · ')
      identityBadgeEl.classList.remove('hidden')
      certStatusEl.textContent = '✓ Identidad verificada correctamente'
      certStatusEl.style.color = '#4caf50'
      setTimeout(() => {
        certOverlayEl.style.display = 'none'
        logEvent('Identidad verificada: ' + (result.name || result.nif || '?'))
      }, 1000)
    } else {
      certStatusEl.textContent = '✗ ' + (result.error || 'Verificación fallida')
      certStatusEl.style.color = '#f44336'
      certVerifyBtn.disabled = false
    }
  } catch (e) {
    certStatusEl.textContent = '✗ Error: ' + e.message
    certStatusEl.style.color = '#f44336'
    certVerifyBtn.disabled = false
  }
})

// ── Poll creation form (creator) ──────────────────────────────────────────────
function addOptionRow(value = '') {
  const row = document.createElement('div')
  row.className = 'option-row'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Opción ' + (optionsListEl.children.length + 1)
  input.value = value
  const removeBtn = document.createElement('button')
  removeBtn.className = 'btn-remove'
  removeBtn.textContent = '✕'
  removeBtn.onclick = () => {
    if (optionsListEl.children.length > 2) row.remove()
  }
  row.appendChild(input)
  row.appendChild(removeBtn)
  optionsListEl.appendChild(row)
}

addOptionRow()
addOptionRow()

addOptionBtn.addEventListener('click', () => addOptionRow())

createPollBtn.addEventListener('click', async () => {
  const question = pollQuestionEl.value.trim()
  const options = Array.from(optionsListEl.querySelectorAll('input'))
    .map((i) => i.value.trim())
    .filter(Boolean)
  const timeoutMs = Math.max(10000, Number(pollDurationEl.value) * 1000)

  if (!question) { createStatusEl.textContent = 'Escribe una pregunta.'; return }
  if (options.length < 2) { createStatusEl.textContent = 'Al menos dos opciones.'; return }

  createPollBtn.disabled = true
  createStatusEl.textContent = 'Creando votación...'
  await sendMessage({ type: 'CREATE_POLL', question, options, timeoutMs })
})

// ── Role setup ────────────────────────────────────────────────────────────────
roleBadgeEl.textContent = role.toUpperCase()
roleBadgeEl.classList.add(role)

if (role === 'creator') {
  topicHeadingEl.textContent = 'Hash de la votación'
  topicHelpEl.textContent = 'Comparte este hash con los votantes (chat, QR, papel).'
  joinCardEl.classList.add('hidden')
} else {
  topicCardEl.classList.add('hidden')
  pollCardEl.classList.add('hidden')
  joinCardEl.classList.remove('hidden')
}

// ── State ─────────────────────────────────────────────────────────────────────
let workerBuffer   = ''
let latestRevision = -1
let currentPoll    = null
let joined         = false
let workerReady    = false
let mobileUrl      = null

function shouldApplyMessageState(message) {
  const rev = Number(message?.revision)
  if (!Number.isFinite(rev)) return true
  if (rev < latestRevision) return false
  latestRevision = rev
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
  return m > 0 ? m + 'm ' + s.toString().padStart(2, '0') + 's' : s + 's'
}

function markJoined() {
  if (joined) return
  joined = true
  if (role === 'voter') {
    joinCardEl.classList.add('hidden')
    pollCardEl.classList.remove('hidden')
    topicCardEl.classList.remove('hidden')
    topicHeadingEl.textContent = 'Conectado a la votación'
    topicHelpEl.textContent = 'Puedes reenviar este hash a otros votantes aunque el creador se desconecte.'
  }
}

// ── QR (Hyperswarm topic) ─────────────────────────────────────────────────────
let lastQRTopic = null
async function updateQR(topic) {
  if (!topic || topic === lastQRTopic) return
  lastQRTopic = topic
  try {
    const dataUrl = await bridge.generateQR(topic)
    qrImgEl.src = dataUrl
    qrImgEl.classList.remove('hidden')
  } catch {}
}

// ── Mobile QR ─────────────────────────────────────────────────────────────────
async function initMobileQR() {
  if (role !== 'creator' || mobileUrl) return
  try {
    mobileUrl = await bridge.getMobileUrl()
    const dataUrl = await bridge.generateQR(mobileUrl)
    mobileQrImgEl.src = dataUrl
    mobileUrlEl.textContent = mobileUrl
  } catch {}
}

function showMobileCard(poll) {
  if (role !== 'creator') return
  if (poll && poll.status === 'open') {
    mobileCardEl.classList.remove('hidden')
  } else {
    mobileCardEl.classList.add('hidden')
  }
}

// ── Render poll ───────────────────────────────────────────────────────────────
function renderPoll(poll) {
  currentPoll = poll

  if (role === 'creator') {
    if (!poll) {
      createCardEl.classList.remove('hidden')
      pollCardEl.classList.add('hidden')
      mobileCardEl.classList.add('hidden')
      return
    }
    createCardEl.classList.add('hidden')
    pollCardEl.classList.remove('hidden')
  }

  showMobileCard(poll)
  pollBodyEl.replaceChildren()

  if (!poll) {
    pollStateEl.textContent = 'Esperando votación activa...'
    return
  }

  const options    = Array.isArray(poll.options) ? poll.options : []
  const counts     = Array.isArray(poll.counts) ? poll.counts : []
  const totalVotes = poll.totalVotes || 0
  const ended      = poll.status !== 'open'

  // State line
  const stateLine = document.createElement('span')
  if (ended) {
    stateLine.textContent = 'Cerrada a las ' + new Date(poll.closedAt || Date.now()).toLocaleTimeString()
  } else {
    const remaining = (poll.endsAt || 0) - Date.now()
    stateLine.innerHTML = 'Abierta — cierra en <span class="countdown">' + formatRemaining(remaining) + '</span>'
  }
  pollStateEl.replaceChildren(stateLine)

  // Question
  const title = document.createElement('div')
  title.innerHTML = '<strong>' + escapeHtml(poll.question) + '</strong>'
  pollBodyEl.appendChild(title)

  // Meta
  const meta = document.createElement('div')
  meta.className = 'muted'
  meta.style.marginTop = '4px'
  meta.textContent = totalVotes + ' voto' + (totalVotes !== 1 ? 's' : '') +
    ' · Anónima · Creada por: ' + (poll.createdBy || '?').slice(0, 8) + '…'
  pollBodyEl.appendChild(meta)

  // Vote bars
  const barsWrap = document.createElement('div')
  barsWrap.style.marginTop = '16px'

  const canVote = role === 'voter' && !ended && !poll.hasVoted

  for (let i = 0; i < options.length; i++) {
    const opt   = options[i]
    const label = typeof opt === 'string' ? opt : (opt?.label || 'Opción ' + (i + 1))
    const count = counts[i] || 0
    const pct   = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0
    const isMyVote = poll.myVote === i

    const wrap = document.createElement('div')
    wrap.className = 'vote-bar-wrap'

    const labelRow = document.createElement('div')
    labelRow.className = 'vote-bar-label'
    labelRow.innerHTML =
      '<span>' + (isMyVote ? '✓ ' : '') + escapeHtml(label) + '</span>' +
      '<span class="muted">' + count + ' · ' + pct + '%</span>'

    const track = document.createElement('div')
    track.className = 'vote-bar-track'
    const fill = document.createElement('div')
    fill.className = 'vote-bar-fill' + (isMyVote ? ' voted' : '')
    fill.style.width = pct + '%'
    track.appendChild(fill)

    wrap.appendChild(labelRow)
    wrap.appendChild(track)

    if (canVote) {
      const btn = document.createElement('button')
      btn.textContent = 'Votar por esta opción'
      btn.style.cssText = 'margin-top:6px; font-size:13px; padding:6px 12px;'
      btn.onclick = async () => {
        if (!canVote) return
        statusEl.textContent = 'Firmando voto con certificado digital...'
        await new Promise(r => setTimeout(r, 500))
        statusEl.textContent = 'Emitiendo voto...'
        await sendMessage({
          type: 'CAST_VOTE',
          optionIndex: i,
          certNIF: certIdentity?.nif || null
        })
      }
      wrap.appendChild(btn)
    }

    barsWrap.appendChild(wrap)
  }
  pollBodyEl.appendChild(barsWrap)

  // Already voted notice
  if (poll.hasVoted && !ended) {
    const note = document.createElement('div')
    note.className = 'muted'
    note.style.marginTop = '12px'
    note.textContent = '✓ Has votado — voto registrado de forma anónima.'
    pollBodyEl.appendChild(note)
  }

  // Creator: close button
  if (role === 'creator' && !ended) {
    const closeBtn = document.createElement('button')
    closeBtn.textContent = 'Cerrar votación ahora'
    closeBtn.style.cssText = 'margin-top:16px; background:#2a1a1a; border-color:#5a2a2a; color:#f44336;'
    closeBtn.onclick = () => sendMessage({ type: 'CLOSE_POLL', reason: 'manual' })
    pollBodyEl.appendChild(closeBtn)
  }

  // Verified voters list (pseudonymous NIFs, no link to vote choice)
  if (Array.isArray(poll.verifiedVoters) && poll.verifiedVoters.length > 0) {
    const vDiv = document.createElement('div')
    vDiv.style.marginTop = '16px'
    const vLabel = document.createElement('div')
    vLabel.className = 'muted'
    vLabel.style.fontSize = '12px'
    vLabel.textContent = 'IDENTIDADES VERIFICADAS (' + poll.verifiedVoters.length + ')'
    vDiv.appendChild(vLabel)
    const chips = document.createElement('div')
    chips.className = 'voter-chips'
    for (const nif of poll.verifiedVoters) {
      const chip = document.createElement('span')
      chip.className = 'voter-chip'
      chip.textContent = nif
      chips.appendChild(chip)
    }
    vDiv.appendChild(chips)
    pollBodyEl.appendChild(vDiv)
  }

  // Export button (creator, poll ended)
  if (role === 'creator' && ended) {
    exportWrapEl.classList.remove('hidden')
  } else {
    exportWrapEl.classList.add('hidden')
  }
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}

// ── Export certified results ──────────────────────────────────────────────────
exportBtn.addEventListener('click', async () => {
  if (!currentPoll) return
  const options = Array.isArray(currentPoll.options) ? currentPoll.options : []
  const counts  = Array.isArray(currentPoll.counts)  ? currentPoll.counts  : []

  const results = {}
  for (let i = 0; i < options.length; i++) {
    const label = typeof options[i] === 'string' ? options[i] : (options[i]?.label || 'Opción ' + i)
    results[label] = counts[i] || 0
  }

  const exportData = {
    version: 1,
    system: 'P2P Voting — Holepunch / Hyperswarm',
    poll: {
      id: currentPoll.id,
      question: currentPoll.question,
      createdAt: new Date(currentPoll.createdAt).toISOString(),
      closedAt: currentPoll.closedAt ? new Date(currentPoll.closedAt).toISOString() : null,
    },
    results,
    totalVotes: currentPoll.totalVotes || 0,
    verifiedVoters: currentPoll.verifiedVoters || [],
    anonymityNote: 'Los votos son anónimos. Las identidades verificadas confirman el derecho a voto, pero no están vinculadas a ninguna opción concreta.',
    exportedAt: new Date().toISOString(),
    exportedBy: certIdentity ? (certIdentity.name + ' · NIF: ' + certIdentity.nif) : 'desconocido',
  }

  const filename = 'resultado_' + (currentPoll.id || 'poll').slice(0, 8) + '.json'
  const res = await bridge.saveExport(exportData, filename)
  if (res.ok) {
    logEvent('Resultados exportados: ' + res.path)
    exportBtn.textContent = '✓ Exportado'
    setTimeout(() => (exportBtn.textContent = 'Exportar resultados certificados'), 3000)
  } else if (res.error) {
    logEvent('Error al exportar: ' + res.error)
  }
})

// ── Worker ────────────────────────────────────────────────────────────────────
bridge.startWorker(workers.main)

bridge.onWorkerStdout(workers.main, (data) => console.log('worker stdout', decoder.decode(data)))
bridge.onWorkerStderr(workers.main, (data) => console.error('worker stderr', decoder.decode(data)))

bridge.onWorkerIPC(workers.main, (data) => {
  workerBuffer += decoder.decode(data)
  const lines = workerBuffer.split('\n')
  workerBuffer = lines.pop()

  for (const line of lines) {
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch (err) {
      statusEl.textContent = 'Bad worker message: ' + err.message
      continue
    }

    if (message.type === 'AWAITING_TOPIC') {
      window.__myPeerId = message.peerId
      statusEl.textContent = 'Esperando hash de votación'
      continue
    }

    if (message.type === 'READY') {
      workerReady = true
      window.__myPeerId = message.peerId
      statusEl.textContent = role === 'creator' ? 'Listo' : 'Conectado'
      topicEl.textContent = message.topic
      latestRevision = -1
      markJoined()
      updateQR(message.topic)
      if (role === 'creator') {
        createCardEl.classList.remove('hidden')
        initMobileQR()
      }
      continue
    }

    if (message.type === 'STATE') {
      if (!shouldApplyMessageState(message)) continue
      statusEl.textContent = 'Sincronizado'
      topicEl.textContent = message.topic
      peersEl.textContent = String(message.peers)
      markJoined()
      renderPoll(message.poll)
      updateQR(message.topic)
      // Keep HTTP server state in sync for mobile voters
      if (bridge.syncState) bridge.syncState(message.poll).catch(() => {})
      if (!autoRefreshInterval) startAutoRefresh()
      continue
    }

    if (message.type === 'PEERS') {
      peersEl.textContent = String(message.count)
      topicEl.textContent = message.topic
      logEvent('Peers conectados: ' + message.count)
      continue
    }

    if (message.type === 'PONG') {
      if (!shouldApplyMessageState(message)) continue
      peersEl.textContent = String(message.peers ?? peersEl.textContent)
      renderPoll(message.poll || null)
      if (bridge.syncState && message.poll) bridge.syncState(message.poll).catch(() => {})
      continue
    }

    if (message.type === 'error') {
      statusEl.textContent = 'Error: ' + message.message
      logEvent('error: ' + message.message)
      if (role === 'creator') {
        createPollBtn.disabled = false
        createStatusEl.textContent = 'Error: ' + message.message
      }
      continue
    }
  }
})

const onWorkerExit = bridge.onWorkerExitSafe || bridge.onWorkerExit
onWorkerExit(workers.main, (code) => {
  statusEl.textContent = 'Worker exited: ' + code
})

// ── Auto refresh ──────────────────────────────────────────────────────────────
let autoRefreshInterval = null
let countdownInterval   = null

function startAutoRefresh() {
  if (autoRefreshInterval) clearInterval(autoRefreshInterval)
  autoRefreshInterval = setInterval(() => sendMessage({ type: 'PING' }).catch(() => {}), 500)

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
    if (!key) { statusEl.textContent = 'Pega un hash de 64 caracteres'; return }
    statusEl.textContent = 'Uniéndose...'
    await sendMessage({ type: 'JOIN', key })
  })
  topicInputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click() })
}

if (copyTopicBtn) {
  copyTopicBtn.addEventListener('click', async () => {
    const text = topicEl.textContent.trim()
    if (!text || text === '...') return
    try {
      await navigator.clipboard.writeText(text)
      copyTopicBtn.textContent = '¡Copiado!'
      setTimeout(() => (copyTopicBtn.textContent = 'Copy hash'), 1500)
    } catch { copyTopicBtn.textContent = 'Error al copiar' }
  })
}
