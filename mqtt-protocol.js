const debug = require('debug')('mqtt-server');
const EventEmitter = require('events');

// MQTT fixed-header packet types
const PacketType = {
    CONNECT: 1,
    CONNACK: 2,
    PUBLISH: 3,
    SUBSCRIBE: 8,
    SUBACK: 9,
    PINGREQ: 12,
    PINGRESP: 13,
    DISCONNECT: 14    // Include DISCONNECT
};

/**
 * MQTT protocol handler
 * Parse and encode MQTT packets and maintain keep-alive state
 */
class MQTTProtocol extends EventEmitter {
    constructor(socket, configManager) {
        super();
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        this.isConnected = false;
        this.keepAliveInterval = 0;
        this.lastActivity = Date.now();
        this.configManager = configManager;
        
        this.setupSocketHandlers();
    }

    /**
     * Register socket event handlers
     */
    setupSocketHandlers() {
        this.socket.on('data', (data) => {
            this.lastActivity = Date.now();
            this.buffer = Buffer.concat([this.buffer, data]);
            this.processBuffer();
        });

        this.socket.on('close', () => {
            this.emit('close');
        });

        this.socket.on('error', (err) => {
            this.emit('error', err);
        });
    }

    /**
     * Process all complete messages in the buffer
     */
    processBuffer() {
        const maxPayloadSize = this.configManager.get('max_mqtt_payload_size') || 8192;
        // Process buffered data until no complete messages remain
        while (this.buffer.length > 0) {
            // Parsing needs at least 2 bytes: 1 fixed-header byte and at least 1 Remaining Length byte
            if (this.buffer.length < 2) return;

            try {
                // Read the message type
                const firstByte = this.buffer[0];
                const type = (firstByte >> 4);
                
                // Decode Remaining Length
                const { value: remainingLength, bytesRead } = this.decodeRemainingLength(this.buffer);
                
                // Calculate the full message length
                const messageLength = 1 + bytesRead + remainingLength;
                if (messageLength > maxPayloadSize) {
                    debug('Message length exceeds the maximum:', messageLength);
                    this.emit('protocolError', new Error(`Message length exceeds the maximum: ${messageLength}`));
                    return;
                }
                
                // Check whether the buffer holds a complete message
                if (this.buffer.length < messageLength) {
                    // Wait for more data when the message is incomplete
                    return;
                }
                
                // Extract the complete message
                const message = this.buffer.subarray(0, messageLength);
                if (!this.isConnected && type !== PacketType.CONNECT) {
                    debug('Received a non-CONNECT message before connection; closing connection');
                    this.socket.end();
                    return;
                }
                
                // Dispatch by message type
                switch (type) {
                    case PacketType.CONNECT:
                        this.parseConnect(message);
                        break;
                    case PacketType.PUBLISH:
                        this.parsePublish(message);
                        break;
                    case PacketType.SUBSCRIBE:
                        this.parseSubscribe(message);
                        break;
                    case PacketType.PINGREQ:
                        this.parsePingReq(message);
                        break;
                    case PacketType.DISCONNECT:
                        this.parseDisconnect(message);
                        break;
                    default:
                        debug('Unhandled packet type:', type, message);
                        this.emit('protocolError', new Error(`Unhandled packet type: ${type}`));
                }
                
                // Remove the processed message from the buffer
                this.buffer = this.buffer.subarray(messageLength);
                
            } catch (err) {
                // A decoding error may mean incomplete data; wait for more
                if (err.message === 'Malformed Remaining Length') {
                    return;
                }
                // For other potential protocol errors, clear the buffer and emit an error
                this.buffer = Buffer.alloc(0);
                this.emit('protocolError', err);
                return;
            }
        }
    }

    /**
     * Decode the MQTT Remaining Length field
     * @param {Buffer} buffer - Message buffer
     * @returns {{value: number, bytesRead: number}} Decoded value and number of bytes read
     */
    decodeRemainingLength(buffer) {
        let multiplier = 1;
        let value = 0;
        let bytesRead = 0;
        let digit;

        do {
            if (bytesRead >= 4 || bytesRead >= buffer.length - 1) {
                throw new Error('Malformed Remaining Length');
            }
            
            digit = buffer[bytesRead + 1];
            bytesRead++;
            
            value += (digit & 127) * multiplier;
            multiplier *= 128;
            
        } while ((digit & 128) !== 0);

        return { value, bytesRead };
    }

    /**
     * Encode the MQTT Remaining Length field
     * @param {number} length - Length to encode
     * @returns {{bytes: Buffer, bytesLength: number}} Encoded bytes and byte count
     */
    encodeRemainingLength(length) {
        let digit;
        const bytes = Buffer.alloc(4); // At most 4 bytes
        let bytesLength = 0;
        
        do {
            digit = length % 128;
            length = Math.floor(length / 128);
            // Set the high bit if more bytes follow
            if (length > 0) {
                digit |= 0x80;
            }
            bytes[bytesLength++] = digit;
        } while (length > 0 && bytesLength < 4);
        
        return { bytes, bytesLength };
    }

    /**
     * Parse a CONNECT message
     * @param {Buffer} message - Complete CONNECT message
     */
    parseConnect(message) {
        // Decode Remaining Length
        const { value: remainingLength, bytesRead } = this.decodeRemainingLength(message);
        
        // Position after the fixed header (first MQTT header byte plus Remaining Length bytes)
        const headerLength = 1 + bytesRead;
        
        // Read the protocol name length at the start of the variable header
        const protocolLength = message.readUInt16BE(headerLength);
        const protocol = message.toString('utf8', headerLength + 2, headerLength + 2 + protocolLength);
        
        // Advance past the protocol name
        let pos = headerLength + 2 + protocolLength;
        
        // Protocol level; 4 means MQTT 3.1.1
        const protocolLevel = message[pos];
        
        // Check the protocol version
        if (protocolLevel !== 3 && protocolLevel !== 4) {  // 3 means MQTT 3.0; 4 means MQTT 3.1.1
            debug('Unsupported protocol version:', protocolLevel);
            // Send CONNACK with the unsupported-protocol-version return code (0x01)
            this.sendConnack(1, false);
            // Close the connection
            this.socket.end();
            return;
        }
        
        pos += 1;
        
        // Connection flags
        const connectFlags = message[pos];
        const hasUsername = (connectFlags & 0x80) !== 0;
        const hasPassword = (connectFlags & 0x40) !== 0;
        const cleanSession = (connectFlags & 0x02) !== 0;
        pos += 1;
        
        // Keep-alive duration
        const keepAlive = message.readUInt16BE(pos);
        pos += 2;
        
        // Parse clientId
        const clientIdLength = message.readUInt16BE(pos);
        pos += 2;
        const clientId = message.toString('utf8', pos, pos + clientIdLength);
        pos += clientIdLength;

        // Parse username if present
        let username = '';
        if (hasUsername) {
            const usernameLength = message.readUInt16BE(pos);
            pos += 2;
            username = message.toString('utf8', pos, pos + usernameLength);
            pos += usernameLength;
        }

        // Parse password if present
        let password = '';
        if (hasPassword) {
            const passwordLength = message.readUInt16BE(pos);
            pos += 2;
            password = message.toString('utf8', pos, pos + passwordLength);
            pos += passwordLength;
        }

        // Set the interval to 1.5 times the client's keepAlive value, converting seconds to milliseconds
        this.keepAliveInterval = keepAlive * 1000 * 1.5;
        
        // Send CONNACK
        this.sendConnack(0, false);
        
        // Mark the connection as connected
        this.isConnected = true;
        
        // Emit the connect event
        this.emit('connect', {
            clientId,
            protocol,
            protocolLevel,
            keepAlive,
            username,
            password,
            cleanSession
        });
    }

    /**
     * Parse a PUBLISH message
     * @param {Buffer} message - Complete PUBLISH message
     */
    parsePublish(message) {
        // Extract the QoS level from bits 1-2 of the first byte
        const firstByte = message[0];
        const qos = (firstByte & 0x06) >> 1;  // 0x06 is binary 00000110; mask the QoS bits
        const dup = (firstByte & 0x08) !== 0;  // 0x08 is binary 00001000; mask the DUP flag
        const retain = (firstByte & 0x01) !== 0;  // 0x01 is binary 00000001; mask the RETAIN flag
        
        // Use the shared Remaining Length decoder
        const { value: remainingLength, bytesRead } = this.decodeRemainingLength(message);
        
        // Position after the fixed header (first MQTT header byte plus Remaining Length bytes)
        const headerLength = 1 + bytesRead;
        
        // Parse the topic
        const topicLength = message.readUInt16BE(headerLength);
        const topic = message.toString('utf8', headerLength + 2, headerLength + 2 + topicLength);
        
        // QoS > 0 includes a packet ID
        let packetId = null;
        let payloadStart = headerLength + 2 + topicLength;
        
        if (qos > 0) {
            packetId = message.readUInt16BE(payloadStart);
            payloadStart += 2;
        }
        
        // Parse the payload
        const payload = message.slice(payloadStart).toString('utf8');
        
        // Emit the publish event
        this.emit('publish', {
            topic,
            payload,
            qos,
            dup,
            retain,
            packetId
        });
    }

    /**
     * Parse a SUBSCRIBE message
     * @param {Buffer} message - Complete SUBSCRIBE message
     */
    parseSubscribe(message) {
        const packetId = message.readUInt16BE(2);
        const topicLength = message.readUInt16BE(4);
        const topic = message.toString('utf8', 6, 6 + topicLength);
        const qos = message[6 + topicLength]; // QoS value
        
        // Emit the subscribe event
        this.emit('subscribe', {
            packetId,
            topic,
            qos
        });
    }

    /**
     * Parse a PINGREQ message
     * @param {Buffer} message - Complete PINGREQ message
     */
    parsePingReq(message) {
        debug('Received keep-alive request');
        
        // Send PINGRESP
        this.sendPingResp();
        
        debug('Sent keep-alive response');
    }

    /**
     * Parse a DISCONNECT message
     * @param {Buffer} message - Complete DISCONNECT message
     */
    parseDisconnect(message) {
        // Mark the connection as disconnected
        this.isConnected = false;
        
        // Emit the disconnect event
        this.emit('disconnect');
        
        // Close the socket
        this.socket.end();
    }

    /**
     * Send a CONNACK message
     * @param {number} returnCode - Return code
     * @param {boolean} sessionPresent - Session-present flag
     */
    sendConnack(returnCode = 0, sessionPresent = false) {
        if (!this.socket.writable) return;
        
        const packet = Buffer.from([
            PacketType.CONNACK << 4,
            2,  // Remaining length
            sessionPresent ? 1 : 0,  // Connect acknowledge flags
            returnCode  // Return code
        ]);
        
        this.socket.write(packet);
    }

    /**
     * Send a PUBLISH message
     * @param {string} topic - Topic
     * @param {string} payload - Payload
     * @param {number} qos - QoS level
     * @param {boolean} dup - Duplicate flag
     * @param {boolean} retain - Retain flag
     * @param {number} packetId - Packet ID (needed only for QoS > 0)
     */
    sendPublish(topic, payload, qos = 0, dup = false, retain = false, packetId = null) {
        if (!this.isConnected || !this.socket.writable) return;
        
        const topicLength = Buffer.byteLength(topic);
        const payloadLength = Buffer.byteLength(payload);
        
        // Calculate Remaining Length
        let remainingLength = 2 + topicLength + payloadLength;
        
        // Include a packet ID for QoS > 0
        if (qos > 0 && packetId) {
            remainingLength += 2;
        }
        
        // Encode the variable-length field
        const { bytes: remainingLengthBytes, bytesLength: remainingLengthSize } = this.encodeRemainingLength(remainingLength);
        
        // Allocate the buffer: fixed header (1 byte) + variable-length field + remaining bytes
        const packet = Buffer.alloc(1 + remainingLengthSize + remainingLength);
        
        // Write the fixed header
        let firstByte = PacketType.PUBLISH << 4;
        if (dup) firstByte |= 0x08;
        if (qos > 0) firstByte |= (qos << 1);
        if (retain) firstByte |= 0x01;
        
        packet[0] = firstByte;
        
        // Write the variable-length field
        remainingLengthBytes.copy(packet, 1, 0, remainingLengthSize);
        
        // Write the topic length and topic
        const variableHeaderStart = 1 + remainingLengthSize;
        packet.writeUInt16BE(topicLength, variableHeaderStart);
        packet.write(topic, variableHeaderStart + 2);
        
        // Write the packet ID for QoS > 0
        let payloadStart = variableHeaderStart + 2 + topicLength;
        if (qos > 0 && packetId) {
            packet.writeUInt16BE(packetId, payloadStart);
            payloadStart += 2;
        }
        
        // Write the payload
        packet.write(payload, payloadStart);
        
        this.socket.write(packet);
        this.lastActivity = Date.now();
    }

    /**
     * Send a SUBACK message
     * @param {number} packetId - Packet ID
     * @param {number} returnCode - Return code
     */
    sendSuback(packetId, returnCode = 0) {
        if (!this.isConnected || !this.socket.writable) return;
        
        const packet = Buffer.from([
            PacketType.SUBACK << 4,
            3,                  // Remaining length
            packetId >> 8,     // Packet ID MSB
            packetId & 0xFF,   // Packet ID LSB
            returnCode         // Return code
        ]);
        
        this.socket.write(packet);
        this.lastActivity = Date.now();
    }

    /**
     * Send a PINGRESP message
     */
    sendPingResp() {
        if (!this.isConnected || !this.socket.writable) return;
        
        const packet = Buffer.from([
            PacketType.PINGRESP << 4,  // Fixed header
            0                          // Remaining length
        ]);
        
        this.socket.write(packet);
        this.lastActivity = Date.now();
    }

    /**
     * Get the last activity time
     */
    getLastActivity() {
        return this.lastActivity;
    }

    /**
     * Get the keep-alive interval
     */
    getKeepAliveInterval() {
        return this.keepAliveInterval;
    }

    /**
     * Clear the buffer
     */
    clearBuffer() {
        this.buffer = Buffer.alloc(0);
    }

    /**
     * Close the connection
     */
    close() {
        if (this.socket) {
            this.socket.destroy();
        }
    }
}

// Export PacketType and MQTTProtocol
module.exports = {
    PacketType,
    MQTTProtocol
};
