
class AegisCrypto {
    constructor() {
        this.sodium = null;
        this.identityKey = null; 
        this.signedPrekey = null;
        this.prekeys = [];
        this.sessions = {}; // remoteUserId -> SessionState
    }

    async init() {
        await sodium.ready;
        this.sodium = sodium;
        this.generateIdentity();
        this.generateSignedPrekey();
        this.generateOneTimePrekeys(5);
    }

    generateIdentity() {
        const key = this.sodium.crypto_box_keypair();
        this.identityKey = {
            publicKey: this.sodium.to_base64(key.publicKey),
            privateKey: key.privateKey
        };
    }

    generateSignedPrekey() {
        const key = this.sodium.crypto_box_keypair();
        this.signedPrekey = {
            publicKey: this.sodium.to_base64(key.publicKey),
            privateKey: key.privateKey
        };
    }

    generateOneTimePrekeys(count) {
        this.prekeys = [];
        for (let i = 0; i < count; i++) {
            const key = this.sodium.crypto_box_keypair();
            this.prekeys.push({
                publicKey: this.sodium.to_base64(key.publicKey),
                privateKey: key.privateKey
            });
        }
    }

    getBundle() {
        return {
            identityKey: this.identityKey.publicKey,
            signedPrekey: this.signedPrekey.publicKey,
            oneTimePrekey: this.prekeys.length > 0 ? this.prekeys[0].publicKey : null
        };
    }

    async initiateSession(remoteUserId, remoteBundle) {
        const { identityKey: remoteIK, signedPrekey: remoteSPK } = remoteBundle;
        
        // Use crypto_kx for a robust shared secret derivation
        const clientKx = this.sodium.crypto_kx_client_session_keys(
            this.identityKey.privateKey,
            this.identityKey.publicKey,
            this.sodium.from_base64(remoteIK)
        );
        
        // We use the sharedRx as the base for our root key
        const rootKey = clientKx.sharedRx;
        
        this.sessions[remoteUserId] = {
            rootKey: rootKey,
            sendChainKey: rootKey,
            recvChainKey: rootKey,
            remoteIK: remoteIK
        };
        
        return rootKey;
    }

    async respondToSession(remoteUserId, remoteBundle) {
        const { identityKey: remoteIK } = remoteBundle;
        
        const serverKx = this.sodium.crypto_kx_server_session_keys(
            this.identityKey.privateKey,
            this.identityKey.publicKey,
            this.sodium.from_base64(remoteIK)
        );
        
        const rootKey = serverKx.sharedRx;
        
        this.sessions[remoteUserId] = {
            rootKey: rootKey,
            sendChainKey: rootKey,
            recvChainKey: rootKey,
            remoteIK: remoteIK
        };
        
        return rootKey;
    }

    _ratchet(chainKey) {
        // Use a simple HMAC-based ratchet
        const nextChainKey = this.sodium.crypto_auth(32, "next_key", chainKey);
        const messageKey = this.sodium.crypto_auth(32, "msg_key", chainKey);
        return { nextChainKey, messageKey };
    }

    encrypt(remoteUserId, plaintext) {
        const session = this.sessions[remoteUserId];
        if (!session) throw new Error("No session established");
        
        const { nextChainKey, messageKey } = this._ratchet(session.sendChainKey);
        session.sendChainKey = nextChainKey;
        
        const nonce = this.sodium.randombytes_buf(this.sodium.crypto_secretbox_NONCEBYTES);
        const ciphertext = this.sodium.crypto_secretbox_easy(
            this.sodium.from_base64(plaintext), 
            nonce, 
            messageKey
        );
        
        return {
            nonce: this.sodium.to_base64(nonce),
            ciphertext: this.sodium.to_base64(ciphertext)
        };
    }

    decrypt(remoteUserId, encrypted) {
        const session = this.sessions[remoteUserId];
        if (!session) throw new Error("No session established");
        
        const { nextChainKey, messageKey } = this._ratchet(session.recvChainKey);
        session.recvChainKey = nextChainKey;
        
        const nonce = this.sodium.from_base64(encrypted.nonce);
        const ciphertext = this.sodium.from_base64(encrypted.ciphertext);
        
        const plaintext = this.sodium.crypto_secretbox_open_easy(
            ciphertext, 
            nonce, 
            messageKey
        );
        
        return this.sodium.to_base64(plaintext);
    }
}

const aegisCrypto = new AegisCrypto();
