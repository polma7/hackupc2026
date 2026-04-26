(function () {
  const statusEl = document.getElementById('status')
  const joinCardEl = document.getElementById('join-card')
  const pollCardEl = document.getElementById('poll-card')
  const pollStateEl = document.getElementById('poll-state')
  const pollBodyEl = document.getElementById('poll-body')
  const pollTopicEl = document.getElementById('poll-topic')
  const pollPeersEl = document.getElementById('poll-peers')
  const scanBtn = document.getElementById('scan-btn')
  const scannerEl = document.getElementById('scanner')
  const scannerFrame = document.getElementById('scanner-frame')
  const videoEl = document.getElementById('video')
  const topicInputEl = document.getElementById('topic-input')
  const manualJoinBtn = document.getElementById('manual-join-btn')
  const joinErrEl = document.getElementById('join-err')

  let stream = null
  let scanRaf = null
  const scanCanvas = document.createElement('canvas')
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true })
  let joined = false
  let pollTickHandle = null
  let lastVotedOption = null

  function setStatus(text) { statusEl.textContent = text }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ))
  }

  function formatRemaining(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0s'
    const total = Math.ceil(ms / 1000)
    const m = Math.floor(total / 60)
    const s = total % 60
    if (m > 0) return m + 'm ' + String(s).padStart(2, '0') + 's'
    return s + 's'
  }

  function extractTopic(raw) {
    const m = String(raw || '').match(/[0-9a-fA-F]{64}/)
    return m ? m[0].toLowerCase() : ''
  }

  async function startCamera() {
    if (stream) return
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } }
      })
      videoEl.srcObject = stream
      await videoEl.play()
      scannerEl.classList.remove('hidden')
      scanBtn.textContent = 'Stop scanning'
      tickScan()
    } catch (e) {
      joinErrEl.textContent = 'Camera unavailable: ' + e.message
    }
  }

  function stopCamera() {
    if (scanRaf) {
      cancelAnimationFrame(scanRaf)
      scanRaf = null
    }
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
    videoEl.srcObject = null
    scannerEl.classList.add('hidden')
    scannerFrame.classList.remove('hit')
    scanBtn.textContent = 'Scan QR'
  }

  function tickScan() {
    scanRaf = requestAnimationFrame(tickScan)
    if (!videoEl.videoWidth || !videoEl.videoHeight) return
    if (typeof window.jsQR !== 'function') return

    const w = Math.min(640, videoEl.videoWidth)
    const ratio = w / videoEl.videoWidth
    const h = Math.round(videoEl.videoHeight * ratio)
    if (scanCanvas.width !== w) scanCanvas.width = w
    if (scanCanvas.height !== h) scanCanvas.height = h
    scanCtx.drawImage(videoEl, 0, 0, w, h)
    const img = scanCtx.getImageData(0, 0, w, h)
    const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
    if (code && code.data) {
      const topic = extractTopic(code.data)
      if (topic) {
        scannerFrame.classList.add('hit')
        joinWithTopic(topic)
      }
    }
  }

  async function joinWithTopic(topic) {
    if (joined) return
    setStatus('Joining…')
    stopCamera()
    joinErrEl.textContent = ''
    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: topic })
      })
      const body = await res.json()
      if (!body.ok) {
        joinErrEl.textContent = body.error || 'Join failed'
        setStatus('Idle')
        return
      }
      joined = true
      joinCardEl.classList.add('hidden')
      pollCardEl.classList.remove('hidden')
      pollStateEl.textContent = 'Connecting to peers…'
      startStatePolling()
    } catch (e) {
      joinErrEl.textContent = 'Network error: ' + e.message
      setStatus('Idle')
    }
  }

  function renderPoll(snapshot) {
    if (!snapshot) return
    pollTopicEl.textContent = (snapshot.topic || '').slice(0, 12) + (snapshot.topic ? '…' : '')
    pollPeersEl.textContent = String(snapshot.peers || 0)

    if (!joined && snapshot.ready && snapshot.topic) {
      joined = true
      joinCardEl.classList.add('hidden')
      pollCardEl.classList.remove('hidden')
    }

    const poll = snapshot.poll
    pollBodyEl.replaceChildren()
    if (!poll) {
      pollStateEl.textContent = 'Waiting for an active poll…'
      setStatus('Joined')
      return
    }

    const ended = poll.status !== 'open'
    if (ended) {
      pollStateEl.textContent = 'Closed at ' + new Date(poll.closedAt || Date.now()).toLocaleTimeString()
    } else {
      const remaining = (poll.endsAt || 0) - Date.now()
      pollStateEl.innerHTML = 'Open — closes in <strong>' + formatRemaining(remaining) + '</strong>'
    }

    const title = document.createElement('div')
    title.innerHTML = '<strong>' + escapeHtml(poll.question) + '</strong>'
    pollBodyEl.appendChild(title)

    const totalVotes = poll.votes ? Object.keys(poll.votes).length : 0
    const meta = document.createElement('div')
    meta.className = 'muted'
    meta.style.marginTop = '4px'
    meta.textContent = 'Votes: ' + totalVotes
    pollBodyEl.appendChild(meta)

    const list = document.createElement('div')
    list.className = 'options'
    const options = Array.isArray(poll.options) ? poll.options : []
    const counts = poll.counts || []
    for (let i = 0; i < options.length; i++) {
      const opt = options[i]
      const label = typeof opt === 'string' ? opt : (opt && opt.label) || 'Option ' + (i + 1)
      const btn = document.createElement('button')
      const count = counts[i] || 0
      const tag = lastVotedOption === i ? '✓ ' : ''
      btn.textContent = tag + label + ' — ' + count + ' votes'
      btn.disabled = ended || lastVotedOption !== null
      btn.onclick = () => castVote(i)
      list.appendChild(btn)
    }
    pollBodyEl.appendChild(list)

    setStatus(ended ? 'Closed' : 'Joined')
  }

  async function castVote(index) {
    setStatus('Voting…')
    try {
      const res = await fetch('/api/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionIndex: index })
      })
      const body = await res.json()
      if (!body.ok) {
        joinErrEl.textContent = body.error || 'Vote failed'
        setStatus('Joined')
        return
      }
      lastVotedOption = index
      pollStateEl.textContent = 'Vote sent — refreshing…'
    } catch (e) {
      setStatus('Joined')
      joinErrEl.textContent = 'Network error: ' + e.message
    }
  }

  async function pollState() {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' })
      const snap = await res.json()
      renderPoll(snap)
    } catch {
    }
  }

  function startStatePolling() {
    if (pollTickHandle) clearInterval(pollTickHandle)
    pollState()
    pollTickHandle = setInterval(pollState, 800)
  }

  scanBtn.addEventListener('click', () => {
    if (stream) stopCamera()
    else startCamera()
  })

  manualJoinBtn.addEventListener('click', () => {
    const topic = extractTopic(topicInputEl.value)
    if (!topic) {
      joinErrEl.textContent = 'Paste a 64-char hex hash'
      return
    }
    joinWithTopic(topic)
  })

  topicInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') manualJoinBtn.click()
  })

  // If a topic was provided in the URL fragment (e.g. via a QR that encodes
  // http://host:port/#<64-hex>), auto-join.
  const hashTopic = extractTopic(window.location.hash || '')
  if (hashTopic) {
    joinWithTopic(hashTopic)
  }

  // If the host is already joined to a topic (e.g. user opened mobile after
  // desktop already connected), jump straight to the poll view.
  startStatePolling()
})()
