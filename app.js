// Description: Bridge MQTT+UDP to WebSocket
// Author: terrence@tenclass.com
// Date: 2025-03-12

require('dotenv').config();
const net = require('net');
const debugModule = require('debug');
const debug = debugModule('mqtt-server');
const crypto = require('crypto');
const dgram = require('dgram');
const Emitter = require('events');
const WebSocket = require('ws');
const { MQTTProtocol } = require('./mqtt-protocol');
const { ConfigManager } = require('./utils/config-manager');
const { CallManager } = require('./utils/call-manager');
const { validateMqttCredentials } = require('./utils/mqtt_config_v2');
const { validatePublicIp, voiceSocketOptions } = require('./utils/service-policy');

// Fail before opening listeners; never silently advertise a public fallback.
const publicIp = validatePublicIp(process.env.PUBLIC_IP);

// Cache the libopus-wasm encoder used to generate silence frames
let opusEncoderPromise = null;
let opusEncoder = null;
let cachedSilenceFrame = null;  // Pre-encoded silence frame generated at startup

async function warmupOpusEncoder() {
    const encoder = await getOpusEncoder();
    // Pre-encode and cache a silence frame for reuse when sending
    const silentPCM = new Int16Array(960);
    const encoded = encoder.encode(silentPCM, { frameSize: 960 });
    cachedSilenceFrame = Buffer.from(encoded);
    console.log(`OPUS encoder warmed up, silence frame size: ${cachedSilenceFrame.length}`);
}

function getOpusEncoder() {
    if (opusEncoder) return Promise.resolve(opusEncoder);
    if (!opusEncoderPromise) {
        opusEncoderPromise = (async () => {
            const libopus = await import('libopus-wasm');
            opusEncoder = await libopus.createEncoder({
                channels: 1,
                sampleRate: 16000,
                frameSize: 960,  // 60ms at 16kHz = 960 samples
            });
            return opusEncoder;
        })();
    }
    return opusEncoderPromise;
}

function generateOpusSilenceFrame() {
    return cachedSilenceFrame;
}

function setDebugEnabled(enabled) {
    if (enabled) {
        debugModule.enable('mqtt-server');
    } else {
        debugModule.disable();
    }
}

const configManager = new ConfigManager('mqtt.json');
configManager.on('configChanged', (config) => {
    setDebugEnabled(config.debug);
});

setDebugEnabled(configManager.get('debug'));
// Initialize only after startup policy and routing configuration are valid.
warmupOpusEncoder().catch(() => console.error('OPUS encoder init failed'));

class WebSocketBridge extends Emitter {
    constructor(connection, protocolVersion, macAddress, uuid, userData) {
        super();
        this.connection = connection;
        this.macAddress = macAddress;
        this.uuid = uuid;
        this.userData = userData;
        this.wsClient = null;
        this.protocolVersion = protocolVersion;
        this.deviceSaidGoodbye = false;
        this.initializeChatServer();
    }

    initializeChatServer() {
        const devMacAddresss = configManager.get('development')?.mac_addresss || [];
        let chatServers;
        if (devMacAddresss.includes(this.macAddress)) {
            chatServers = configManager.get('development')?.chat_servers;
        } else {
            chatServers = configManager.get('production')?.chat_servers;
        }
        if (!Array.isArray(chatServers) || chatServers.length === 0) {
            throw new Error('GATEWAY_CONFIG_UNREADY');
        }
        this.chatServer = chatServers[Math.floor(Math.random() * chatServers.length)];
    }

    async connect(audio_params, features) {
        return new Promise((resolve, reject) => {
            // Generate the WebSocket authentication token
            let authorization = "test-token";
            const serverSecret = process.env.SERVER_SECRET;
            if (serverSecret) {
                const clientId = this.uuid || 'default-client-id';
                const username = this.macAddress;
                const timestamp = Math.floor(Date.now() / 1000);

                // Build the signed content: clientId|username|timestamp
                const content = `${clientId}|${username}|${timestamp}`;

                // Generate the HMAC-SHA256 signature
                const hmac = crypto.createHmac('sha256', serverSecret);
                hmac.update(content);
                const signature = hmac.digest();

                // Encode the signature as URL-safe Base64 without = padding
                const signatureBase64 = signature.toString('base64url');

                // Build the authentication token: signature.timestamp
                authorization = `${signatureBase64}.${timestamp}`;
            }

            const headers = {
                'device-id': this.macAddress,
                'protocol-version': '2',
                'authorization': `Bearer ${authorization}`
            };
            if (this.uuid) {
                headers['client-id'] = this.uuid;
            }
            if (this.userData && this.userData.ip) {
                headers['x-forwarded-for'] = this.userData.ip;
            }
            try {
                // Revalidate immediately before construction, including after reloads.
                this.wsClient = new WebSocket(this.chatServer, voiceSocketOptions(this.chatServer, headers));
            } catch {
                console.error('Voice WebSocket connection rejected');
                reject(new Error('VOICE_CONNECTION_REJECTED'));
                return;
            }

            this.wsClient.on('open', () => {
                this.sendJson({
                    type: 'hello',
                    version: 2,
                    transport: 'websocket',
                    audio_params,
                    features
                });
            });

            this.wsClient.on('message', (data, isBinary) => {
                if (isBinary) {
                    const timestamp = data.readUInt32BE(8);
                    const opusLength = data.readUInt32BE(12);
                    const opus = data.subarray(16, 16 + opusLength);
                    // Send binary data over UDP
                    this.connection.sendUdpMessage(opus, timestamp);
                } else {
                    // Send JSON data over MQTT
                    const message = JSON.parse(data.toString());
                    if (message.type === 'hello') {
                        resolve(message);
                    } else if (message.type === 'mcp' &&
                        this.connection.mcpCachedTools &&
                        ['notifications/initialized', 'tools/list'].includes(message.payload.method)) {
                        this.connection.onMcpMessageFromBridge(message);
                    } else {
                        this.connection.sendMqttMessage(JSON.stringify(message));
                    }
                }
            });

            this.wsClient.on('error', () => {
                console.error('Voice WebSocket connection failed');
                this.emit('close');
                reject(new Error('VOICE_CONNECTION_FAILED'));
            });

            this.wsClient.on('close', () => {
                this.emit('close');
            });
        });
    }

    sendJson(message) {
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            this.wsClient.send(JSON.stringify(message));
        }
    }

    sendAudio(opus, timestamp) {
        if (this.wsClient && this.wsClient.readyState === WebSocket.OPEN) {
            const buffer = Buffer.alloc(16 + opus.length);
            buffer.writeUInt32BE(timestamp, 8);
            buffer.writeUInt32BE(opus.length, 12);
            buffer.set(opus, 16);
            this.wsClient.send(buffer, { binary: true });
        } else {
            console.error(`WebSocket connection unavailable; cannot send audio data`);
        }
    }

    isAlive() {
        return this.wsClient && this.wsClient.readyState === WebSocket.OPEN;
    }

    close() {
        if (this.wsClient) {
            this.wsClient.close();
            this.wsClient = null;
        }
    }
}

const MacAddressRegex = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/;

/**
 * MQTT connection
 * Handle application-layer logic
 */
class MQTTConnection {
    constructor(socket, connectionId, server) {
        this.server = server;
        this.connectionId = connectionId;
        this.clientId = null;
        this.username = null;
        this.password = null;
        this.bridge = null;
        this.udp = {
            remoteAddress: null,
            cookie: null,
            localSequence: 0,
            remoteSequence: 0
        };
        this.headerBuffer = Buffer.alloc(16);
        this.mcpPendingRequests = {};

        // Read the actual client IP
        this.realClientIp = socket.remoteAddress;

        // Create the protocol handler with this socket
        this.protocol = new MQTTProtocol(socket, configManager);

        this.setupProtocolHandlers();
    }

    setupProtocolHandlers() {
        // Register protocol event handlers
        this.protocol.on('connect', (connectData) => {
            this.handleConnect(connectData);
        });

        this.protocol.on('publish', (publishData) => {
            this.handlePublish(publishData);
        });

        this.protocol.on('subscribe', (subscribeData) => {
            this.handleSubscribe(subscribeData);
        });

        this.protocol.on('disconnect', () => {
            this.handleDisconnect();
        });

        this.protocol.on('close', () => {
            debug(`${this.clientId} client disconnected`);
            this.server.removeConnection(this);
        });

        this.protocol.on('error', (err) => {
            debug(`${this.clientId} connection error:`, err);
            this.close();
        });

        this.protocol.on('protocolError', (err) => {
            debug(`${this.clientId} protocol error:`, err);
            this.close();
        });
    }

    handleConnect(connectData) {
        this.clientId = connectData.clientId;
        this.username = connectData.username;
        this.password = connectData.password;

        debug('Client connected:', {
            clientId: this.clientId,
            username: this.username,
            protocol: connectData.protocol,
            protocolLevel: connectData.protocolLevel,
            keepAlive: connectData.keepAlive
        });

        const parts = this.clientId.split('@@@');
        if (parts.length === 3) { // GID_test@@@mac_address@@@uuid
            const validated = validateMqttCredentials(this.clientId, this.username, this.password, this.realClientIp);
            this.groupId = validated.groupId;
            this.macAddress = validated.macAddress;
            this.uuid = validated.uuid;
            this.userData = validated.userData;
        } else if (parts.length === 2) { // GID_test@@@mac_address
            this.groupId = parts[0];
            this.macAddress = parts[1].replace(/_/g, ':');
            if (!MacAddressRegex.test(this.macAddress)) {
                debug('Invalid macAddress:', this.macAddress);
                this.close();
                return;
            }
        } else {
            debug('Invalid clientId:', this.clientId);
            this.close();
            return;
        }
        this.replyTo = `devices/p2p/${parts[1]}`;

        this.server.addConnection(this);
        this.initializeDeviceTools();
    }

    handleSubscribe(subscribeData) {
        debug('Client subscribed to topic:', {
            clientId: this.clientId,
            topic: subscribeData.topic,
            packetId: subscribeData.packetId
        });

        // Send SUBACK
        this.protocol.sendSuback(subscribeData.packetId, 0);
    }

    handleDisconnect() {
        debug('Received disconnect request:', { clientId: this.clientId });
        // Clean up the connection
        this.server.removeConnection(this);
    }

    close() {
        this.closing = true;
        // Clean up all pending MCP requests
        for (const request of Object.values(this.mcpPendingRequests)) {
            request.reject(new Error('Connection closed'));
        }
        this.mcpPendingRequests = {};

        // Clear the device's call state
        if (this.macAddress) {
            const peerConn = this.server.callManager.getPeerConnection(this.macAddress);
            // Get session_id before clearDevice, which deletes callSessionIds
            const peerSessionId = peerConn ? this.server.callManager.getCallSessionId(peerConn.macAddress) : null;
            this.server.callManager.clearDevice(this.macAddress);
            if (peerConn && peerSessionId) {
                peerConn.sendMqttMessage(JSON.stringify({ type: 'goodbye', session_id: peerSessionId, reason: '对方已离开' }));
            }
        }

        if (this.bridge) {
            this.bridge.close();
            this.bridge = null;
        }

        this.protocol.close();
    }

    checkKeepAlive() {
        const now = Date.now();
        const keepAliveInterval = this.protocol.getKeepAliveInterval();

        // A keepAliveInterval of 0 disables keep-alive checks
        if (keepAliveInterval === 0 || !this.protocol.isConnected) return;

        const lastActivity = this.protocol.getLastActivity();
        const timeSinceLastActivity = now - lastActivity;

        // Close the connection if the keep-alive interval has elapsed
        if (timeSinceLastActivity > keepAliveInterval) {
            debug('Keep-alive timed out; closing connection:', this.clientId);
            this.close();
        }
    }

    handlePublish(publishData) {
        debug('Received publish message:', {
            clientId: this.clientId,
            topic: publishData.topic,
            payload: publishData.payload,
            qos: publishData.qos
        });

        if (publishData.qos !== 0) {
            debug('Unsupported QoS level:', publishData.qos, 'Closing connection');
            this.close();
            return;
        }

        const json = JSON.parse(publishData.payload);
        if (json.type === 'hello') {
            if (json.version !== 3) {
                debug('Unsupported protocol version:', json.version, 'Closing connection');
                this.close();
                return;
            }
            this.parseHelloMessage(json).catch(error => {
                debug('Failed to handle hello message:', error);
                this.close();
            });
        } else {
            this.parseOtherMessage(json).catch(error => {
                debug('Failed to handle other message:', error);
                this.close();
            });
        }
    }

    sendMqttMessage(payload) {
        debug(`Sending message to ${this.replyTo}: ${payload}`);
        this.protocol.sendPublish(this.replyTo, payload, 0, false, false);
    }

    sendUdpMessage(payload, timestamp) {
        if (!this.udp.remoteAddress) {
            debug(`Device ${this.clientId} is not connected; cannot send UDP message`);
            return;
        }
        this.udp.localSequence++;
        const header = this.generateUdpHeader(payload.length, timestamp, this.udp.localSequence);
        const cipher = crypto.createCipheriv(this.udp.encryption, this.udp.key, header);
        const message = Buffer.concat([header, cipher.update(payload), cipher.final()]);
        this.server.sendUdpMessage(message, this.udp.remoteAddress);
    }

    generateUdpHeader(length, timestamp, sequence) {
        // Reuse the preallocated buffer
        this.headerBuffer.writeUInt8(1, 0);
        this.headerBuffer.writeUInt16BE(length, 2);
        this.headerBuffer.writeUInt32BE(this.connectionId, 4);
        this.headerBuffer.writeUInt32BE(timestamp, 8);
        this.headerBuffer.writeUInt32BE(sequence, 12);
        return Buffer.from(this.headerBuffer); // Return a copy to avoid concurrent access issues
    }

    async parseHelloMessage(json) {
        this.udp = {
            ...this.udp,
            key: crypto.randomBytes(16),
            nonce: this.generateUdpHeader(0, 0, 0),
            encryption: 'aes-128-ctr',
            remoteSequence: 0,
            localSequence: 0,
            startTime: Date.now()
        }

        if (this.bridge) {
            debug(`${this.clientId} received duplicate hello; closing the previous bridge`);
            this.bridge.close();
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.bridge = new WebSocketBridge(this, json.version, this.macAddress, this.uuid, this.userData);
        this.bridge.on('close', () => {
            const seconds = (Date.now() - this.udp.startTime) / 1000;
            console.log(`Call ended: ${this.clientId} Session: ${this.udp.session_id} Duration: ${seconds}s`);
            // Do not send goodbye while in a device call
            if (!this.server.callManager.isInCall(this.macAddress)) {
                this.sendMqttMessage(JSON.stringify({ type: 'goodbye', session_id: this.udp.session_id }));
            }
            this.bridge = null;
            if (this.closing) {
                this.protocol.close();
            }
        });

        try {
            console.log(`Call started: ${this.clientId} Protocol: ${json.version}`);

            // Clear previous call state when the device reconnects to the AI server
            // Get the call session_id before clearDevice, which deletes it
            const callSessionId = this.server.callManager.getCallSessionId(this.macAddress);
            const clearResult = this.server.callManager.clearDevice(this.macAddress);
            if (clearResult.peerMac) {
                const peerConn = this.server.getConnectionByMac(clearResult.peerMac);
                if (peerConn) {
                    const goodbyeSessionId = callSessionId || this.udp.session_id;
                    peerConn.sendMqttMessage(JSON.stringify({ type: 'goodbye', session_id: goodbyeSessionId }));
                    console.log(`Call state cleared; notified peer ${clearResult.peerMac} with goodbye, session=${goodbyeSessionId}`);
                }
            }

            const helloReply = await this.bridge.connect(json.audio_params, json.features);
            this.udp.session_id = helloReply.session_id;
            this.sendMqttMessage(JSON.stringify({
                type: 'hello',
                version: json.version,
                session_id: this.udp.session_id,
                transport: 'udp',
                udp: {
                    server: this.server.publicIp,
                    port: this.server.udpPort,
                    encryption: this.udp.encryption,
                    key: this.udp.key.toString('hex'),
                    nonce: this.udp.nonce.toString('hex'),
                },
                audio_params: helloReply.audio_params
            }));
        } catch (error) {
            this.sendMqttMessage(JSON.stringify({ type: 'error', message: '处理 hello 消息失败' }));
            console.error('Failed to handle hello message');
        }
    }

    async parseOtherMessage(json) {
        if (json.type === 'mcp') {
            const { id, error, result } = json.payload;
            const request = this.mcpPendingRequests[id];
            if (request) {
                delete this.mcpPendingRequests[id];
                if (error) {
                    request.reject(new Error(error.message));
                } else {
                    request.resolve(result);
                }
                return;
            }
        }

        if (!this.bridge) {
            if (json.type !== 'goodbye') {
                this.sendMqttMessage(JSON.stringify({ type: 'goodbye', session_id: json.session_id }));
            }
            return;
        }

        if (json.type === 'goodbye') {
            this.bridge.close();
            this.bridge = null;
            return;
        }

        if (json.type === 'udp_timeout') {
            console.log(`Device ${this.clientId} reported a UDP receive timeout; resetting the session`);
            this.bridge.close();
            this.bridge = null;
            return;
        }

        this.bridge.sendJson(json);
    }

    onUdpMessage(rinfo, message, payloadLength, timestamp, sequence) {
        // Check device-call bridging before checking the AI bridge
        if (this.server.callManager.isInCall(this.macAddress)) {
            const peerConn = this.server.callManager.getPeerConnection(this.macAddress);
            const header = message.slice(0, 16);
            const encryptedPayload = message.slice(16, 16 + payloadLength);

            try {
                // Decrypt the payload
                const decipher = crypto.createDecipheriv(this.udp.encryption, this.udp.key, header);
                const payload = Buffer.concat([decipher.update(encryptedPayload), decipher.final()]);

                // Forward to the peer, or echo to this device while the call is pending
                const targetConn = (peerConn && peerConn.udp?.key && peerConn.udp?.remoteAddress) ? peerConn : this;
                if (targetConn === this) {
                    // For a pending-call echo, send an OPUS silence frame
                    const silentPayload = generateOpusSilenceFrame();
                    if (silentPayload) {
                        this.sendUdpEncrypted(targetConn, silentPayload);
                    }
                } else {
                    this.sendUdpEncrypted(targetConn, payload);
                }
                return;
            } catch (e) {
                console.error(`Failed to process call: ${e.message}`);
            }
            return;
        }

        if (!this.bridge) {
            return;
        }
        if (this.udp.remoteAddress !== rinfo) {
            this.udp.remoteAddress = rinfo;
        }
        if (sequence < this.udp.remoteSequence) {
            return;
        }

        // Process encrypted data
        const header = message.slice(0, 16);
        const encryptedPayload = message.slice(16, 16 + payloadLength);

        try {
            const cipher = crypto.createDecipheriv(this.udp.encryption, this.udp.key, header);
            const payload = Buffer.concat([cipher.update(encryptedPayload), cipher.final()]);

            console.log(`Forwarding UDP audio from ${this.clientId} to WebSocket, length: ${payload.length}, timestamp: ${timestamp}, sequence: ${sequence}`);
            this.bridge.sendAudio(payload, timestamp);
            this.udp.remoteSequence = sequence;
        } catch (decryptionError) {
            console.error(`UDP decryption failed: ${decryptionError.message}`, {
                sequence: sequence,
                expectedSequence: this.udp.remoteSequence + 1,
                payloadLength: payloadLength,
                remoteAddress: rinfo.address,
                remotePort: rinfo.port
            });
            return;
        }
    }

    // Encrypt and send UDP: targetConn selects the peer, or this device when it is this
    sendUdpEncrypted(targetConn, payload) {
        const seq = ++targetConn.udp.localSequence;
        targetConn.headerBuffer.writeUInt8(1, 0);
        targetConn.headerBuffer.writeUInt8(0, 1);
        targetConn.headerBuffer.writeUInt16BE(payload.length, 2);
        targetConn.headerBuffer.writeUInt32BE(targetConn.connectionId, 4);
        targetConn.headerBuffer.writeUInt32BE(0, 8);
        targetConn.headerBuffer.writeUInt32BE(seq, 12);

        const cipher = crypto.createCipheriv(targetConn.udp.encryption, targetConn.udp.key, targetConn.headerBuffer);
        const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
        this.server.sendUdpMessage(Buffer.concat([targetConn.headerBuffer, encrypted]), targetConn.udp.remoteAddress);
    }

    isAlive() {
        return this.bridge && this.bridge.isAlive();
    }

    // Cache device tools to MQTTConnection
    async initializeDeviceTools() {
        this.mcpRequestId = 10000;
        this.mcpPendingRequests = {};
        this.mcpCachedTools = [];

        try {
            const mcpClient = configManager.get('mcp_client') || {};
            const capabilities = mcpClient.capabilities || {};
            const clientInfo = mcpClient.client_info || {
                name: 'xiaozhi-mqtt-client',
                version: '1.0.0'
            };
            this.mcpCachedInitialize = await this.sendMcpRequest('initialize', {
                protocolVersion: '2024-11-05',
                capabilities,
                clientInfo
            });
            this.sendMqttMessage(JSON.stringify({
                type: 'mcp',
                payload: { jsonrpc: '2.0', method: 'notifications/initialized' }
            }));

            // list tools
            let cursor = undefined;
            const maxToolsCount = configManager.get('mcp_client.max_tools_count') || 32;
            do {
                const { tools, nextCursor } = await this.sendMcpRequest('tools/list', { cursor });
                if (tools.length === 0 || (this.mcpCachedTools.length + tools.length) > maxToolsCount) {
                    break;
                }
                this.mcpCachedTools = this.mcpCachedTools.concat(tools);
                cursor = nextCursor;
            } while (cursor !== undefined);
            debug('Device tools initialized:', this.mcpCachedTools);
        } catch (error) {
            debug("Error initializing device tools", error);
        }
    }

    sendMcpRequest(method, params, timeout = 10000) {
        const id = this.mcpRequestId++;
        return new Promise((resolve, reject) => {
            // Set the timeout timer
            const timer = setTimeout(() => {
                if (this.mcpPendingRequests[id]) {
                    delete this.mcpPendingRequests[id];
                    reject(new Error('timeout'));
                }
            }, timeout);

            this.mcpPendingRequests[id] = {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                }
            };
            this.sendMqttMessage(JSON.stringify({
                type: 'mcp',
                payload: { jsonrpc: '2.0', method, id, params }
            }));
        });
    }

    onMcpMessageFromBridge(message) {
        const { method, id, params } = message.payload;
        if (method === 'initialize') {
            this.bridge.sendJson({
                type: 'mcp',
                payload: { jsonrpc: '2.0', id, result: this.mcpCachedInitialize }
            });
        } else if (method === 'tools/list') {
            this.bridge.sendJson({
                type: 'mcp',
                payload: { jsonrpc: '2.0', id, result: { tools: this.mcpCachedTools } }
            });
        } else if (method === 'notifications/initialized') {
            // do nothing
        }
    }
}

class MQTTServer {
    constructor() {
        this.mqttPort = parseInt(process.env.MQTT_PORT) || 1883;
        this.udpPort = parseInt(process.env.UDP_PORT) || this.mqttPort;
        this.publicIp = publicIp;
        this.connections = new Map(); // connectionId -> MQTTConnection
        this.clientIdMap = new Map(); // clientId -> MQTTConnection
        this.keepAliveTimer = null;
        this.keepAliveCheckInterval = 1000; // Check every 1 second by default

        this.headerBuffer = Buffer.alloc(16);

        // Initialize the call manager
        this.callManager = new CallManager();
        this.callManager.getConnectionByMac = (mac) => this.getConnectionByMac(mac);
    }

    generateNewConnectionId() {
        // Generate a unique 32-bit integer
        let id;
        do {
            id = Math.floor(Math.random() * 0xFFFFFFFF);
        } while (this.connections.has(id));
        return id;
    }

    start() {
        this.mqttServer = net.createServer((socket) => {
            const connectionId = this.generateNewConnectionId();
            debug(`New client connection: ${connectionId}`);
            new MQTTConnection(socket, connectionId, this);
        });

        this.mqttServer.listen(this.mqttPort, () => {
            console.warn(`MQTT server listening on port ${this.mqttPort}`);
        });


        this.udpServer = dgram.createSocket('udp4');
        this.udpServer.on('message', this.onUdpMessage.bind(this));
        this.udpServer.on('error', err => {
            console.error('UDP error', err);
            setTimeout(() => { process.exit(1); }, 1000);
        });
        this.udpServer.bind(this.udpPort, () => {
            console.warn(`UDP server listening on ${this.publicIp}:${this.udpPort}`);
        });

        // Start the global keep-alive check timer
        this.setupKeepAliveTimer();
    }

    /**
     * Set up the global keep-alive check timer
     */
    setupKeepAliveTimer() {
        // Clear the existing timer
        this.clearKeepAliveTimer();
        this.lastConnectionCount = 0;
        this.lastActiveConnectionCount = 0;

        // Set the new timer
        this.keepAliveTimer = setInterval(() => {
            // Check keep-alive status for all connections
            for (const connection of this.connections.values()) {
                connection.checkKeepAlive();
            }

            // Clean up expired pending calls
            const cleanedCalls = this.callManager.cleanupTimeoutCalls(60000);
            for (const { mac, peerMac } of cleanedCalls) {
                const conn = this.getConnectionByMac(mac);
                if (conn) {
                    conn.sendMqttMessage(JSON.stringify({ type: 'goodbye', session_id: conn.udp.session_id }));
                    console.log(`Sent timeout goodbye to ${mac}`);
                }
            }

            const activeCount = Array.from(this.connections.values()).filter(connection => connection.isAlive()).length;
            if (activeCount !== this.lastActiveConnectionCount || this.connections.size !== this.lastConnectionCount) {
                console.log(`Connections: ${this.connections.size}, active: ${activeCount}`);
                this.lastActiveConnectionCount = activeCount;
                this.lastConnectionCount = this.connections.size;
            }
        }, this.keepAliveCheckInterval);
    }

    /**
     * Clear the keep-alive check timer
     */
    clearKeepAliveTimer() {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    addConnection(connection) {
        // Check for an existing connection with the same clientId
        for (const [key, value] of this.connections.entries()) {
            if (value.clientId === connection.clientId) {
                debug(`${connection.clientId} already has a connection; closing the old one`);
                value.close();
            }
        }
        this.connections.set(connection.connectionId, connection);

        // Add the connection to the lookup map
        if (connection.clientId) {
            this.clientIdMap.set(connection.clientId, connection);
        }
    }

    removeConnection(connection) {
        debug(`Closing connection: ${connection.connectionId}`);

        // Clear the device's call state and notify its peer
        if (connection.macAddress) {
            const peerConn = this.callManager.getPeerConnection(connection.macAddress);
            // Get session_id before clearDevice, which deletes callSessionIds
            const peerSessionId = peerConn ? this.callManager.getCallSessionId(peerConn.macAddress) : null;
            this.callManager.clearDevice(connection.macAddress);
            // Notify the peer that the call ended, using the peer's session_id
            if (peerConn && peerSessionId) {
                peerConn.sendMqttMessage(JSON.stringify({ type: 'goodbye', session_id: peerSessionId }));
            }
        }

        if (this.connections.has(connection.connectionId)) {
            this.connections.delete(connection.connectionId);
        }

        if (connection.clientId && this.clientIdMap.has(connection.clientId)) {
            if (this.clientIdMap.get(connection.clientId).connectionId === connection.connectionId) {
                this.clientIdMap.delete(connection.clientId);
            }
        }
    }

    sendUdpMessage(message, remoteAddress) {
        this.udpServer.send(message, remoteAddress.port, remoteAddress.address);
    }

    onUdpMessage(message, rinfo) {
        // message format: [type: 1u, flag: 1u, payloadLength: 2u, cookie: 4u, timestamp: 4u, sequence: 4u, payload: n]
        if (message.length < 16) {
            console.warn('Received an incomplete UDP header', rinfo);
            return;
        }

        try {
            const type = message.readUInt8(0);
            if (type !== 1) return;

            const payloadLength = message.readUInt16BE(2);
            if (message.length < 16 + payloadLength) return;

            const connectionId = message.readUInt32BE(4);
            const connection = this.connections.get(connectionId);
            if (!connection) return;

            const timestamp = message.readUInt32BE(8);
            const sequence = message.readUInt32BE(12);

            connection.onUdpMessage(rinfo, message, payloadLength, timestamp, sequence);
        } catch (error) {
            console.error('Failed to process UDP message:', error);
        }
    }

    /**
     * Stop the server
     */
    async stop() {
        if (this.stopping) {
            return;
        }
        this.stopping = true;
        // Clear the keep-alive check timer
        this.clearKeepAliveTimer();

        if (this.connections.size > 0) {
            console.warn(`Waiting for ${this.connections.size} connections to close`);
            for (const connection of this.connections.values()) {
                connection.close();
            }
            await new Promise(resolve => setTimeout(resolve, 300));
            debug('Finished waiting for connections to close');
            this.connections.clear();
        }

        if (this.udpServer) {
            this.udpServer.close();
            this.udpServer = null;
            console.warn('UDP server stopped');
        }

        // Close the MQTT server
        if (this.mqttServer) {
            this.mqttServer.close();
            this.mqttServer = null;
            console.warn('MQTT server stopped');
        }

        process.exit(0);
    }

    // Find a connection by clientId
    getConnectionById(clientId) {
        if (this.clientIdMap.has(clientId)) {
            return this.clientIdMap.get(clientId);
        }
        for (const connection of this.connections.values()) {
            if (connection.clientId && connection.clientId == clientId) {
                console.log('connectionid', connection.connectionId);
                this.clientIdMap.set(connection.clientId, connection);
                return connection;
            }
        }
        return null;
    }

    // Find a connection by MAC address
    getConnectionByMac(mac) {
        const normalizedMac = mac?.toLowerCase();
        for (const connection of this.connections.values()) {
            if (connection.macAddress && connection.macAddress.toLowerCase() === normalizedMac) {
                return connection;
            }
        }
        return null;
    }

    // Find connections by groupId
    getConnectionsByGroupId(groupId) {
        const connections = [];
        for (const connection of this.connections.values()) {
            if (connection.groupId === groupId) {
                connections.push(connection);
            }
        }
        return connections;
    }
}

// Create and start the server
const server = new MQTTServer();
server.start();
process.on('SIGINT', () => {
    console.warn('Received SIGINT; shutting down');
    server.stop();
});

// Add the management API for device commands and responses
const express = require('express');
const app = express();
const adminPort = process.env.API_PORT || 8007;

app.use(express.json());

// Helper to calculate today's token
function calculateDailyToken() {
    try {
        // Get the current date in yyyy-MM-dd format
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const currentDate = `${year}-${month}-${day}`;

        // Read the signing key from the environment
        const signatureKey = process.env.MQTT_SIGNATURE_KEY;

        // Calculate the token
        const tokenString = currentDate + signatureKey;
        return crypto.createHash('sha256').update(tokenString).digest('hex');
    } catch (error) {
        console.error('Failed to calculate token:', error);
        throw error;
    }
}

// Middleware to validate the Authorization header
function authenticateRequest(req, res, next) {
    try {
        // Read the Authorization header
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: '未提供有效的Authorization头' });
        }

        // Extract the token
        const token = authHeader.split(' ')[1];

        // Calculate the expected token
        const expectedToken = calculateDailyToken();

        // Validate the token
        if (token !== expectedToken) {
            return res.status(401).json({ error: '无效的授权令牌' });
        }

        // Continue processing after successful validation
        next();
    } catch (error) {
        res.status(401).json({ error: '授权验证失败' });
    }
}

// Device command API: send MCP commands and return device responses
app.post('/api/commands/:clientId', authenticateRequest, async (req, res) => {
    try {
        const { clientId } = req.params;
        const command = req.body;
        const targetConnection = server.getConnectionById(clientId);
        if (!targetConnection) {
            return res.status(500).json({ success: false, error: '设备未连接' });
        }

        // Handle MCP commands
        if (command.type === 'mcp' && command.payload) {
            const { method, params } = command.payload;
            try {
                const result = await targetConnection.sendMcpRequest(method, params, 5000);
                res.json({
                    success: true,
                    data: result
                });
            } catch (error) {
                res.status(500).json({
                    success: false,
                    error: error.message
                });
            }
        } else {
            res.status(500).json({ success: false, error: '指令类型无效' });
        }
    } catch (error) {
        console.error('Failed to dispatch command:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// API to query whether specified devices are online
app.post('/api/devices/status', authenticateRequest, (req, res) => {
    try {
        const { clientIds } = req.body;

        // Validate parameters
        if (!clientIds || !Array.isArray(clientIds)) {
            return res.status(400).json({ error: 'clientIds必须是一个数组' });
        }

        // Build the device status map
        const deviceStatusMap = {};
        clientIds.forEach(clientId => {
            const connection = server.getConnectionById(clientId);
            deviceStatusMap[clientId] = {
                isAlive: connection ? connection.isAlive() : false,
                exists: !!connection
            };
        });

        res.json(deviceStatusMap);
    } catch (error) {
        console.error('Failed to query device status:', error);
        res.status(500).json({ error: error.message });
    }
});

// ========== Call management API ==========

// Request a call (invoked by the server)
app.post('/api/call/request', authenticateRequest, (req, res) => {
    try {
        const { caller_mac, target_mac, caller_nickname } = req.body;

        if (!caller_mac || !target_mac) {
            return res.status(400).json({ error: '缺少必要参数: caller_mac, target_mac' });
        }

        // Check whether the callee is online first
        const targetConn = server.getConnectionByMac(target_mac);
        if (!targetConn) {
            return res.json({
                status: 'offline',
                message: '对方设备不在线，请稍后重试'
            });
        }

        // Request a call only when the callee is online
        const result = server.callManager.requestCall(caller_mac, target_mac, caller_nickname);

        // After a successful call request, disconnect the AI bridge so the device enters call mode
        if (result.status === 'bridged' || result.status === 'pending') {
            const callerConn = server.getConnectionByMac(caller_mac);
            // Save session_id before disconnecting the bridge: entering call mode changes it
            const callerSessionId = callerConn?.udp?.session_id;
            if (callerConn?.bridge) {
                callerConn.bridge.close();
                callerConn.bridge = null;
                console.log(`Call request succeeded; disconnected the bridge for device ${caller_mac}`);
            }
            // Save the caller's session_id from bridge mode, before it enters call mode
            if (callerSessionId) {
                server.callManager.setCallSessionId(caller_mac, callerSessionId);
            }
        }

        // For mutual-call pairing, the callee has also entered call mode; save its session_id
        if (result.status === 'bridged' && result.peerMac) {
            const targetConn = server.getConnectionByMac(target_mac);
            if (targetConn?.udp?.session_id) {
                server.callManager.setCallSessionId(target_mac, targetConn.udp.session_id);
            }
        }

        if (result.status === 'pending') {
            // Wake the callee remotely
            const wakeupMessage = {
                type: 'mcp',
                payload: {
                    jsonrpc: '2.0',
                    id: 9999,
                    method: 'tools/call',
                    params: {
                        name: 'self.remote_wakeup',
                        arguments: {
                            reason: `[device_call]您收到来自${caller_nickname || '未知'}的来电，是否接听？`,
                            action: 'listen'
                        }
                    }
                }
            };
            targetConn.sendMqttMessage(JSON.stringify(wakeupMessage));
            console.log(`Sent remote wake-up to ${target_mac}: incoming call from ${caller_nickname}`);
        }

        res.json({
            status: result.status,
            message: result.message
        });
    } catch (error) {
        console.error('Failed to process call request:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Accept a call (invoked by the callee)
app.post('/api/call/accept', authenticateRequest, (req, res) => {
    try {
        const { mac } = req.body;

        if (!mac) {
            return res.status(400).json({ error: '缺少必要参数: mac' });
        }

        const result = server.callManager.joinCall(mac);

        if (result.status === 'bridged') {
            // Find the peer connection and notify it that the call is established
            const peerMac = result.peerMac;
            const peerConn = server.getConnectionByMac(peerMac);
            if (peerConn) {
                peerConn.sendMqttMessage(JSON.stringify({ type: 'call_accepted', from: mac }));
            }
            // Disconnect the AI bridge so the device enters call mode
            const calleeConn = server.getConnectionByMac(mac);
            // Save session_id before disconnecting the bridge: entering call mode changes it
            const calleeSessionId = calleeConn?.udp?.session_id;
            const peerSessionId = peerConn?.udp?.session_id;
            if (calleeConn?.bridge) {
                calleeConn.bridge.close();
                calleeConn.bridge = null;
                console.log(`Call accepted; disconnected the bridge for device ${mac}`);
            }
            console.log(`Call established: ${mac} <-> ${peerMac}`);

            // Save the session_id from bridge mode, before entering call mode
            if (calleeSessionId) {
                server.callManager.setCallSessionId(mac, calleeSessionId);
            }
            if (peerSessionId) {
                server.callManager.setCallSessionId(peerMac, peerSessionId);
            }
        }

        res.json(result);
    } catch (error) {
        console.error('Failed to process call acceptance:', error);
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Validate MQTT_SIGNATURE_KEY password complexity
function validateSignatureKeyComplexity() {
    const signatureKey = process.env.MQTT_SIGNATURE_KEY;

    if (!signatureKey) {
        console.error('Cannot start management API: MQTT_SIGNATURE_KEY environment variable is not set');
        return false;
    }

    // Check for a length of at least 8 characters
    if (signatureKey.length < 8) {
        console.error('Cannot start management API: MQTT_SIGNATURE_KEY must contain at least 8 characters');
        return false;
    }

    // Check for an uppercase letter
    if (!/[A-Z]/.test(signatureKey)) {
        console.error('Cannot start management API: MQTT_SIGNATURE_KEY must contain at least one uppercase letter');
        return false;
    }

    // Check for a lowercase letter
    if (!/[a-z]/.test(signatureKey)) {
        console.error('Cannot start management API: MQTT_SIGNATURE_KEY must contain at least one lowercase letter');
        return false;
    }

    // Check for disallowed substrings
    const forbiddenStrings = ['test', '1234', 'admin', 'password', 'qwerty', 'xiaozhi'];
    for (const forbidden of forbiddenStrings) {
        if (signatureKey.toLowerCase().includes(forbidden)) {
            console.error(`Cannot start management API: MQTT_SIGNATURE_KEY contains the weak-password substring '${forbidden}'; change it and restart this service`);
            return false;
        }
    }

    return true;
}

// Start the management API
if (validateSignatureKeyComplexity()) {
    app.listen(adminPort, () => {
        console.log(`Management API started on port ${adminPort}`);
    });
}
