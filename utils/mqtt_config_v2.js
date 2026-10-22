require('dotenv').config();
const crypto = require('crypto');


function generatePasswordSignature(content, secretKey) {
    // Create an HMAC object using SHA256 and the secretKey
    const hmac = crypto.createHmac('sha256', secretKey);
    
    // Update the HMAC object with the clientId
    hmac.update(content);
    
    // Generate the HMAC digest in binary format
    const binarySignature = hmac.digest();
    
    // Encode the binary signature to Base64
    const base64Signature = binarySignature.toString('base64');
    
    return base64Signature;
}

function validateMqttCredentials(clientId, username, password, realClientIp = null) {
    // Validate the password signature
    const signatureKey = process.env.MQTT_SIGNATURE_KEY;
    if (signatureKey) {
        const expectedSignature = generatePasswordSignature(clientId + '|' + username, signatureKey);
        if (password !== expectedSignature) {
            throw new Error('Password signature verification failed');
        }
    } else {
        console.warn('MQTT_SIGNATURE_KEY environment variable is missing; skipping password signature verification');
    }

    // Validate clientId
    if (!clientId || typeof clientId !== 'string') {
        throw new Error('clientId must be a non-empty string');
    }

    // Validate the clientId format (must contain @@@ separators)
    const clientIdParts = clientId.split('@@@');
    // New-version MQTT parameters
    if (clientIdParts.length !== 3) {
        throw new Error('Invalid clientId format; @@@ separators are required');
    }

    // Validate username
    if (!username || typeof username !== 'string') {
        throw new Error('username must be a non-empty string');
    }

    // Decode username, which should contain Base64-encoded JSON
    let userData;
    try {
        const decodedUsername = Buffer.from(username, 'base64').toString();
        userData = JSON.parse(decodedUsername);
    } catch (error) {
        throw new Error('username is not valid Base64-encoded JSON');
    }

    // Override the client-supplied IP with the actual IP when available
    if (realClientIp) {
        // Handle IPv4-mapped IPv6 addresses (::ffff:192.168.1.1 -> 192.168.1.1)
        const cleanIp = realClientIp.replace(/^::ffff:/, '');
        userData.ip = cleanIp;
    }

    // Parse the clientId fields
    const [groupId, macAddress, uuid] = clientIdParts;

    // Return parsed fields after successful validation
    return {
        groupId,
        macAddress: macAddress.replace(/_/g, ':'),
        uuid,
        userData
    };
}

function generateMqttConfig(groupId, macAddress, uuid, userData) {
    const endpoint = process.env.MQTT_ENDPOINT;
    const signatureKey = process.env.MQTT_SIGNATURE_KEY;
    if (!signatureKey) {
        console.warn('No signature key, skip generating MQTT config');
        return;
    }
    const deviceIdNoColon = macAddress.replace(/:/g, '_');
    const clientId = `${groupId}@@@${deviceIdNoColon}@@@${uuid}`;
    const username = Buffer.from(JSON.stringify(userData)).toString('base64');
    const password = generatePasswordSignature(clientId + '|' + username, signatureKey);
    return {
        endpoint,
        port: 8883,
        client_id: clientId,
        username,
        password,
        publish_topic: 'device-server',
        subscribe_topic: 'null' // Older firmware fails if this field is omitted
    }
}

module.exports = {
    generateMqttConfig,
    validateMqttCredentials
}

if (require.main === module) {
    const config = generateMqttConfig('GID_test', '11:22:33:44:55:66', '36c98363-3656-43cb-a00f-8bced2391a90', { ip: '222.222.222.222' });
    console.log('config', config);
    const credentials = validateMqttCredentials(config.client_id, config.username, config.password);
    console.log('credentials', credentials);
}
