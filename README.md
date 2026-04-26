
# P2P E-Voting — HackUPC 2026

A decentralized, serverless electronic voting system built on [Hyperswarm](https://github.com/holepunchto/hyperswarm) and [Electron](https://www.electronjs.org/). No server. No central database. Votes propagate peer-to-peer across a Kademlia-based DHT and are merged with a CRDT-style algorithm in memory.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Peer Discovery](#peer-discovery)
- [Writer Authorization](#writer-authorization)
- [CRDT State Merging](#crdt-state-merging)
- [Installation](#installation)
- [Running (Development)](#running-development)
- [Flow Diagrams](#flow-diagrams)
  - [Normal Voting Flow](#normal-voting-flow)
  - [Late Joiner / Node Reconnection](#late-joiner--node-reconnection)
  - [Creator Crash Mid-Poll](#creator-crash-mid-poll)
  - [Offline Timeout Expiry](#offline-timeout-expiry)
  - [Certificate Verification](#certificate-verification)
- [Failure Scenarios and Recovery](#failure-scenarios-and-recovery)
- [IPC Architecture](#ipc-architecture)
- [Message Protocol](#message-protocol)
- [Tech Stack](#tech-stack)

---

## Architecture Overview
<img width="963" height="801" alt="Captura desde 2026-04-26 02-14-53" src="https://github.com/user-attachments/assets/d2716188-7104-4973-bf70-ede2734fc4f4" />

The app runs in two roles:

| Role | Started with | Responsibilities |
|------|-------------|-----------------|
| **Creator** | `--create` flag | Generates the topic, creates the poll, broadcasts state, force-closes |
| **Voter** | (default) | Pastes the topic hex, joins the DHT swarm, votes once |

---

## Peer Discovery

### How it works

Hyperswarm uses a DHT running over UDP. Every node announces itself under a **topic** — a 32-byte buffer — and simultaneously queries for other nodes under the same topic.

```
Creator starts
     │
     ▼
randomBuffer(32) → topic (32 bytes)
     │
     ▼
topic.toString('hex') → "a3f9...c1d2"  (64 hex chars, shown in UI)
     │
     ├── swarm.join(topic, { client: true, server: true })
     │        └── announces own address to DHT under topic
     │        └── queries DHT for peers already under topic
     │
     └── Creator shows the 64-char hex in the UI
              │
              └── Human copies it and sends to voters (chat, QR, paper)
```

When a Voter pastes the hex and clicks Join:

```
Voter receives "a3f9...c1d2"
     │
     ▼
Buffer.from(hex, 'hex') → topic (32 bytes)
     │
     ▼
swarm.join(topic, { client: true, server: true })
     │
     ├── DHT lookup: "who else announced this topic?"
     │        └── Returns a list of (IP, port) tuples
     │
     └── TCP connections established to each discovered peer
              │
              └── HELLO handshake → STATE_SYNC → poll state propagates
```

**Key properties:**
- The DHT is global and public — no central rendezvous server needs to be operated
- The same 32-byte topic acts as both the address and the access token
- Peers discover each other within ~2–5 seconds on a local network; ~5–15 seconds over the internet
- If all peers disconnect and reconnect later using the same topic, discovery still works

---

## Writer Authorization

### Who can do what

| Action | Allowed roles | Enforcement location |
|--------|--------------|---------------------|
| Create a poll | Creator only | Worker `handleLocalMessage` + CLI `--create` flag |
| Cast a vote | Voter only | Worker `castVote` + `handleLocalMessage` |
| Force-close a poll | Creator only | Worker `handleLocalMessage` |
| Join a topic | Voter only | Worker `handleLocalMessage` |

The role is determined at startup by the presence of the `--create` CLI flag and is injected into the Bare worker as a JSON argument. It cannot be changed at runtime.

### Certificate-based identity

Before any interaction with the poll, every user must present a **PKCS#12 (.p12) certificate**:

```
User opens app
     │
     ▼
Certificate overlay shown (blocks UI)
     │
     ▼
User drags .p12 file + types PIN/password
     │
     ▼
electron/main.js  →  node-forge
  1. Parse DER-encoded PKCS12
  2. Extract X.509 certificate
  3. Check validity dates (notBefore / notAfter)
  4. Extract CN (display name) and serialNumber (NIF/voter ID)
  5. Challenge-response:
       a. Generate 32 random bytes
       b. Sign with private key from PKCS12
       c. Verify with public key from the certificate
       → Proves the user actually holds the private key
     │
     ▼
{ ok: true, name: "Alice", nif: "12345678A", issuer: "Demo CA" }
     │
     ▼
Identity badge shown in UI
```

This ensures:
- **One vote per voterId** — duplicate votes from the same worker-side voter identity are ignored in memory
- **Certificate expiry** is checked — expired certs are rejected before any action
- **Key possession** is checked in the certificate verification flow — the UI verifies the certificate and its private key before showing the identity badge

---

## CRDT State Merging

Because there is no single authoritative server, every node maintains a local copy of the poll state. When two nodes connect, they exchange their state and merge it.

The merge function implements a **grow-only CRDT** with the following rules:

```javascript
function mergePolls(local, remote) {
  // 1. Different polls: prefer the open one, then the older one
  if (local.id !== remote.id) { ... }

  // 2. Same poll: union of all votes, first-seen choice per voter wins
  const mergedVotes = { ...local.votes }
  for (const [voterId, choice] of Object.entries(remote.votes)) {
    if (!(voterId in mergedVotes)) mergedVotes[voterId] = choice
  }

  // 3. Closed status wins (once closed, cannot be reopened)
  const closed = local.status === 'closed' || remote.status === 'closed'

  // 4. Earlier closedAt wins
  closedAt = Math.min(local.closedAt, remote.closedAt)
}
```

**Properties guaranteed:**
- **Idempotent**: merging the same state twice produces the same result
- **Commutative**: merge(A, B) === merge(B, A)
- **Monotone**: the vote count never decreases; closed is a terminal state
- **Vote-once**: first-seen vote for a voter ID is kept; subsequent votes for the same ID are silently dropped

**Gossip protocol**: when a node receives a new vote from a peer, it re-broadcasts it to all its other connections. This ensures votes propagate through the mesh even if not every node is directly connected to every other node.

```
A ─── B ─── C        (A not directly connected to C)

A votes → B receives → B re-broadcasts → C receives
```

---

## Installation

### Requirements

- Node.js 20+ and npm
- Git

### Steps

```bash
# 1. Clone
git clone <repo-url>
cd hackupc2026

# 2. Install dependencies
npm install

# 3. (Optional) Generate demo certificates
#    Requires openssl in PATH
cd demo-certs
bash generate.sh   # creates Creator.p12, Voter1–4.p12, password: 1234
cd ..
```

---

## Running (Development)

Three separate terminal windows are needed to simulate a full election:

```bash
# Terminal 1 — Creator node (generates topic, creates poll)
npm run start:a

# Terminal 2 — Voter B
npm run start:b

# Terminal 3 — Voter C
npm run start:c
```

Each script starts Electron with a separate `--storage` path so they behave as independent nodes on the same machine.

**Workflow:**
1. In the Creator window: load `Creator.p12` (password `1234`), create a poll
2. Copy the 64-char topic hex shown in the Creator window
3. In each Voter window: load a `VoterN.p12` (password `1234`), paste the topic, click Join
4. Vote from each voter window
5. Watch live results update across all windows

To open DevTools for debugging: `Ctrl+Shift+I` in any window.

---

## Flow Diagrams

### Normal Voting Flow

```
Creator                    DHT                     Voter A              Voter B
   │                        │                          │                    │
   │── randomBuffer(32) ───►│                          │                    │
   │   topic = "a3f9..."    │                          │                    │
   │                        │                          │                    │
   │── swarm.join(topic) ──►│◄── swarm.join(topic) ───│                    │
   │                        │◄── swarm.join(topic) ───────────────────────►│
   │                        │                          │                    │
   │◄═══════════════════ TCP connection ══════════════►│                    │
   │◄══════════════════════════════════ TCP connection ════════════════════►│
   │                        │          ◄══════════════ TCP connection ══════│
   │         (mesh: every peer connects to every other peer)                │
   │                                                   │                    │
   │── HELLO ─────────────────────────────────────────►│                    │
   │── HELLO ──────────────────────────────────────────────────────────────►│
   │◄─ STATE_SYNC (empty) ────────────────────────────│                    │
   │◄─ STATE_SYNC (empty) ─────────────────────────────────────────────────│
   │                                                   │                    │
   │  [User creates poll in UI]                        │                    │
   │── CREATE_POLL ────────────────────────────────────►│                    │
   │── CREATE_POLL ─────────────────────────────────────────────────────────►│
   │                                                   │                    │
   │                                        [Voter A sees poll, votes]      │
   │◄─ VOTE_CAST (voterId=A, option=0) ───────────────│                    │
   │── VOTE_CAST ──────────────────────────────────────────────────────────►│
   │                                                              [Voter B votes]
   │◄─ VOTE_CAST (voterId=B, option=1) ─────────────────────────────────────│
   │── VOTE_CAST ──────────────────────────────────────►│                    │
   │                                                   │                    │
   │  [Timeout expires or force-close]                 │                    │
   │── POLL_CLOSED ────────────────────────────────────►│                    │
   │── POLL_CLOSED ─────────────────────────────────────────────────────────►│
   │                                                   │                    │
   │  All nodes show final results                     │                    │
```

### Late Joiner / Node Reconnection

A voter who joins after votes have already been cast still gets the full state via `STATE_SYNC`:

```
[Poll already has 5 votes]

Creator                                          Voter C (late)
   │                                                  │
   │                                   [Voter C pastes topic, clicks Join]
   │                                                  │
   │◄══════════════════════ TCP connection ══════════►│
   │                                                  │
   │◄─ HELLO ─────────────────────────────────────────│
   │                                                  │
   │── STATE_SYNC (poll + 5 votes) ──────────────────►│
   │                                                  │
   │                               [Voter C sees poll + existing results]
   │                               [Voter C votes]
   │◄─ VOTE_CAST ─────────────────────────────────────│
   │── VOTE_CAST ─────────────────────────────────────► (other peers)
```

**Why this works:** On every new TCP connection, both sides immediately send their full current poll state (`STATE_SYNC`). The receiver runs `mergePolls()`, which unions all votes — so the late joiner instantly catches up.

### Creator Crash Mid-Poll

The creator is only a **distribution point** for the topic. Once voters have the topic and are connected to each other, the creator is not needed:

```
Creator             Voter A             Voter B             Voter C
   │                   │                   │                   │
   │══════════════════►│                   │                   │
   │══════════════════════════════════════►│                   │
   │══════════════════════════════════════════════════════════►│
   │                   │══════════════════►│                   │
   │                   │══════════════════════════════════════►│
   │                   │                   │══════════════════►│
   │                   │                   │                   │
   X  [Creator crashes]
   │                   │                   │                   │
            [Voters remain connected to each other]
                       │                   │                   │
            [VOTE_CAST gossip continues between A, B, C]
                       │◄─ VOTE_CAST ──────│                   │
                       │── VOTE_CAST ──────────────────────────►│
                       │                   │◄─ VOTE_CAST ──────│
                       │◄─ VOTE_CAST ──────────────────────────│
                       │                   │                   │
            [Poll closes by timeout — each node's local timer fires independently]
                       │                   │                   │
            [Each node closes, results are identical]
```

**Why this works:**
- Each voter has a local copy of the full poll state including `endsAt`
- Each voter runs its own `setTimeout` for the poll deadline
- Votes are gossiped peer-to-peer without routing through the creator
- The only capability lost when the creator crashes is the ability to **force-close** before timeout

### Offline Timeout Expiry

If a node was offline when the poll should have closed:

```
Timeline:
   t=0        Poll created (endsAt = t+60s)
   t=30       Node goes offline
   t=60       Poll timeout fires on all OTHER nodes → POLL_CLOSED broadcast
   t=90       Offline node comes back online
              │
              ▼
         Node reconnects to DHT (same topic still valid)
              │
              ▼
         Receives STATE_SYNC from peer
              │
              ▼
         mergePolls() sees remote.status === 'closed'
         → closed wins → local poll marked closed
              │
              ▼
         Node shows correct final results
```

**If the node was completely isolated** (no peers at all):

```
Node reconnects — no peers reachable yet
     │
     ▼
schedulePollClose() fires with remaining = max(0, endsAt - Date.now())
If Date.now() > endsAt → remaining = 0 → closes on next event loop tick
```

### Certificate Verification

```
User                    Renderer                  Main Process (node-forge)
  │                        │                              │
  │── drag .p12 file ─────►│                              │
  │── type PIN ────────────►│                              │
  │── click Verify ────────►│                              │
  │                        │── ipcRenderer.invoke ────────►│
  │                        │   cert:verify {data, password}│
  │                        │                              │
  │                        │                    parse DER  │
  │                        │                    check dates│
  │                        │                    extract CN │
  │                        │                    challenge- │
  │                        │                    response   │
  │                        │                              │
  │                        │◄── { ok, name, nif, issuer } ─│
  │                        │                              │
  │◄── identity badge ─────│                              │
  │    shown in UI          │                              │
  │                        │                              │
  │    [cert rejected]      │                              │
  │◄── error message ───────│                              │
  │    UI stays locked      │                              │
```

---

## Failure Scenarios and Recovery

### Scenario 1: Voter disconnects and reconnects

**Problem:** Voter A votes, disconnects, and reconnects. Will their vote be counted?

**Answer:** Yes. The vote was already broadcast and received by all connected peers before the disconnect. When Voter A reconnects, `STATE_SYNC` is exchanged — Voter A's vote is already in the remote state. `mergePolls()` keeps it (first-seen wins).

---

### Scenario 2: Network partition during voting

**Problem:** Voters A and B are in separate network partitions. A votes option 0, B votes option 1. When the partition heals, which votes win?

**Answer:** Both. The CRDT union merges all votes. Each voter's choice is kept. Neither vote is lost or overwritten.

---

### Scenario 3: Voter tries to vote twice

**Problem:** Voter A votes option 0, then sends a second vote for option 1.

**Answer:** The first vote wins. `castVote()` checks:
```javascript
if (voterId in state.currentPoll.votes) {
  publishState()
  return  // idempotent — no change
}
```
The second vote is silently dropped on every node in the network.

---

### Scenario 4: All nodes restart after poll creation, before any votes

**Problem:** The creator made a poll and shared the topic, then all nodes crashed. Can voters still join?

**Answer:** Partially. The DHT topic is still valid — any node that rejoins with the same 64-char hex will find each other. **However, poll state is in-memory only.** A restarted creator will have no poll, and voters will see an empty state. The creator must create a new poll.

> **Note:** This is a known limitation. Implementing [Autobase](https://github.com/holepunchto/autobase) would solve it by replicating the append-only event log across all peers, making state recoverable from any surviving node.

---

### Scenario 5: Poll timeout fires while creator is offline

**Problem:** Creator is offline when `endsAt` passes. Can the poll still close?

**Answer:** Yes. Every node runs its own `schedulePollClose()` timer locally. When the timer fires, the node marks the poll closed and broadcasts `POLL_CLOSED` to all connected peers. The first node whose timer fires triggers the close for the whole network. Since `Math.min(closedAt)` is used in the CRDT merge, the earliest close timestamp is preserved consistently.

---

### Scenario 6: Stale POLL_CLOSED for a previous poll

**Problem:** A stale `POLL_CLOSED` message arrives referencing an old poll ID.

**Answer:** Silently ignored. The handler checks:
```javascript
if (!state.currentPoll || message.pollId !== state.currentPoll.id) return
```

---

## IPC Architecture

The app has three separate JavaScript contexts, each isolated from the others:

```
┌────────────────────────────────────────────────────────────────┐
│ Renderer (Chrome sandbox)                                      │
│   - window.bridge.*  ← only API available                      │
│   - No require(), no Node APIs                                 │
│   - Communicates via contextBridge only                        │
└─────────────────────┬──────────────────────────────────────────┘
                      │ contextBridge (serialized IPC)
┌─────────────────────▼──────────────────────────────────────────┐
│ Main Process (Node.js / Electron)                              │
│   - ipcMain handlers                                           │
│   - node-forge certificate parsing                             │
│   - pear.run() spawns the Bare worker                          │
│   - Forwards worker IPC to renderer as Electron IPC events     │
└─────────────────────┬──────────────────────────────────────────┘
                      │ Bare.IPC (binary stream, newline-delimited JSON)
┌─────────────────────▼──────────────────────────────────────────┐
│ Bare Worker (Bare runtime — NOT Node.js)                       │
│   - Hyperswarm, P2P networking                                 │
│   - CRDT state machine                                         │
│   - Only Bare-compatible modules                               │
└────────────────────────────────────────────────────────────────┘
```

All IPC messages are newline-delimited JSON. Partial chunks are buffered until a `\n` is found before parsing.

---

## Message Protocol

### Renderer → Worker

| Type | Fields | Description |
|------|--------|-------------|
| `JOIN` | `key: string` | Voter joins a swarm by 64-char hex topic |
| `CREATE_POLL` | `question, options[], timeoutMs` | Creator creates a new poll |
| `CAST_VOTE` | `optionIndex: number` | Voter casts a vote |
| `CLOSE_POLL` | `reason?: string` | Creator force-closes the poll |
| `PING` | — | Liveness check |

### Worker → Renderer

| Type | Fields | Description |
|------|--------|-------------|
| `AWAITING_TOPIC` | `role, peerId` | Voter worker ready, waiting for topic |
| `READY` | `role, topic, peerId` | Worker joined swarm |
| `STATE` | `role, topic, poll, revision, peers` | Full state snapshot |
| `PEERS` | `count, topic` | Peer count changed |
| `PONG` | `topic, peerId, revision, role, peers, poll` | Response to PING |
| `error` | `code, message` | Error from any operation |

### Peer-to-Peer (over Hyperswarm TCP connections)

| Type | Description |
|------|-------------|
| `HELLO` | Initial greeting, triggers STATE_SYNC from receiver |
| `STATE_SYNC` | Full poll state, sent on connect and in response to HELLO |
| `CREATE_POLL` | New poll broadcast by creator |
| `VOTE_CAST` | Vote, gossiped to all peers |
| `POLL_CLOSED` | Poll closed, gossiped to all peers |

---

## Tech Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| Desktop shell | Electron 40 | Cross-platform GUI, Node.js main process |
| P2P runtime | Bare (pear-runtime) | Lightweight JS runtime for workers, Hyperswarm-native |
| Peer discovery | Hyperswarm 4 | Kademlia DHT, NAT traversal, no server needed |
| State merging | Custom CRDT | Grow-only vote set, closed-wins, eventual consistency |
| Certificate auth | node-forge | PKCS12 parsing, X.509 validation, RSA challenge-response |
| Identity | X.509 CN + serialNumber | Display name + voter NIF extracted from cert |
| Encoding | b4a | Buffer ↔ hex utilities, Bare-compatible |
