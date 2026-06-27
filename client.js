
const serverUrl = "ws://localhost:8080/ws";
let socket;
let localUserId;
let peerConnection;
let dataChannel;
let currentRemoteUserId;

const setupDiv = document.getElementById('setup');
const chatDiv = document.getElementById('chat');
const userIdInput = document.getElementById('userId');
const btnConnect = document.getElementById('btnConnect');
const peersSpan = document.getElementById('peers');
const btnRefreshPeers = document.getElementById('btnRefreshPeers');
const peerIdInput = document.getElementById('peerId');
const btnCall = document.getElementById('btnCall');
const messagesDiv = document.getElementById('messages');
const msgInput = document.getElementById('msgInput');
const btnSend = document.getElementById('btnSend');

function log(text, type = 'sys') {
    const div = document.createElement('div');
    div.className = `msg ${type}`;
    div.textContent = text;
    messagesDiv.appendChild(div);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

btnConnect.onclick = async () => {
    localUserId = userIdInput.value.trim();
    if (!localUserId) return alert("Enter User ID");

    await aegisCrypto.init();

    socket = new WebSocket(serverUrl);

    socket.onopen = () => {
        const bundle = aegisCrypto.getBundle();
        socket.send(JSON.stringify({ 
            type: 'register', 
            from: localUserId, 
            payload: JSON.stringify(bundle) 
        }));
        log("Connecting to signaling server...");
    };

    socket.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'registered') {
            log(`Registered as ${localUserId}. System Ready.`);
            setupDiv.classList.remove('active');
            chatDiv.classList.add('active');
        } else if (msg.type === 'peers') {
            const peers = JSON.parse(msg.payload);
            peersSpan.textContent = peers.join(", ") || "None";
        } else if (msg.type === 'bundle') {
            await handleBundleReceived(msg);
        } else if (msg.type === 'send_signal') {
            handleSignal(msg);
        } else if (msg.type === 'error') {
            log(`Server Error: ${msg.payload}`, 'sys');
        }
    };

    socket.onerror = (err) => log(`WebSocket Error: ${err}`, 'sys');
};

btnRefreshPeers.onclick = () => {
    socket.send(JSON.stringify({ type: 'get_peers', from: localUserId }));
};

async function initPeerConnection(remoteUserId) {
    if (peerConnection) return peerConnection;

    peerConnection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.send(JSON.stringify({
                type: 'send_signal',
                from: localUserId,
                to: remoteUserId,
                payload: JSON.stringify({ type: 'ice', candidate: event.candidate })
            }));
        }
    };

    peerConnection.ondatachannel = (event) => {
        setupDataChannel(event.channel, remoteUserId);
    };

    return peerConnection;
}

function setupDataChannel(channel, remoteUserId) {
    dataChannel = channel;
    currentRemoteUserId = remoteUserId;
    dataChannel.onopen = () => log(`P2P Secure Channel established with ${remoteUserId}!`, "sys");
    dataChannel.onmessage = (event) => {
        try {
            const encrypted = JSON.parse(event.data);
            log(`Incoming Cipher: ${encrypted.ciphertext.substring(0, 32)}...`, 'cipher');
            const decrypted = aegisCrypto.decrypt(currentRemoteUserId, encrypted);
            log(`${currentRemoteUserId}: ${decrypted}`, "remote");
        } catch (e) {
            log(`Decryption failed: ${e.message}`, "sys");
        }
    };
    dataChannel.onclose = () => log("P2P Connection Closed.", "sys");
}

btnCall.onclick = async () => {
    const remoteUserId = peerIdInput.value.trim();
    if (!remoteUserId) return alert("Enter Peer ID");
    currentRemoteUserId = remoteUserId;

    log(`Requesting identity bundle for ${remoteUserId}...`);
    socket.send(JSON.stringify({ type: 'get_bundle', from: localUserId, to: remoteUserId }));
};

async function handleBundleReceived(msg) {
    const remoteUserId = currentRemoteUserId;
    if (!remoteUserId) return;
    
    const bundle = JSON.parse(msg.payload);
    log(`Bundle received. Establishing shared secret...`);
    
    if (window.pendingOffer) {
        await aegisCrypto.respondToSession(remoteUserId, bundle);
        await answerOffer();
    } else {
        await aegisCrypto.initiateSession(remoteUserId, bundle);
        
        const pc = await initPeerConnection(remoteUserId);
        const dc = pc.createDataChannel("chat");
        setupDataChannel(dc, remoteUserId);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.send(JSON.stringify({
            type: 'send_signal',
            from: localUserId,
            to: remoteUserId,
            payload: JSON.stringify({ type: 'offer', sdp: offer.sdp })
        }));
    }
}

async function handleSignal(msg) {
    const remoteUserId = msg.from;
    const signal = JSON.parse(msg.payload);

    if (signal.type === 'offer') {
        log(`Incoming call from ${remoteUserId}...`);
        currentRemoteUserId = remoteUserId;
        
        socket.send(JSON.stringify({ type: 'get_bundle', from: localUserId, to: remoteUserId }));
        window.pendingOffer = signal.sdp;
    } else if (signal.type === 'answer') {
        log(`Connection accepted by ${remoteUserId}.`);
        await initPeerConnection(remoteUserId);
        await peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }));
    } else if (signal.type === 'ice') {
        await initPeerConnection(remoteUserId);
        await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
}

async function answerOffer() {
    if (!window.pendingOffer) return;
    const remoteUserId = currentRemoteUserId;
    
    const pc = await initPeerConnection(remoteUserId);
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: window.pendingOffer }));
    
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    socket.send(JSON.stringify({
        type: 'send_signal',
        from: localUserId,
        to: remoteUserId,
        payload: JSON.stringify({ type: 'answer', sdp: answer.sdp })
    }));
    
    window.pendingOffer = null;
}

btnSend.onclick = () => {
    const text = msgInput.value.trim();
    if (!text) return;
    if (!dataChannel || dataChannel.readyState !== 'open') {
        return alert("No active P2P connection!");
    }

    const remoteUserId = currentRemoteUserId;
    
    try {
        const encrypted = aegisCrypto.encrypt(remoteUserId, text);
        log(`Outgoing Cipher: ${encrypted.ciphertext.substring(0, 32)}...`, 'cipher');
        dataChannel.send(JSON.stringify(encrypted));
        log(`Me: ${text}`, "local");
    } catch (e) {
        log(`Encryption failed: ${e.message}`, "sys");
    }
    msgInput.value = "";
};
