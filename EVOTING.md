# P2P E-Voting

Sistema de votación descentralizado para HackUPC 2026. La interfaz de voto **vive en el cliente del votante**, no en el creator. El creator solo se usa como **pasarela para repartir el hash de la votación**, y una vez repartido es prescindible.

---

## Idea clave

```
+-------------------+              +---------------------+
|   Creator (CLI)   |              |  Voter (cliente A)  |
|                   |              |                     |
|  - genera hash    |  -- hash -->|  paste -> JOIN      |
|  - crea la poll   |   (pasarela) |  vota               |
|  - lo expone      |              |                     |
+-------------------+              +---------------------+
                                              |
                                              | hash compartido fuera de banda
                                              | (chat, QR, papel, ...)
                                              v
                                   +---------------------+
                                   |  Voter (cliente B)  |
                                   |  paste -> JOIN      |
                                   |  vota               |
                                   +---------------------+
```

- El **hash** identifica la votación. Se genera aleatoriamente por sesión del creator.
- El creator es la **fuente original** del hash, pero no es indispensable: cualquier votante con el hash y conexión a la DHT puede unirse y servir el estado a otros.
- Crear votaciones es un procedimiento **interno/admin**: solo el binario arrancado con `--create` puede hacerlo. El cliente de votación nunca expone esa acción.

---

## Roles

### Creator (admin / pasarela)

Se arranca con `--create` y los parámetros de la votación. Su trabajo es:

1. Generar un hash de 32 bytes aleatorio (el "topic").
2. Anunciar ese topic en la DHT de Hyperswarm.
3. Crear la poll en memoria y emitirla a los peers.
4. Mostrar el hash en pantalla para que un humano lo difunda (mensajería, QR, voz).

**No vota ni toma decisiones de cierre.** Si se cae, no pasa nada (ver "Resiliencia").

### Voter (cliente de voto)

Se arranca sin flags. Al iniciarse:

1. Carga la UI de "esperando hash".
2. El usuario pega el hash recibido.
3. Se conecta a la DHT con ese hash, descubre peers (creator y/o otros votantes).
4. Recibe el estado de la poll por `STATE_SYNC` y muestra la pregunta.
5. Vota una vez (un voto por `peerId`, primero gana).

Una vez unido, también muestra el hash para que pueda **re-compartirlo** si el creator dejó de estar accesible.

---

## Cómo se ejecuta

Creator (en la máquina del organizador):

```sh
npm start -- --create \
  --question="¿Pizza o burger?" \
  --options="Pizza,Burger,Tacos" \
  --timeout=30
```

> Usa `--flag=valor` (sin espacio) para que `npm start --` no rompa los argumentos con espacios.

Votantes (cada uno en su máquina, o varios en local con `--storage` distinto):

```sh
npm start -- --storage=/tmp/voter1
```

El votante verá una caja con un input para pegar el hash. Tras pulsar **Join**, aparece la votación.

---

## Arquitectura

```
electron/
  main.js        proceso principal: parsea CLI, arranca worker, expone bridge
  preload.js     bridge.config(), bridge.startWorker(), bridge.writeWorkerIPC()
renderer/
  index.html    UI: topic-card / join-card / poll-card (mostradas por rol/estado)
  app.js        renderiza, gestiona join y voto, polling de estado
workers/
  main.js       lógica P2P (Hyperswarm), CRDT de votos, timeouts
```

### Capas

- **Descubrimiento:** [Hyperswarm](https://github.com/holepunchto/hyperswarm) sobre Kademlia DHT. Anunciar/buscar el topic.
- **Transporte:** conexiones P2P cifradas que monta Hyperswarm encima del DHT.
- **Lógica:** un worker `bare` por instancia (`workers/main.js`). Mantiene el estado y conversa con la UI por IPC.
- **Presentación:** `renderer/app.js` muestra solo lo que corresponde al rol.

### Flujo

1. Creator arranca → genera topic aleatorio → `swarm.join(topic)` → crea la poll → la emite.
2. Humano copia el topic del UI del creator y lo difunde por cualquier canal.
3. Voter pega el topic → worker recibe `JOIN` → `swarm.join(topic)` → conecta con creator y/u otros votantes.
4. En cada conexión nueva, ambos peers intercambian `HELLO` + `STATE_SYNC`. El receptor hace **merge** del estado.
5. Voter pulsa una opción → worker emite `VOTE_CAST` → todos los peers lo aplican y reemiten (gossip).
6. En `endsAt`, **cada peer cierra la poll por su cuenta** (su propio `setTimeout`). El cierre se propaga vía `POLL_CLOSED`.

---

## Resiliencia: ¿por qué un votante sigue funcionando si el creator se cae?

Esto es el motivo de la separación entre "interfaz de voto local" y "creator como pasarela". Hay tres razones independientes:

### 1. La interfaz de voto es local

El cliente del votante (Electron + worker bare) está instalado y corre en la máquina del votante. **No descarga nada del creator**. Si el creator se apaga, el votante sigue teniendo el ejecutable, la UI y la lógica P2P. Esto evita el single point of failure que tiene una webapp clásica donde el navegador depende del servidor para servir el JS.

### 2. El descubrimiento P2P no depende del creator

Hyperswarm hace `lookup` y `announce` contra la **DHT distribuida**, no contra el creator. Cuando un votante quiere descubrir peers de un topic, pregunta a la DHT global cuáles están anunciando ese hash. Cualquier nodo que esté anunciándolo es respuesta válida.

Mientras al menos un peer (creator o votante) esté online y anunciando el topic, otros pueden conectarse. El creator no es un punto de paso obligatorio.

### 3. El estado y el cierre se replican en cada peer

`state.currentPoll` vive en la memoria del worker de **cada** nodo. Cuando un votante recibe `STATE_SYNC`, ya tiene la copia completa: pregunta, opciones, votos hasta el momento, fecha de cierre. A partir de ahí ese votante puede servir la poll a los siguientes que lleguen.

El timeout también es local: cada peer programa su propio `setTimeout` con base en el campo `endsAt` (timestamp absoluto). Llegada la hora, ese peer cierra la poll por sí mismo y emite `POLL_CLOSED`. **La votación termina a tiempo aunque el creator esté apagado desde el segundo 1.**

### Escenarios

| Caso | Resultado |
|------|-----------|
| Creator vivo | Votantes conectan al creator y entre ellos. Todo funciona. |
| Creator muere DESPUÉS de que ≥1 votante se haya conectado | El votante anuncia el topic en la DHT. Nuevos votantes lo encuentran. La votación sigue. |
| Creator muere ANTES de que ningún votante haya conectado | Si nadie más anuncia el topic, los nuevos no encuentran a quién unirse. Solución: relanzar el creator o que un participante lo levante. |
| Todos los votantes se desconectan a la vez | El estado en memoria se pierde. Limitación conocida. |

---

## Convergencia de votos (CRDT)

El conjunto de votos es un mapa `{ peerId -> optionIndex }` con semántica "**primero gana**":

- Cada votante registra solo el primer voto de cada `peerId`. Los siguientes se ignoran.
- Al sincronizar tras una partición de red, los mapas se **fusionan por unión**.
- `status` también se merge-ea: si cualquier lado lo tiene como `closed`, el resultado fusionado es `closed` con el `closedAt` más temprano.

Esto evita pérdida de votos en redes inestables, incluso sin coordinación central.

---

## Protocolo de mensajes (entre peers)

JSON terminados en `\n`.

| Tipo | Origen | Cuándo | Efecto |
|------|--------|--------|--------|
| `HELLO` | cualquier peer | al abrir conexión | el otro responde con `STATE_SYNC` |
| `STATE_SYNC` | cualquier peer | tras `HELLO`, o al cambiar de estado | el receptor mergea con su poll |
| `CREATE_POLL` | creator | tras crear la poll | los demás adoptan la poll si no tienen ninguna |
| `VOTE_CAST` | votante | al votar localmente | los demás añaden el voto y reemiten |
| `POLL_CLOSED` | quien cierra primero | en `endsAt` | los demás marcan `status='closed'` |

Mensajes locales (renderer ↔ worker, IPC):

| Tipo | Dirección | Significado |
|------|-----------|-------------|
| `AWAITING_TOPIC` | worker → UI | voter listo, esperando que el usuario pegue el hash |
| `READY` | worker → UI | swarm unido, viene `peerId` y rol |
| `STATE` | worker → UI | snapshot completo del estado (poll, peers) |
| `PEERS` | worker → UI | número de peers conectados |
| `PONG` | worker → UI | respuesta a `PING`, polling cada 500 ms |
| `JOIN` | UI → worker | (solo voter) "únete a este hash" |
| `CAST_VOTE` | UI → worker | (solo voter) el usuario clicó una opción |

---

## Limitaciones conocidas

- **Sin persistencia en disco.** El estado vive solo en memoria. Si TODOS los peers se cierran simultáneamente, la votación se pierde.
- **`peerId` aleatorio por arranque.** Cerrar y volver a abrir un cliente genera un nuevo `peerId`, que cuenta como otro votante. Aceptable para una demo.
- **Sin firma criptográfica de votos.** Cualquier nodo en el swarm puede emitir `VOTE_CAST` con un `peerId` arbitrario. La integridad depende del control sobre quién entra al swarm con el hash.
- **Una poll a la vez** por sesión del creator. Otra sesión = otro hash = otra votación independiente.
- **Hash compartido fuera de banda.** No incluye QR generation aún; copia/pega el hex.
