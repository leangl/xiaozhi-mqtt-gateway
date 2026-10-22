const net = require('net');

// Source-controlled destinations. Do not broaden these through environment flags.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const INTERNAL_VOICE = 'ws://voice:8000/xiaozhi/v1/';
const MQTT_MARKER = '?from=mqtt_gateway';

function policyError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}

function validatePublicIp(value) {
    // PUBLIC_IP is an advertised host, not a URL, port, or credential container.
    if (typeof value !== 'string' || !value || value.length > 253 ||
        /[\s\x00-\x1f\x7f/@?#\\]/.test(value)) {
        throw policyError('PUBLIC_IP_REQUIRED_VALID_HOST');
    }
    if (net.isIP(value)) return value;
    if (value.includes(':') || !value.split('.').every(label =>
        /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) {
        throw policyError('PUBLIC_IP_REQUIRED_VALID_HOST');
    }
    return value;
}

function validateVoiceUrl(value) {
    // Match the original spelling before URL parsing can normalize aliases,
    // numeric IP shortcuts, escapes, userinfo, or dot segments.
    if (typeof value !== 'string' || /[\s\x00-\x1f\x7f\\#]/.test(value)) {
        throw policyError('VOICE_URL_POLICY_REJECTED');
    }
    // Existing voice servers use this exact, non-sensitive protocol marker to
    // distinguish 16-byte gateway envelopes from direct WebSocket Opus. No
    // arbitrary query, token, URL override or new recipient is permitted.
    let destination = value;
    if (value.includes('?')) {
        if (!value.endsWith(MQTT_MARKER) || value.indexOf('?') !== value.length - MQTT_MARKER.length ||
            !value.slice(0, -MQTT_MARKER.length).endsWith('/xiaozhi/v1/')) {
            throw policyError('VOICE_URL_POLICY_REJECTED');
        }
        destination = value.slice(0, -MQTT_MARKER.length);
    }
    if (destination === INTERNAL_VOICE) return value;
    const match = /^(ws|wss):\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?(\/[^?#]*)?$/.exec(destination);
    if (!match || !LOOPBACK_HOSTS.has(match[2]) ||
        (match[3] && Number(match[3]) > 65535)) {
        throw policyError('VOICE_URL_POLICY_REJECTED');
    }
    // Confirm that the URL parser and literal policy agree.
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw policyError('VOICE_URL_POLICY_REJECTED');
    }
    if (parsed.hostname !== match[2] || parsed.username || parsed.password ||
        (parsed.search && parsed.search !== MQTT_MARKER) || parsed.hash) {
        throw policyError('VOICE_URL_POLICY_REJECTED');
    }
    return value;
}

function validateServerPools(config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw policyError('VOICE_SERVER_POOLS_INVALID');
    }
    for (const name of ['production', 'development']) {
        const pool = config[name];
        if (name === 'development' && pool === undefined) continue;
        if (!pool || !Array.isArray(pool.chat_servers) || pool.chat_servers.length === 0 ||
            (pool.mac_addresss !== undefined &&
                (!Array.isArray(pool.mac_addresss) || pool.mac_addresss.some(mac => typeof mac !== 'string')))) {
            throw policyError('VOICE_SERVER_POOLS_INVALID');
        }
        for (const url of pool.chat_servers) validateVoiceUrl(url);
    }
    return config;
}

function voiceSocketOptions(value, headers) {
    validateVoiceUrl(value);
    return {
        headers,
        followRedirects: false,
        // A fresh direct agent, not a process-global/proxy agent.
        agent: false,
        // localhost must remain loopback even with an altered resolver/hosts file.
        ...(new URL(value).hostname === 'localhost' ? {
            lookup: (_hostname, options, callback) => {
                if (typeof options === 'function') callback = options;
                if (options && options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
                else callback(null, '127.0.0.1', 4);
            }
        } : {})
    };
}

module.exports = { validatePublicIp, validateVoiceUrl, validateServerPools, voiceSocketOptions };
