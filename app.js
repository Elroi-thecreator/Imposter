const WORD_CATEGORIES = {
  "Places & Landmarks": ["Eiffel Tower", "Pyramid", "Hollywood", "Volcano", "Hogwarts", "Airport", "Casino", "Aquarium", "Hospital"],
  "Food & Drink": ["Pizza", "Sushi", "Chocolate", "Tacos", "Burger", "Pancakes", "Bubble Tea", "Spaghetti", "Donut"],
  "Pop Culture & Fantasy": ["Superhero", "Dragon", "Wizard", "Unicorn", "Pirate", "Ninja", "Astronaut", "Alien", "Zombie"],
  "Animals & Nature": ["Penguin", "Dinosaur", "Waterfall", "Tornado", "Octopus", "Kangaroo", "Flamingo", "Sloth", "Panda"]
};

let peer = null, isHost = false, roomCode = "", myName = "", myPeerId = "";
let players = [];
let hostConn = null, secretWord = "", currentCategory = "", impostorId = "";
let isChaosRound = false;
let submittedClues = {};
let votes = {};
let joinRetryCount = 0;
// Track game phase so we know what screen to show reconnecting players
let gamePhase = "LOBBY"; 

window.onload = () => {
  const codeFromUrl = new URLSearchParams(window.location.search).get('room');
  
  // Check session storage for auto-fill after refresh
  const savedName = sessionStorage.getItem("impostor_name");
  if (savedName) {
    document.getElementById('player-name').value = savedName;
  }

  if (codeFromUrl) {
    isHost = false;
    roomCode = codeFromUrl.toUpperCase();
    document.getElementById('join-code').value = roomCode;
    document.getElementById('host-start-container').classList.add('hidden');
    document.getElementById('player-join-container').classList.remove('hidden');
    document.getElementById('welcome-subtext').innerText = "Joining existing game room";
  } else {
    isHost = true;
    document.getElementById('host-start-container').classList.remove('hidden');
    document.getElementById('player-join-container').classList.add('hidden');
    document.getElementById('welcome-subtext').innerText = "Host a new party game";
  }
};

function getName() {
  const name = document.getElementById('player-name').value.trim();
  if (!name) { alert("Please enter your nickname!"); return null; }
  sessionStorage.setItem("impostor_name", name);
  return name;
}

function resetJoinBtn() {
  const btn = document.getElementById('join-btn');
  btn.disabled = false;
  btn.innerText = "Join Game";
  joinRetryCount = 0;
}

function initPeer(id = null) {
  const config = {
    debug: 1,
    config: {
      iceServers: [
        // Standard STUN servers for IP discovery
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        
        // Free Public TURN servers from OpenRelay (Metered) to bypass strict NATs/Firewalls
        {
          urls: "turn:openrelay.metered.ca:80",
          username: "openrelayproject",
          credential: "openrelayproject"
        },
        {
          urls: "turn:openrelay.metered.ca:443",
          username: "openrelayproject",
          credential: "openrelayproject"
        },
        {
          urls: "turn:openrelay.metered.ca:443?transport=tcp",
          username: "openrelayproject",
          credential: "openrelayproject"
        }
      ]
    }
  };
  return id ? new Peer(id, config) : new Peer(config);
}

function createRoom() {
  myName = getName(); if (!myName) return;
  const createBtn = document.getElementById('create-btn');
  createBtn.disabled = true;
  createBtn.innerText = "Creating Room...";

  isHost = true;
  roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
  
  if (peer) peer.destroy();
  peer = initPeer(`impostor-room-${roomCode}`);

  peer.on('open', (id) => {
    myPeerId = id;
    players = [{ id: id, name: myName, conn: null }];
    gamePhase = "LOBBY";
    showScreen('lobby-screen');
    updatePlayerList();
  });

  peer.on('connection', (conn) => {
    conn.on('data', (data) => handleHostData(conn, data));
  });

  peer.on('error', (err) => {
    alert("Error creating room. Please try tapping Create again!");
    createBtn.disabled = false;
    createBtn.innerText = "Create Game Room";
  });
}

function joinRoom() {
  myName = getName(); if (!myName) return;

  const joinBtn = document.getElementById('join-btn');
  joinBtn.disabled = true;
  joinBtn.innerText = joinRetryCount > 0 ? `Retrying (${joinRetryCount}/3)...` : "Connecting...";

  if (peer) {
    peer.destroy();
    peer = null;
  }

  setTimeout(() => {
    peer = initPeer();

    peer.on('open', (id) => {
      myPeerId = id;
      
      hostConn = peer.connect(`impostor-room-${roomCode}`, { reliable: true });

      let connectionTimeout = setTimeout(() => {
        if (!hostConn || !hostConn.open) {
          handleJoinFailure("Connection timed out. Ensure Host room is active.");
        }
      }, 12000); 

      hostConn.on('open', () => {
        clearTimeout(connectionTimeout);
        setTimeout(() => {
          hostConn.send({ type: 'JOIN', name: myName });
        }, 500);
      });

      hostConn.on('data', (data) => handleClientData(data));

      hostConn.on('error', () => {
        clearTimeout(connectionTimeout);
        handleJoinFailure("Host room not found or offline.");
      });
    });

    peer.on('error', () => {
      handleJoinFailure("Failed to reach matchmaking server.");
    });
  }, joinRetryCount > 0 ? 1000 : 0); 
}

function handleJoinFailure(reason) {
  if (joinRetryCount < 2) {
    joinRetryCount++;
    setTimeout(() => joinRoom(), 3000);
  } else {
    alert(`${reason}\n\nTips:\n1. Make sure Host is on the Lobby or Game screen.\n2. Re-enter your name if needed.\n3. Try switching off corporate/school Wi-Fi.`);
    resetJoinBtn();
  }
}

function handleHostData(conn, data) {
  if (data.type === 'JOIN') {
    const nameLower = data.name.trim().toLowerCase();
    
    // Find existing index if player is reconnecting after a refresh/sleep
    const existingIdx = players.findIndex(
      p => p.name.trim().toLowerCase() === nameLower
    );

    if (existingIdx !== -1) {
      const existingPlayer = players[existingIdx];
      
      // Close the ghost connection if it exists
      if (existingPlayer.conn && existingPlayer.conn !== conn) {
        try { existingPlayer.conn.close(); } catch(e) {}
      }

      // FIX: If the reconnecting player is the Impostor, update the impostorId to their new PeerJS ID
      if (existingPlayer.id === impostorId) {
        impostorId = conn.peer;
      }

      // Update the player's current connection and ID
      players[existingIdx].conn = conn;
      players[existingIdx].id = conn.peer;
      
      // Catch the reconnected player up on the current game phase
      if (gamePhase === "LOBBY") {
        broadcastLobbyState();
      } else if (gamePhase === "IN_GAME" || gamePhase === "VOTING") {
        const isImp = isChaosRound || (players[existingIdx].id === impostorId);
        conn.send({
          type: 'GAME_START',
          role: isImp ? 'IMPOSTOR' : 'CREWMATE',
          word: isImp ? null : secretWord,
          category: currentCategory
        });
        
        if (Object.keys(submittedClues).length > 0) {
          conn.send({ type: 'CLUES_UPDATE', clues: submittedClues });
        }

        if (gamePhase === "VOTING") {
          conn.send({ 
            type: 'START_VOTING', 
            playerList: players.map(p => ({ id: p.id, name: p.name })), 
            clues: submittedClues 
          });
        }
      }
      return;
    }

    players.push({ id: conn.peer, name: data.name, conn: conn });
    updatePlayerList();
    broadcastLobbyState();
  } else if (data.type === 'SEND_CLUE') {
    submittedClues[data.author] = data.clue;
    broadcastClues();
  } else if (data.type === 'CAST_VOTE') {
    votes[data.targetId] = (votes[data.targetId] || 0) + 1;
    if (Object.values(votes).reduce((a,b)=>a+b, 0) >= players.length) {
      tallyVotes();
    }
  }
}

function handleClientData(data) {
  if (data.type === 'JOIN_REJECTED') {
    alert(data.reason);
    resetJoinBtn();
    if (peer) peer.destroy();
    showScreen('home-screen');
  } else if (data.type === 'LOBBY_STATE') {
    updatePlayerListFromNames(data.playerNames);
    showScreen('lobby-screen');
  } else if (data.type === 'GAME_START') {
    showGameScreen(data.role, data.word, data.category);
  } else if (data.type === 'CLUES_UPDATE') {
    renderClues(data.clues);
  } else if (data.type === 'START_VOTING') {
    showVotingScreen(data.playerList, data.clues);
  } else if (data.type === 'GAME_OVER') {
    showResultScreen(data.ejectedName, data.isImpostor, data.secretWord, data.impostorName, data.isChaos, data.isTie);
  }
}

function toggleCustomWordInput() {
  const val = document.getElementById('category-select').value;
  document.getElementById('custom-word-group').classList.toggle('hidden', val !== 'CUSTOM');
}

function hostStartGame() {
  if (players.length < 3) return alert("You need at least 3 players to start!");

  const catVal = document.getElementById('category-select').value;
  if (catVal === 'CUSTOM') {
    secretWord = document.getElementById('custom-word-input').value.trim();
    currentCategory = "Custom Choice";
    if (!secretWord) return alert("Please enter a custom word!");
  } else if (catVal === 'RANDOM') {
    const keys = Object.keys(WORD_CATEGORIES);
    currentCategory = keys[Math.floor(Math.random() * keys.length)];
    const list = WORD_CATEGORIES[currentCategory];
    secretWord = list[Math.floor(Math.random() * list.length)];
  } else {
    currentCategory = catVal;
    const list = WORD_CATEGORIES[currentCategory];
    secretWord = list[Math.floor(Math.random() * list.length)];
  }

  const chaosSetting = document.getElementById('chaos-mode-select').value;
  if (chaosSetting === 'ALWAYS') isChaosRound = true;
  else if (chaosSetting === 'SURPRISE') isChaosRound = (Math.random() < 0.15);
  else isChaosRound = false;

  const impostorIdx = Math.floor(Math.random() * players.length);
  impostorId = players[impostorIdx].id;
  submittedClues = {};
  votes = {};
  gamePhase = "IN_GAME";

  players.forEach((p) => {
    const isImp = isChaosRound || (p.id === impostorId);
    const payload = {
      type: 'GAME_START',
      role: isImp ? 'IMPOSTOR' : 'CREWMATE',
      word: isImp ? null : secretWord,
      category: currentCategory
    };

    if (p.conn) p.conn.send(payload);
    else showGameScreen(payload.role, payload.word, payload.category);
  });
}

function showGameScreen(role, word, category) {
  showScreen('game-screen');
  document.getElementById('clue-input-box').classList.remove('hidden');
  document.getElementById('clue-text-input').value = "";
  document.getElementById('submit-clue-btn').disabled = false;
  document.getElementById('submit-clue-btn').innerText = "Send Clue";
  document.getElementById('clue-board-display').innerHTML = `<p style="color:var(--subtext); font-size:0.85rem; text-align:center; margin:10px 0;">Waiting for clues...</p>`;

  const display = document.getElementById('role-display');
  const hint = document.getElementById('category-hint');

  if (role === 'IMPOSTOR') {
    display.innerText = "🚨 YOU ARE THE IMPOSTOR!";
    display.style.color = "var(--accent)";
    hint.innerText = `Category Hint: ${category}`;
  } else {
    display.innerText = `Word: ${word}`;
    display.style.color = "var(--success)";
    hint.innerText = `Category: ${category}`;
  }

  if (isHost) document.getElementById('host-discussion-controls').classList.remove('hidden');
}

function submitClue() {
  const clue = document.getElementById('clue-text-input').value.trim();
  if (!clue) return alert("Please type a clue!");

  const btn = document.getElementById('submit-clue-btn');
  btn.disabled = true;
  btn.innerText = "Clue Sent ✓";

  if (isHost) {
    submittedClues[myName] = clue;
    broadcastClues();
  } else {
    hostConn.send({ type: 'SEND_CLUE', author: myName, clue: clue });
  }
}

function broadcastClues() {
  players.forEach(p => {
    if (p.conn) p.conn.send({ type: 'CLUES_UPDATE', clues: submittedClues });
    else renderClues(submittedClues);
  });
}

function renderClues(cluesObj) {
  const board = document.getElementById('clue-board-display');
  const keys = Object.keys(cluesObj);
  if (keys.length === 0) return;

  board.innerHTML = keys.map(author => `
    <div class="clue-item"><span class="clue-author">${author}:</span> "${cluesObj[author]}"</div>
  `).join('');
}

function hostStartVoting() {
  gamePhase = "VOTING";
  const playerListPayload = players.map(p => ({ id: p.id, name: p.name }));
  players.forEach(p => {
    if (p.conn) p.conn.send({ type: 'START_VOTING', playerList: playerListPayload, clues: submittedClues });
    else showVotingScreen(playerListPayload, submittedClues);
  });
}

function showVotingScreen(playerListPayload, cluesObj) {
  showScreen('voting-screen');

  const summary = document.getElementById('voting-clues-summary');
  const keys = Object.keys(cluesObj || {});
  summary.innerHTML = keys.length ? keys.map(author => `
    <div class="clue-item"><span class="clue-author">${author}:</span> "${cluesObj[author]}"</div>
  `).join('') : `<p style="color:var(--subtext); font-size:0.8rem; margin:5px 0;">No written clues submitted.</p>`;

  const listEl = document.getElementById('vote-options-list');
  listEl.innerHTML = playerListPayload.map(p => `
    <button class="vote-btn" onclick="submitVote('${p.id}')">Vote for ${p.name}</button>
  `).join('');
}

function submitVote(targetId) {
  document.getElementById('vote-options-list').innerHTML = "<p style='color:var(--subtext)'>Vote submitted! Waiting for others...</p>";
  if (isHost) {
    votes[targetId] = (votes[targetId] || 0) + 1;
    if (Object.values(votes).reduce((a,b)=>a+b, 0) >= players.length) tallyVotes();
  } else {
    hostConn.send({ type: 'CAST_VOTE', targetId: targetId });
  }
}

function tallyVotes() {
  gamePhase = "RESULT";
  let maxVotes = 0, ejectedId = null, isTie = false;
  const voteCounts = {};
  
  for (let id in votes) {
    const count = votes[id];
    voteCounts[count] = (voteCounts[count] || 0) + 1;
    if (count > maxVotes) {
      maxVotes = count;
      ejectedId = id;
    }
  }

  if (voteCounts[maxVotes] > 1) isTie = true;

  const ejectedPlayer = players.find(p => p.id === ejectedId);
  const impostorPlayer = players.find(p => p.id === impostorId);
  const isImp = isChaosRound || (!isTie && ejectedId === impostorId);

  players.forEach(p => {
    const payload = {
      type: 'GAME_OVER',
      ejectedName: (isTie || !ejectedPlayer) ? "Tie / Skip" : ejectedPlayer.name,
      isImpostor: isImp,
      secretWord: secretWord,
      impostorName: isChaosRound ? "Everyone" : (impostorPlayer ? impostorPlayer.name : "Unknown"),
      isChaos: isChaosRound,
      isTie: isTie
    };
    if (p.conn) p.conn.send(payload);
    else showResultScreen(payload.ejectedName, payload.isImpostor, payload.secretWord, payload.impostorName, payload.isChaos, payload.isTie);
  });
}

function showResultScreen(ejectedName, isImpostor, secretWord, impostorName, isChaos, isTie) {
  showScreen('result-screen');
  const title = document.getElementById('result-title');
  const details = document.getElementById('result-details');

  if (isChaos) {
    title.innerText = "🌀 CHAOS ROUND!";
    title.style.color = "var(--chaos)";
    details.innerHTML = `
      <p style="font-size:1.1rem; margin-top:0;">💥 <strong>EVERYONE WAS THE IMPOSTOR!</strong></p>
      <hr style="border:0; border-top:1px solid var(--border); margin:10px 0;">
      <p style="font-size:0.95rem; color:var(--subtext); margin:5px 0;">Nobody had the secret word: <strong>${secretWord}</strong></p>
    `;
  } else {
    if (isTie) {
      title.innerText = "⚖️ Tie Vote!";
      title.style.color = "var(--subtext)";
    } else if (isImpostor) {
      title.innerText = "🎉 Crewmates Win!";
      title.style.color = "var(--success)";
    } else {
      title.innerText = "🚨 Impostor Wins!";
      title.style.color = "var(--accent)";
    }

    details.innerHTML = `
      <p style="font-size:1.1rem; margin-top:0;"><strong>${ejectedName}</strong> ${isTie ? 'were tied in votes' : 'was voted out'}.</p>
      <hr style="border:0; border-top:1px solid var(--border); margin:10px 0;">
      <p style="font-size:0.95rem; color:var(--subtext); margin:5px 0;">The Impostor was: <strong>${impostorName}</strong></p>
      <p style="font-size:0.95rem; color:var(--subtext); margin:5px 0;">Secret Word: <strong>${secretWord}</strong></p>
    `;
  }

  if (isHost) {
    document.getElementById('next-round-btn').classList.remove('hidden');
    document.getElementById('client-wait-lobby').classList.add('hidden');
  } else {
    document.getElementById('next-round-btn').classList.add('hidden');
    document.getElementById('client-wait-lobby').classList.remove('hidden');
  }
}

function hostReturnToLobby() {
  isChaosRound = false;
  submittedClues = {};
  votes = {};
  gamePhase = "LOBBY";
  broadcastLobbyState();
  showScreen('lobby-screen');
}

function showScreen(id) {
  ['home-screen', 'lobby-screen', 'game-screen', 'voting-screen', 'result-screen'].forEach(s => {
    document.getElementById(s).classList.add('hidden');
  });
  document.getElementById(id).classList.remove('hidden');
  if (id === 'lobby-screen' && isHost) {
    document.getElementById('host-controls').classList.remove('hidden');
    document.getElementById('waiting-msg').classList.add('hidden');
  }
}

function updatePlayerList() { updatePlayerListFromNames(players.map(p => p.name)); }
function updatePlayerListFromNames(names) {
  document.getElementById('player-list-display').innerHTML = names.map(n => `<div class="player-item"><span>• ${n}</span></div>`).join('');
}
function broadcastLobbyState() {
  const names = players.map(p => p.name);
  players.forEach(p => { if (p.conn) p.conn.send({ type: 'LOBBY_STATE', playerNames: names }); });
}
function copyInviteLink() {
  const link = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
  navigator.clipboard.writeText(link).then(() => alert("Link copied to clipboard!"));
}
